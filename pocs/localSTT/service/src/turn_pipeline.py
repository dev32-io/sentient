"""Per-connection Silero VAD → Smart-Turn → SenseVoice chaining.

See README for the state machine. Turn-finalization (WAV + STT + emit)
lives in ``turn_finalizer.py``.
"""

from __future__ import annotations

import time
from collections import deque
from pathlib import Path

import numpy as np
import torch
from silero_vad import VADIterator, load_silero_vad

from .event_logger import JsonlLogger
from .pause_tracker import PauseTracker
from .pipeline_events import (
    PipelineEvent,
    SmartTurnEval,
    TurnContinuing,
    VadEnd,
    VadStart,
)
from .sense_voice import SenseVoice
from .smart_turn import SmartTurn, SmartTurnResult
from .turn_finalizer import finalize_turn

# ---------------------------------------------------------------------------
# Silero + pipeline constants
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16_000
SILERO_CHUNK_SAMPLES = 512
SILERO_CHUNK_BYTES = SILERO_CHUNK_SAMPLES * 2

VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 200
VAD_SPEECH_PAD_MS = 30

# Silero's reported `end` lags the actual silence start by this much.
_VAD_DETECTION_LAG_NS = VAD_MIN_SILENCE_MS * 1_000_000

# Ring-buffer of pre-speech audio chunks. When Silero fires `start`, the
# contents are retroactively prepended to the new speech segment so the
# first phoneme of the utterance isn't clipped by VAD detection latency.
# 10 chunks × 512 samples @ 16 kHz ≈ 320 ms of context.
PRE_SPEECH_CHUNKS = 10

# Safety-net force-finalize timeout: if Smart-Turn says `turn_continuing`
# and no new speech arrives within this window, force the turn closed.
# Prevents indefinite hang when Smart-Turn mistakenly holds a turn open.
SILENT_TIMEOUT_MS = 2000
_SILENT_TIMEOUT_NS = SILENT_TIMEOUT_MS * 1_000_000

_SILERO_MODEL: torch.nn.Module | None = None


def get_silero_model() -> torch.nn.Module:
    """Load + cache the Silero VAD JIT (PyTorch) model."""
    global _SILERO_MODEL
    if _SILERO_MODEL is None:
        torch.set_num_threads(1)
        _SILERO_MODEL = load_silero_vad(onnx=False)
    return _SILERO_MODEL


