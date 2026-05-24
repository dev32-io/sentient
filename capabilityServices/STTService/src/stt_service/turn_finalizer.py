"""Turn finalization: STT decode, content gating, and event emission.

Extracted from ``turn_pipeline.py`` so the pipeline state machine stays
focused on VAD + Smart-Turn coordination. This module has no pipeline
state of its own — the caller threads through everything via kwargs.

**Order of operations**: run SenseVoice FIRST, then decide whether the
turn has actual content, and only then write the WAV / emit
``TurnComplete`` + ``TranscriptReady``. Turns whose SenseVoice
transcript is content-free (a knock on the desk, a mouse click, a thud
that fooled Silero) are dropped — we emit a single ``TurnRejected``
event instead, no WAV is persisted, and the client never sees the turn.

Python note — ``unicodedata.category()``:
  The ``_has_content`` function below uses Python's Unicode database to
  check if a string contains any "real" character (letter or digit) in
  ANY script — Chinese, English, Japanese, Arabic, etc. This is much
  more robust than checking for ASCII alphanumerics. In Kotlin you'd
  use ``Character.isLetterOrDigit()``, which does the same Unicode-
  aware check under the hood.
"""

from __future__ import annotations

import re
import time
import unicodedata
from pathlib import Path

import numpy as np

from .config import RecordingsConfig
from .event_logger import JsonlLogger
from .pause_tracker import PauseTracker
from .pipeline_events import (
    PipelineEvent,
    TranscriptReady,
    TurnComplete,
    TurnRejected,
)
from .segment_decoder import decode_segments_and_stitch
from .sense_voice import SenseVoice
from .wav_codec import f32_to_pcm16_bytes, pcm16_to_wav_bytes

SAMPLE_RATE = 16_000

# Regex that matches SenseVoice tag tokens like ``<|NEUTRAL|>`` or
# ``<|Speech|>``. Used to strip them from body text.
_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _has_content(text: str) -> bool:
    """True if text contains any letter or digit in any script.

    Works across zh/en/yue/ja/ko because it uses Unicode categories
    rather than ASCII-specific rules.
    """
    if not text:
        return False
    cleaned = _TAG_RE.sub("", text)
    for ch in cleaned:
        cat = unicodedata.category(ch)
        if cat.startswith("L") or cat.startswith("N"):
            return True
    return False


def _is_meaningful_event(audio_event: str) -> bool:
    """True if the audio event tag is anything other than plain speech.

    Laughter / BGM / applause / etc. turns are kept even when the text
    content is empty, because the non-speech classification itself is
    useful signal for the downstream LLM.
    """
    if not audio_event:
        return False
    code = _TAG_RE.sub("", audio_event).strip().lower()
    return bool(code) and code != "speech"


