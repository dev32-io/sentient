"""Per-segment SenseVoice decoding with placeholder-joined transcript.

A turn in this pipeline is composed of N contiguous speech segments
separated by (N-1) mid-turn pauses. SenseVoice is non-autoregressive
and does NOT expose word-level timestamps, so to get ``[pause.N]``
placeholders positioned correctly in the transcript we control the
join ourselves: decode each segment separately, then concatenate the
per-segment transcripts with ``[pause.N]`` tokens in between.

Cost: N decodes instead of 1. On RPi5 + SenseVoice-Small int8, 4 short
segments take roughly 1.5–2× the wall time of a single whole-turn
decode. For single-segment turns (no pauses) there is zero overhead.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from .sense_voice import SenseVoice

if TYPE_CHECKING:  # pragma: no cover — only for type hints
    from .event_logger import JsonlLogger


@dataclass
class SegmentResult:
    """SenseVoice output for a single contiguous speech segment."""

    text: str
    emotion: str
    event: str
    decode_ms: float
    audio_seconds: float


@dataclass
class StitchedResult:
    """Whole-turn transcript assembled from per-segment decodes."""

    text: str  # placeholder-joined: "seg0 [pause.0] seg1 [pause.1] seg2"
    emotion: str  # first segment's emotion tag (representative)
    event: str   # first segment's audio event tag (representative)
    total_decode_ms: float
    total_audio_seconds: float
    segments: list[SegmentResult] = field(default_factory=list)


def decode_segments_and_stitch(
    sense_voice: SenseVoice,
    segments: list[np.ndarray],
    *,
    pause_count: int,
    logger: "JsonlLogger | None" = None,
    turn_idx: int = 0,
) -> StitchedResult:
    """Run SenseVoice on each speech segment and join with ``[pause.N]``.

    A well-formed turn satisfies ``len(segments) == pause_count + 1``. We
    do not assert it — malformed inputs produce truncated output.
    """
    results: list[SegmentResult] = []
    for idx, audio in enumerate(segments):
        r = sense_voice.transcribe(audio)
        results.append(
            SegmentResult(
                text=(r.text or "").strip(),
                emotion=r.emotion,
                event=r.event,
                decode_ms=r.decode_ms,
                audio_seconds=r.audio_seconds,
            )
        )
        if logger is not None:
            last = results[-1]
            logger.log(
                "sensevoice.segment_decode",
                turn_idx=turn_idx,
                segment_idx=idx,
                text=last.text,
                emotion=last.emotion,
                audio_event=last.event,
                decode_ms=round(last.decode_ms, 3),
                audio_seconds=round(last.audio_seconds, 3),
            )

    parts: list[str] = []
    for i, seg in enumerate(results):
        if seg.text:
            parts.append(seg.text)
        if i < len(results) - 1 and i < pause_count:
            parts.append(f"[pause.{i}]")
    joined = " ".join(parts)

    first = results[0] if results else None
    return StitchedResult(
        text=joined,
        emotion=first.emotion if first else "",
        event=first.event if first else "",
        total_decode_ms=sum(r.decode_ms for r in results),
        total_audio_seconds=sum(r.audio_seconds for r in results),
        segments=results,
    )