class TurnPipeline:
    """State machine for a single WebSocket connection."""

    def __init__(
        self,
        connection_id: str,
        *,
        smart_turn: SmartTurn,
        sense_voice: SenseVoice,
        recording_dir: Path,
        logger: JsonlLogger,
    ) -> None:
        self._conn_id = connection_id
        self._smart_turn = smart_turn
        self._sense_voice = sense_voice
        self._recording_dir = recording_dir
        self._logger = logger

        self._vad_iter = VADIterator(
            get_silero_model(),
            threshold=VAD_THRESHOLD,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=VAD_MIN_SILENCE_MS,
            speech_pad_ms=VAD_SPEECH_PAD_MS,
        )

        self._rechunk_buf = bytearray()
        self._turn_active = False
        self._turn_audio: list[np.ndarray] = []
        self._speech_segments: list[np.ndarray] = []
        self._current_segment_chunks: list[np.ndarray] = []
        self._turn_idx = 0
        self._turn_start_ns = 0
        self._in_speech = False
        self._pauses = PauseTracker(detection_lag_ns=_VAD_DETECTION_LAG_NS)
        self._pre_speech_buffer: deque[np.ndarray] = deque(maxlen=PRE_SPEECH_CHUNKS)
        self._continuing_since_ns: int | None = None

        recording_dir.mkdir(parents=True, exist_ok=True)

    def process(self, pcm16_bytes: bytes) -> list[PipelineEvent]:
        events: list[PipelineEvent] = []
        self._rechunk_buf.extend(pcm16_bytes)
        while len(self._rechunk_buf) >= SILERO_CHUNK_BYTES:
            chunk_bytes = bytes(self._rechunk_buf[:SILERO_CHUNK_BYTES])
            del self._rechunk_buf[:SILERO_CHUNK_BYTES]
            self._process_chunk(chunk_bytes, events)
        return events

    def close(self) -> None:
        self._rechunk_buf.clear()
        self._vad_iter.reset_states()

    def _process_chunk(self, chunk_bytes: bytes, events: list[PipelineEvent]) -> None:
        chunk_f32 = (
            np.frombuffer(chunk_bytes, dtype="<i2").astype(np.float32) / 32768.0
        )

        # Accumulate the triggering chunk BEFORE VAD eval so chunks that
        # fire `end` still land in the tail of both buffers.
        if self._turn_active:
            self._turn_audio.append(chunk_f32)
        if self._in_speech:
            self._current_segment_chunks.append(chunk_f32)
        else:
            # Ring-buffer pre-speech context for the next VAD `start`.
            self._pre_speech_buffer.append(chunk_f32)

        # Silent-timeout safety net: force finalize if Smart-Turn is
        # stuck in `continuing` state past the timeout.
        if self._continuing_since_ns is not None:
            if (time.monotonic_ns() - self._continuing_since_ns) >= _SILENT_TIMEOUT_NS:
                self._force_finalize(events)
                return

        vad_event = self._vad_iter(torch.from_numpy(chunk_f32))
        if vad_event is None:
            return

        if "start" in vad_event:
            self._on_vad_start(events)
        elif "end" in vad_event:
            self._on_vad_end(events)

    def _on_vad_start(self, events: list[PipelineEvent]) -> None:
        t = time.monotonic_ns()
        # Capture the pre-speech ring buffer as retroactive pre-roll
        # context for the new speech segment.
        pre_roll = list(self._pre_speech_buffer)
        self._pre_speech_buffer.clear()
        self._continuing_since_ns = None

        if not self._turn_active:
            self._turn_active = True
            self._turn_idx += 1
            self._turn_start_ns = t
            self._turn_audio = list(pre_roll)
            self._speech_segments = []
            self._pauses.reset()
        else:
            pause_ms = self._pauses.on_vad_start(t)
            if pause_ms is not None:
                self._logger.log("pause.detected", turn_idx=self._turn_idx, duration_ms=pause_ms)

        self._current_segment_chunks = list(pre_roll)
        self._in_speech = True
        events.append(VadStart(t_mono_ns=t, turn_idx=self._turn_idx))
        self._logger.log("vad.start", turn_idx=self._turn_idx, pre_roll_chunks=len(pre_roll))

    def _on_vad_end(self, events: list[PipelineEvent]) -> None:
        if not self._turn_active:
            return

        vad_end_ns = time.monotonic_ns()
        self._in_speech = False
        self._pauses.on_vad_end(vad_end_ns)
        if self._current_segment_chunks:
            self._speech_segments.append(np.concatenate(self._current_segment_chunks))
            self._current_segment_chunks = []
        events.append(VadEnd(t_mono_ns=vad_end_ns, turn_idx=self._turn_idx))
        self._logger.log("vad.end", turn_idx=self._turn_idx)

        audio_f32 = (
            np.concatenate(self._turn_audio) if self._turn_audio else np.zeros(0, dtype=np.float32)
        )
        result = self._smart_turn.predict(audio_f32)
        st_done_ns = time.monotonic_ns()

        events.append(SmartTurnEval(
            t_mono_ns=st_done_ns,
            turn_idx=self._turn_idx,
            probability=result.probability,
            prediction=result.prediction,
            eval_ms=result.eval_ms,
            audio_seconds=result.audio_seconds,
        ))
        self._logger.log(
            "smart_turn.eval",
            turn_idx=self._turn_idx,
            probability=round(result.probability, 4),
            prediction=result.prediction,
            eval_ms=round(result.eval_ms, 3),
            audio_seconds=round(result.audio_seconds, 3),
            vad_end_to_smart_turn_ms=round((st_done_ns - vad_end_ns) / 1e6, 3),
        )

        if result.prediction == 1:
            self._finalize_turn(audio_f32, result, vad_end_ns, events)
            return

        events.append(TurnContinuing(
            t_mono_ns=st_done_ns,
            turn_idx=self._turn_idx,
            probability=result.probability,
            eval_ms=result.eval_ms,
        ))
        self._logger.log(
            "turn.continuing",
            turn_idx=self._turn_idx,
            probability=round(result.probability, 4),
            eval_ms=round(result.eval_ms, 3),
        )
        # Arm the silent-timeout watchdog.
        self._continuing_since_ns = time.monotonic_ns()

    def _finalize_turn(
        self, audio_f32: np.ndarray, smart_turn_result,
        vad_end_ns: int, events: list[PipelineEvent],
    ) -> None:
        finalize_turn(
            audio_f32, smart_turn_result, vad_end_ns, events,
            turn_idx=self._turn_idx,
            conn_id=self._conn_id,
            recording_dir=self._recording_dir,
            logger=self._logger,
            sense_voice=self._sense_voice,
            speech_segments=self._speech_segments,
            pauses=self._pauses,
        )
        self._reset_turn_state()

    def _force_finalize(self, events: list[PipelineEvent]) -> None:
        """Safety-net: close the turn with a synthetic Smart-Turn result."""
        self._logger.log(
            "turn.force_finalize",
            turn_idx=self._turn_idx,
            reason="silent_timeout",
            silent_timeout_ms=SILENT_TIMEOUT_MS,
        )
        synthetic = SmartTurnResult(
            prediction=1, probability=0.0, eval_ms=0.0, audio_seconds=0.0,
        )
        audio_f32 = (
            np.concatenate(self._turn_audio) if self._turn_audio else np.zeros(0, dtype=np.float32)
        )
        self._finalize_turn(audio_f32, synthetic, time.monotonic_ns(), events)

    def _reset_turn_state(self) -> None:
        """Clear per-turn state AND Silero's LSTM state.

        Resetting Silero between turns prevents hidden-state drift over
        long sessions. We have clean turn boundaries (Smart-Turn just
        said we're done), so there's no downside to starting the next
        turn with a fresh LSTM. The pre-speech ring buffer compensates
        for the ~1-2 chunk cold-start detection delay.
        """
        self._turn_active = False
        self._turn_audio = []
        self._speech_segments = []
        self._current_segment_chunks = []
        self._in_speech = False
        self._pauses.reset()
        self._pre_speech_buffer.clear()
        self._continuing_since_ns = None
        self._vad_iter.reset_states()
