"""Per-connection Silero VAD -> Smart-Turn -> SenseVoice chaining.

This is the core state machine of the STT service. Each WebSocket
connection gets its own ``TurnPipeline`` instance. The pipeline's job:

1. Accept raw PCM16 audio bytes from the network.
2. Rechunk them into 512-sample windows that Silero needs.
3. Feed each window to Silero VAD: is this speech or silence?
4. When speech ends, feed the accumulated audio to Smart-Turn: is the
   user done talking, or just pausing mid-sentence?
5. When Smart-Turn says "done", hand off to ``turn_finalizer.py`` which
   runs SenseVoice STT and emits the transcript.

The state machine is intentionally synchronous (no ``async``). Audio
processing is CPU-bound (numpy math, torch inference, ONNX inference),
not I/O-bound, so async would add overhead without any benefit. The
WebSocket server calls ``pipeline.process(bytes)`` synchronously and
gets back a list of events to send.

Python note — ``global`` and lazy initialization:
  The ``_SILERO_MODEL`` global uses a "load on first call" pattern via
  ``get_silero_model()``. This is important because module-level code
  runs at import time (when Python first encounters ``import
  turn_pipeline``). If we loaded the model at module level, importing
  the file would block for 2-3 seconds and consume 100+ MB of RAM.
  Lazy init defers that cost to the first actual use. In Kotlin you'd
  use ``lazy { ... }`` — same concept, different syntax.

Python note — ``deque(maxlen=N)``:
  A ``deque`` (double-ended queue) with a ``maxlen`` is a fixed-size
  ring buffer. Once full, appending a new item automatically drops the
  oldest one from the other end. We use this for the pre-speech buffer
  — the last N chunks of audio before VAD fires "start". In Kotlin
  you'd implement this with ``ArrayDeque`` + manual eviction.
"""

from __future__ import annotations

import time
from collections import deque
from pathlib import Path

import numpy as np
import torch
from silero_vad import VADIterator, load_silero_vad

from .config import Config
from .event_logger import JsonlLogger
from .pause_tracker import PauseTracker
from .pipeline_events import (
    PipelineEvent,
    SmartTurnEval,
    TurnContinuing,
    VadEnd,
    VadStart,
)
from .whisper_mlx import WhisperMlx
from .smart_turn import SmartTurn, SmartTurnResult
from .turn_finalizer import finalize_turn

# Protocol constant — fixed by the audio format contract. NOT a tunable.
SAMPLE_RATE = 16_000
SILERO_CHUNK_SAMPLES = 512
SILERO_CHUNK_BYTES = SILERO_CHUNK_SAMPLES * 2  # 2 bytes per int16 sample

# ---------------------------------------------------------------------------
# Shared Silero model — loaded once, used by all connections.
# ---------------------------------------------------------------------------

_SILERO_MODEL: torch.nn.Module | None = None


def get_silero_model() -> torch.nn.Module:
    """Load + cache the Silero VAD JIT (PyTorch) model.

    ``global`` tells Python "when I write ``_SILERO_MODEL = ...`` inside
    this function, I mean the module-level variable, not a new local".
    Without it, the assignment would create a local variable that
    disappears when the function returns. There's no Kotlin equivalent
    because Kotlin uses class-level ``companion object`` for shared state.
    """
    global _SILERO_MODEL
    if _SILERO_MODEL is None:
        # Limit torch to 1 thread — Silero's per-chunk inference is
        # fast enough (~0.3 ms) that thread overhead would hurt more
        # than parallelism would help.
        torch.set_num_threads(1)
        _SILERO_MODEL = load_silero_vad(onnx=False)
    return _SILERO_MODEL


