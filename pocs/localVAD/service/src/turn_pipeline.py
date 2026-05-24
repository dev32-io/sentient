"""Per-connection Silero VAD → Smart-Turn chaining.

State machine:

1. Client streams PCM16 LE mono @ 16 kHz in arbitrary-sized binary frames.
2. We rechunk to exactly 512-sample windows (Silero's hard requirement at
   16 kHz) using a rolling byte buffer.
3. Each window is fed through Silero's ``VADIterator``. Silero is stateful;
   we keep one iterator per connection.
4. A *turn* begins on the first ``{'start'}`` event. While the turn is
   active we accumulate **every** 512-sample chunk — including the silence
   between multiple utterances — so the saved WAV is continuous and natural
   to listen back to.
5. On each ``{'end'}`` event (i.e. Silero's min-silence timer fired) we run
   Smart-Turn v3 on the turn-so-far:

   - Probability > 0.5 → the user is done. Finalize, persist the WAV,
     emit ``TurnComplete``, reset the turn buffer.
   - Probability ≤ 0.5 → the user paused but isn't done. Emit
     ``TurnContinuing`` and KEEP the turn buffer. Audio keeps accumulating
     through the silence; the next ``{'end'}`` event re-evaluates.

All events are returned from ``process()`` as a list so the WebSocket
handler can translate them to wire messages at its own pace.
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import torch
from silero_vad import VADIterator, load_silero_vad

from .event_logger import JsonlLogger
from .pipeline_events import (
    PipelineEvent,
    SmartTurnEval,
    TurnComplete,
    TurnContinuing,
    VadEnd,
    VadStart,
)
from .smart_turn import SmartTurn
from .wav_codec import f32_to_pcm16_bytes, pcm16_to_wav_bytes

# ---------------------------------------------------------------------------
# Silero contract
# ---------------------------------------------------------------------------

SAMPLE_RATE = 16_000
# Silero v5+ requires exactly 512 samples per call at 16 kHz. Anything else
# raises.
SILERO_CHUNK_SAMPLES = 512
SILERO_CHUNK_BYTES = SILERO_CHUNK_SAMPLES * 2  # int16 LE

# Tunables — keep in sync with the README's "how to tune" section.
VAD_THRESHOLD = 0.5
VAD_MIN_SILENCE_MS = 200  # Silence this long triggers a Smart-Turn evaluation.
VAD_SPEECH_PAD_MS = 30  # Pre-/post-roll around detected speech segments.


# ---------------------------------------------------------------------------
# Silero model loader (shared across connections)
# ---------------------------------------------------------------------------

_SILERO_MODEL: torch.nn.Module | None = None


def get_silero_model() -> torch.nn.Module:
    """Load and cache the Silero VAD JIT (PyTorch) model.

    We use the "real Python" path — ``onnx=False`` — per the PoC spec. The
    model itself is stateless; all streaming state lives inside the
    per-connection ``VADIterator`` wrapper.
    """
    global _SILERO_MODEL
    if _SILERO_MODEL is None:
        # VAD is lightweight; one thread avoids fighting onnxruntime for
        # cores during Smart-Turn inference.
        torch.set_num_threads(1)
        _SILERO_MODEL = load_silero_vad(onnx=False)
    return _SILERO_MODEL


# ---------------------------------------------------------------------------
# Per-connection pipeline
# ---------------------------------------------------------------------------


class TurnPipeline:
    """State machine for a single WebSocket connection."""

    def __init__(
        self,
        connection_id: str,
        *,
        smart_turn: SmartTurn,
        recording_dir: Path,
        logger: JsonlLogger,
    ) -> None:
        self._conn_id = connection_id
        self._smart_turn = smart_turn
        self._recording_dir = recording_dir
        self._logger = logger

        self._vad_iter = VADIterator(
            get_silero_model(),
            threshold=VAD_THRESHOLD,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=VAD_MIN_SILENCE_MS,
            speech_pad_ms=VAD_SPEECH_PAD_MS,
        )

        # Rolling byte buffer for rechunking arbitrary client frame sizes
        # into exactly 1024-byte (512-sample) Silero windows.
        self._rechunk_buf = bytearray()

        # Turn-level state. ``_turn_active`` spans the full turn, INCLUDING
        # silent pauses that Smart-Turn deemed "not yet done".
        self._turn_active = False
        self._turn_audio: list[np.ndarray] = []
        self._turn_idx = 0
        self._turn_start_ns = 0

        # VAD-level state (start/end bracket within a turn). Used only for
        # emitted events and logs.
        self._in_speech = False

        recording_dir.mkdir(parents=True, exist_ok=True)

    # -- public --------------------------------------------------------------

    def process(self, pcm16_bytes: bytes) -> list[PipelineEvent]:
        """Feed arbitrary-length PCM16 LE bytes through the pipeline."""
        events: list[PipelineEvent] = []
        self._rechunk_buf.extend(pcm16_bytes)

        while len(self._rechunk_buf) >= SILERO_CHUNK_BYTES:
            chunk_bytes = bytes(self._rechunk_buf[:SILERO_CHUNK_BYTES])
            del self._rechunk_buf[:SILERO_CHUNK_BYTES]
            self._process_chunk(chunk_bytes, events)

        return events

    def close(self) -> None:
        """Flush the rolling buffer and reset VAD state on disconnect."""
        # Intentionally discards any sub-chunk tail — < 32 ms of audio.
        self._rechunk_buf.clear()
        self._vad_iter.reset_states()

    # -- internal ------------------------------------------------------------

    def _process_chunk(self, chunk_bytes: bytes, events: list[PipelineEvent]) -> None:
        chunk_f32 = (
            np.frombuffer(chunk_bytes, dtype="<i2").astype(np.float32) / 32768.0
        )

        # Accumulate BEFORE evaluating VAD so that a chunk which triggers
        # 'end' is still captured (we want the tail of the utterance).
        if self._turn_active:
            self._turn_audio.append(chunk_f32)

        vad_event = self._vad_iter(torch.from_numpy(chunk_f32))
        if vad_event is None:
            return

        if "start" in vad_event:
            self._on_vad_start(chunk_f32, events)
        elif "end" in vad_event:
            self._on_vad_end(events)

    def _on_vad_start(self, chunk_f32: np.ndarray, events: list[PipelineEvent]) -> None:
        t = time.monotonic_ns()
        if not self._turn_active:
            # New turn. Retroactively include THIS chunk as the first
            # sample — we hadn't appended it at the top of _process_chunk
            # because _turn_active was False.
            self._turn_active = True
            self._turn_idx += 1
            self._turn_start_ns = t
            self._turn_audio = [chunk_f32]

        self._in_speech = True
        events.append(VadStart(t_mono_ns=t, turn_idx=self._turn_idx))
        self._logger.log("vad.start", turn_idx=self._turn_idx)

    def _on_vad_end(self, events: list[PipelineEvent]) -> None:
        if not self._turn_active:
            return  # spurious end without a start — ignore

        vad_end_ns = time.monotonic_ns()
        self._in_speech = False
        events.append(VadEnd(t_mono_ns=vad_end_ns, turn_idx=self._turn_idx))
        self._logger.log("vad.end", turn_idx=self._turn_idx)

        # Smart-Turn input = the full accumulated turn audio. The classifier
        # internally truncates to its last 8 seconds.
        if self._turn_audio:
            audio_f32 = np.concatenate(self._turn_audio)
        else:
            audio_f32 = np.zeros(0, dtype=np.float32)
        result = self._smart_turn.predict(audio_f32)
        st_done_ns = time.monotonic_ns()

        events.append(
            SmartTurnEval(
                t_mono_ns=st_done_ns,
                turn_idx=self._turn_idx,
                probability=result.probability,
                prediction=result.prediction,
                eval_ms=result.eval_ms,
                audio_seconds=result.audio_seconds,
            )
        )
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
            self._finalize_turn(
                audio_f32,
                result.probability,
                result.eval_ms,
                vad_end_ns,
                events,
            )
            return

        events.append(
            TurnContinuing(
                t_mono_ns=st_done_ns,
                turn_idx=self._turn_idx,
                probability=result.probability,
                eval_ms=result.eval_ms,
            )
        )
        self._logger.log(
            "turn.continuing",
            turn_idx=self._turn_idx,
            probability=round(result.probability, 4),
            eval_ms=round(result.eval_ms, 3),
        )
        # Keep _turn_active=True and keep _turn_audio intact. Silence
        # frames keep appending until the next VAD start/end pair causes
        # another Smart-Turn eval.

    def _finalize_turn(
        self,
        audio_f32: np.ndarray,
        smart_turn_prob: float,
        smart_turn_eval_ms: float,
        vad_end_ns: int,
        events: list[PipelineEvent],
    ) -> None:
        pcm16_bytes = f32_to_pcm16_bytes(audio_f32)
        wav_bytes = pcm16_to_wav_bytes(pcm16_bytes, SAMPLE_RATE)

        wav_path = self._recording_dir / f"turn_{self._conn_id}_{self._turn_idx:03d}.wav"
        wav_path.write_bytes(wav_bytes)

        duration_ms = (audio_f32.size / SAMPLE_RATE) * 1000.0
        complete_ns = time.monotonic_ns()

        events.append(
            TurnComplete(
                t_mono_ns=complete_ns,
                turn_idx=self._turn_idx,
                wav_bytes=wav_bytes,
                duration_ms=duration_ms,
                smart_turn_probability=smart_turn_prob,
                smart_turn_eval_ms=smart_turn_eval_ms,
                wav_path=wav_path,
            )
        )
        self._logger.log(
            "turn.complete",
            turn_idx=self._turn_idx,
            duration_ms=round(duration_ms, 2),
            smart_turn_probability=round(smart_turn_prob, 4),
            smart_turn_eval_ms=round(smart_turn_eval_ms, 3),
            wav_path=str(wav_path),
            wav_bytes_len=len(wav_bytes),
            vad_end_to_turn_complete_ms=round((complete_ns - vad_end_ns) / 1e6, 3),
        )

        # Reset turn state; the next VAD 'start' begins a new turn.
        self._turn_active = False
        self._turn_audio = []