def finalize_turn(
    audio_f32: np.ndarray,
    smart_turn_result,
    vad_end_ns: int,
    events: list[PipelineEvent],
    *,
    turn_idx: int,
    conn_id: str,
    recording_dir: Path,
    recordings_config: RecordingsConfig,
    logger: JsonlLogger,
    sense_voice: SenseVoice,
    speech_segments: list[np.ndarray],
    pauses: PauseTracker,
    min_speech_duration_ms: int,
) -> None:
    """Decode, gate on content, then either emit or reject.

    This is the "exit path" of the turn pipeline state machine. Every
    completed turn ends up here. The function is intentionally long-ish
    (~60 lines) because the logic is strictly sequential and splitting
    it further would scatter the turn's lifecycle across too many files.
    """
    # --- Step 0: Duration gate — skip SenseVoice on short bursts ---
    duration_ms = (audio_f32.size / SAMPLE_RATE) * 1000.0
    if min_speech_duration_ms > 0 and duration_ms < min_speech_duration_ms:
        rejected_ns = time.monotonic_ns()
        events.append(
            TurnRejected(
                t_mono_ns=rejected_ns,
                turn_idx=turn_idx,
                reason="short_burst",
                text="",
                audio_event="",
                decode_ms=0.0,
                audio_seconds=duration_ms / 1000.0,
            )
        )
        logger.log(
            "turn.rejected",
            turn_idx=turn_idx,
            reason="short_burst",
            duration_ms=round(duration_ms, 3),
            min_speech_duration_ms=min_speech_duration_ms,
            segment_count=len(speech_segments),
            vad_end_to_rejected_ms=round((rejected_ns - vad_end_ns) / 1e6, 3),
        )
        return

    # --- Step 1: STT decode (we need text before we can gate) ---
    pauses_ms = pauses.durations_ms()
    stitched = decode_segments_and_stitch(
        sense_voice,
        speech_segments,
        pause_count=len(pauses_ms),
        logger=logger,
        turn_idx=turn_idx,
    )
    transcript_ns = time.monotonic_ns()

    # --- Step 2: Content gate — drop noise-only turns ---
    if not _has_content(stitched.text) and not _is_meaningful_event(stitched.event):
        events.append(
            TurnRejected(
                t_mono_ns=transcript_ns,
                turn_idx=turn_idx,
                reason="empty_transcript",
                text=stitched.text,
                audio_event=stitched.event,
                decode_ms=stitched.total_decode_ms,
                audio_seconds=stitched.total_audio_seconds,
            )
        )
        logger.log(
            "turn.rejected",
            turn_idx=turn_idx,
            reason="empty_transcript",
            text=stitched.text,
            audio_event=stitched.event,
            decode_ms=round(stitched.total_decode_ms, 3),
            audio_seconds=round(stitched.total_audio_seconds, 3),
            segment_count=len(stitched.segments),
            vad_end_to_rejected_ms=round((transcript_ns - vad_end_ns) / 1e6, 3),
        )
        return

    # --- Step 3: Real turn — encode WAV and emit events ---
    pcm16_bytes = f32_to_pcm16_bytes(audio_f32)
    wav_bytes = pcm16_to_wav_bytes(pcm16_bytes, SAMPLE_RATE)

    # Persist to disk only if recordings are enabled in config.
    wav_path = recording_dir / f"turn_{conn_id}_{turn_idx:03d}.wav"
    if recordings_config.enabled:
        wav_path.write_bytes(wav_bytes)

    complete_ns = time.monotonic_ns()

    events.append(
        TurnComplete(
            t_mono_ns=complete_ns,
            turn_idx=turn_idx,
            wav_bytes=wav_bytes,
            duration_ms=duration_ms,
            smart_turn_probability=smart_turn_result.probability,
            smart_turn_eval_ms=smart_turn_result.eval_ms,
            wav_path=wav_path,
        )
    )
    logger.log(
        "turn.complete",
        turn_idx=turn_idx,
        duration_ms=round(duration_ms, 2),
        smart_turn_probability=round(smart_turn_result.probability, 4),
        smart_turn_eval_ms=round(smart_turn_result.eval_ms, 3),
        wav_path=str(wav_path),
        wav_bytes_len=len(wav_bytes),
        recordings_enabled=recordings_config.enabled,
        vad_end_to_turn_complete_ms=round((complete_ns - vad_end_ns) / 1e6, 3),
    )

    events.append(
        TranscriptReady(
            t_mono_ns=complete_ns,
            turn_idx=turn_idx,
            text=stitched.text,
            emotion=stitched.emotion,
            event=stitched.event,
            decode_ms=stitched.total_decode_ms,
            audio_seconds=stitched.total_audio_seconds,
            pauses=pauses_ms,
        )
    )
    logger.log(
        "sensevoice.decode",
        turn_idx=turn_idx,
        text=stitched.text,
        emotion=stitched.emotion,
        audio_event=stitched.event,
        decode_ms=round(stitched.total_decode_ms, 3),
        audio_seconds=round(stitched.total_audio_seconds, 3),
        segment_count=len(stitched.segments),
        pause_count=len(pauses_ms),
        pause_durations_ms=pauses_ms,
        vad_end_to_transcript_ms=round((transcript_ns - vad_end_ns) / 1e6, 3),
    )