class TurnPipeline:
    """State machine for a single WebSocket connection.

    Public interface is exactly two methods:
    - ``process(pcm16_bytes)`` — feed audio, get events back.
    - ``close()`` — clean up when the connection ends.
    """

    def __init__(
        self,
        connection_id: str,
        *,
        config: Config,
        smart_turn: SmartTurn,
        stt: WhisperMlx,
        recording_dir: Path,
        logger: JsonlLogger,
    ) -> None:
        self._conn_id = connection_id
        self._config = config
        self._smart_turn = smart_turn
        self._stt = stt
        self._recording_dir = recording_dir
        self._logger = logger

        # Derived from config — pre-computed once at construction time
        # so we don't do nanosecond math on every chunk.
        self._vad_detection_lag_ns = config.vad.min_silence_ms * 1_000_000
        self._silent_timeout_ns = config.vad.silent_timeout_ms * 1_000_000
        self._max_turn_duration_ns = config.vad.max_turn_duration_ms * 1_000_000

        self._vad_iter = VADIterator(
            get_silero_model(),
            threshold=config.vad.threshold,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=config.vad.min_silence_ms,
            speech_pad_ms=config.vad.speech_pad_ms,
        )

        # ``bytearray`` is a mutable byte buffer — like a resizable
        # ``ByteArray`` in Kotlin. We accumulate incoming network bytes
        # here and slice off 512-sample chunks as they become available.
        self._rechunk_buf = bytearray()

        # Per-turn mutable state. Reset between turns.
        self._turn_active = False
        self._turn_audio: list[np.ndarray] = []
        self._speech_segments: list[np.ndarray] = []
        self._current_segment_chunks: list[np.ndarray] = []
        self._turn_idx = 0
        self._turn_start_ns = 0
        self._in_speech = False
        self._pauses = PauseTracker(
            detection_lag_ns=self._vad_detection_lag_ns,
        )
        self._pre_speech_buffer: deque[np.ndarray] = deque(
            maxlen=config.vad.pre_speech_chunks,
        )
        self._continuing_since_ns: int | None = None

        recording_dir.mkdir(parents=True, exist_ok=True)

    def process(self, pcm16_bytes: bytes) -> list[PipelineEvent]:
        """Feed raw PCM16 audio bytes and return any events produced.

        The caller (``server.py``) sends audio in whatever chunk size
        the WebSocket client chose. This method rechunks internally
        to the 512-sample windows Silero needs.
        """
        events: list[PipelineEvent] = []
        self._rechunk_buf.extend(pcm16_bytes)
        while len(self._rechunk_buf) >= SILERO_CHUNK_BYTES:
            chunk_bytes = bytes(self._rechunk_buf[:SILERO_CHUNK_BYTES])
            del self._rechunk_buf[:SILERO_CHUNK_BYTES]
            self._process_chunk(chunk_bytes, events)
        return events

    def close(self) -> None:
        """Release per-connection state. Called when the WebSocket closes."""
        self._rechunk_buf.clear()
        self._vad_iter.reset_states()

    # -- internal chunk processing -------------------------------------------

    def _process_chunk(
        self, chunk_bytes: bytes, events: list[PipelineEvent],
    ) -> None:
        """Process one 512-sample Silero chunk."""
        # Convert raw bytes to float32 in [-1, 1]. This is the format
        # both Silero (torch) and Smart-Turn/SenseVoice (numpy) expect.
        #
        # ``<i2`` means "little-endian signed 16-bit integer" — the
        # PCM16 LE format from the contract. Dividing by 32768.0
        # normalizes to [-1.0, 1.0].
        chunk_f32 = (
            np.frombuffer(chunk_bytes, dtype="<i2").astype(np.float32) / 32768.0
        )

        # Accumulate BEFORE VAD eval so chunks that trigger ``end``
        # still land in both buffers.
        if self._turn_active:
            self._turn_audio.append(chunk_f32)
        if self._in_speech:
            self._current_segment_chunks.append(chunk_f32)
        else:
            self._pre_speech_buffer.append(chunk_f32)

        # Duration-based watchdogs. Both force-finalize the turn with a
        # synthetic "done" Smart-Turn result and emit the normal
        # turn_complete / transcript_ready pair so the client sees a
        # well-formed turn end.
        if self._turn_active:
            now_ns = time.monotonic_ns()
            # Hard cap — guards against runaway audio buffer growth when
            # speech-like input keeps arriving with no gap long enough
            # for the silent_timeout watchdog to trip (e.g. background TV).
            if (now_ns - self._turn_start_ns) >= self._max_turn_duration_ns:
                self._force_finalize(events, reason="max_turn_duration")
                return
            # Soft cap — Smart-Turn said "continuing" after a vad_end but
            # nobody spoke again within silent_timeout_ms.
            if self._continuing_since_ns is not None:
                if (now_ns - self._continuing_since_ns) >= self._silent_timeout_ns:
                    self._force_finalize(events, reason="silent_timeout")
                    return

        # Feed the chunk to Silero. Returns ``None`` most of the time;
        # returns ``{'start': ...}`` or ``{'end': ...}`` on transitions.
        vad_event = self._vad_iter(torch.from_numpy(chunk_f32))
        if vad_event is None:
            return

        if "start" in vad_event:
            self._on_vad_start(events)
        elif "end" in vad_event:
            self._on_vad_end(events)

    def _on_vad_start(self, events: list[PipelineEvent]) -> None:
        """Handle Silero firing speech-start."""
        t = time.monotonic_ns()
        pre_roll = list(self._pre_speech_buffer)
        self._pre_speech_buffer.clear()
        self._continuing_since_ns = None

        if not self._turn_active:
            # Brand new turn — initialize all per-turn state.
            self._turn_active = True
            self._turn_idx += 1
            self._turn_start_ns = t
            self._turn_audio = list(pre_roll)
            self._speech_segments = []
            self._pauses.reset()
        else:
            # Resuming after a mid-turn pause. Record the pause duration.
            pause_ms = self._pauses.on_vad_start(t)
            if pause_ms is not None:
                self._logger.log(
                    "pause.detected",
                    turn_idx=self._turn_idx,
                    duration_ms=pause_ms,
                )

        self._current_segment_chunks = list(pre_roll)
        self._in_speech = True
        events.append(VadStart(t_mono_ns=t, turn_idx=self._turn_idx))
        self._logger.log(
            "vad.start",
            turn_idx=self._turn_idx,
            pre_roll_chunks=len(pre_roll),
        )

    def _on_vad_end(self, events: list[PipelineEvent]) -> None:
        """Handle Silero firing speech-end: run Smart-Turn to decide."""
        if not self._turn_active:
            return

        vad_end_ns = time.monotonic_ns()
        self._in_speech = False
        self._pauses.on_vad_end(vad_end_ns)
        if self._current_segment_chunks:
            self._speech_segments.append(
                np.concatenate(self._current_segment_chunks),
            )
            self._current_segment_chunks = []
        events.append(VadEnd(t_mono_ns=vad_end_ns, turn_idx=self._turn_idx))
        self._logger.log("vad.end", turn_idx=self._turn_idx)

        # Run Smart-Turn: "is the user done, or just pausing?"
        audio_f32 = (
            np.concatenate(self._turn_audio)
            if self._turn_audio
            else np.zeros(0, dtype=np.float32)
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
            vad_end_to_smart_turn_ms=round(
                (st_done_ns - vad_end_ns) / 1e6, 3,
            ),
        )

        if result.prediction == 1:
            # Turn is done — hand off to finalizer for STT + emit.
            self._finalize_turn(audio_f32, result, vad_end_ns, events)
            return

        # Turn continues — Smart-Turn says user is just pausing.
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

    # -- turn lifecycle ------------------------------------------------------

    def _finalize_turn(
        self,
        audio_f32: np.ndarray,
        smart_turn_result: SmartTurnResult,
        vad_end_ns: int,
        events: list[PipelineEvent],
    ) -> None:
        """Hand off to the turn finalizer (STT + content gate + emit)."""
        finalize_turn(
            audio_f32,
            smart_turn_result,
            vad_end_ns,
            events,
            turn_idx=self._turn_idx,
            conn_id=self._conn_id,
            recording_dir=self._recording_dir,
            recordings_config=self._config.recordings,
            logger=self._logger,
            stt=self._stt,
            speech_segments=self._speech_segments,
            pauses=self._pauses,
            min_speech_duration_ms=self._config.vad.min_speech_duration_ms,
        )
        self._reset_turn_state()

    def _force_finalize(
        self, events: list[PipelineEvent], *, reason: str,
    ) -> None:
        """Safety-net: close the turn with a synthetic Smart-Turn result.

        ``reason`` distinguishes why the pipeline gave up waiting for
        Smart-Turn to fire naturally. Two values today:
          - ``silent_timeout`` — stuck in "continuing" past
            ``vad.silent_timeout_ms`` with no new speech.
          - ``max_turn_duration`` — turn exceeded ``vad.max_turn_duration_ms``
            regardless of speech state.

        When the max-duration cap fires mid-speech we emit a synthetic
        ``VadEnd`` and fold the open speech segment into ``speech_segments``
        before calling the finalizer. This keeps the CONTRACT.md §5.4
        ordering guarantee (``vad_start`` is always matched by a
        ``vad_end``) intact and lets SenseVoice's segment decoder see the
        in-flight speech as part of the output transcript.
        """
        now_ns = time.monotonic_ns()

        if self._in_speech:
            if self._current_segment_chunks:
                self._speech_segments.append(
                    np.concatenate(self._current_segment_chunks),
                )
                self._current_segment_chunks = []
            self._in_speech = False
            self._pauses.on_vad_end(now_ns)
            events.append(VadEnd(t_mono_ns=now_ns, turn_idx=self._turn_idx))
            self._logger.log(
                "vad.end",
                turn_idx=self._turn_idx,
                synthetic=True,
                reason=reason,
            )

        log_fields: dict[str, object] = {
            "turn_idx": self._turn_idx,
            "reason": reason,
        }
        if reason == "silent_timeout":
            log_fields["silent_timeout_ms"] = self._config.vad.silent_timeout_ms
        elif reason == "max_turn_duration":
            log_fields["max_turn_duration_ms"] = (
                self._config.vad.max_turn_duration_ms
            )
        self._logger.log("turn.force_finalize", **log_fields)

        synthetic = SmartTurnResult(
            prediction=1,
            probability=0.0,
            eval_ms=0.0,
            audio_seconds=0.0,
        )
        audio_f32 = (
            np.concatenate(self._turn_audio)
            if self._turn_audio
            else np.zeros(0, dtype=np.float32)
        )
        self._finalize_turn(audio_f32, synthetic, now_ns, events)

    def _reset_turn_state(self) -> None:
        """Clear per-turn state AND Silero's LSTM hidden state.

        Resetting Silero between turns prevents hidden-state drift over
        long sessions. We have clean turn boundaries (Smart-Turn just
        said we're done), so there's no downside. The pre-speech ring
        buffer compensates for the 1-2 chunk cold-start detection delay.
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
