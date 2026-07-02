"""Whole-turn (super-segment) Whisper decode with hallucination gating.

Replaces the SenseVoice-era per-micro-segment decoder. Groups micro-segments
into super-segments (split only at gaps >= min_pause_ms), decodes each with
Whisper, drops hallucinated/noise super-segments via the safety-net gate, and
stitches survivors with [pause.N]. Pauses land BETWEEN decode calls, so a
boundary can never fall mid-word; leading/trailing pauses drop by construction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from .hallucination_gate import evaluate, rms_of
from .super_segment import group_super_segments

if TYPE_CHECKING:
    from .config import WhisperConfig
    from .event_logger import JsonlLogger
    from .whisper_mlx import WhisperMlx

SAMPLE_RATE = 16_000


@dataclass
class StitchedResult:
    text: str            # "super0 [pause.0] super1 ..."
    emotion: str         # always "" (Whisper has no acoustic tags)
    event: str           # always ""
    total_decode_ms: float
    total_audio_seconds: float
    pauses: list[int] = field(default_factory=list)


def _stitch(kept_texts: list[str], kept: list[bool], pauses: list[int]) -> tuple[str, list[int]]:
    """Join kept super-segment texts with [pause.N].

    A pause is emitted only between two consecutive KEPT super-segments; gaps
    around dropped ones collapse into the next emitted pause; leading/trailing
    gaps are dropped (never emitted).
    """
    parts: list[str] = []
    out_pauses: list[int] = []
    pending_gap = 0
    seen_kept = False
    for i in range(len(kept_texts)):
        if kept[i]:
            if seen_kept:
                out_pauses.append(pending_gap)
                parts.append(f"[pause.{len(out_pauses) - 1}]")
            parts.append(kept_texts[i])
            seen_kept = True
            pending_gap = 0
        if i < len(pauses) and seen_kept:
            pending_gap += pauses[i]
    return " ".join(p for p in parts if p), out_pauses


def decode_turn(
    stt: "WhisperMlx",
    segments: list[np.ndarray],
    gaps_ms: list[int],
    *,
    cfg: "WhisperConfig",
    logger: "JsonlLogger | None" = None,
    turn_idx: int = 0,
) -> StitchedResult:
    """Group -> per-super-segment decode+gate -> stitch survivors."""
    supers, pauses = group_super_segments(segments, gaps_ms, cfg.min_pause_ms)

    kept_texts: list[str] = []
    kept: list[bool] = []
    total_decode_ms = 0.0
    total_audio_seconds = 0.0

    for idx, audio in enumerate(supers):
        rms = rms_of(audio)
        duration_ms = (audio.size / SAMPLE_RATE) * 1000.0

        # Pre-decode energy gate: near-silence never reaches Whisper. This is
        # the primary defense against noise/silence hallucination (Whisper loops
        # into "W W W ..." on near-silent audio, costing 6-7s per decode). Cheap
        # RMS check skips the whole 30s-window decode.
        if rms < cfg.rms_energy_floor:
            kept.append(False)
            kept_texts.append("")
            if logger is not None:
                logger.log(
                    "whisper.super_decode",
                    turn_idx=turn_idx,
                    super_idx=idx,
                    text="",
                    rms=round(rms, 5),
                    duration_ms=round(duration_ms, 1),
                    decode_ms=0.0,
                    dropped=True,
                    reason="low_energy_predecode",
                )
            continue

        r = stt.transcribe(audio)
        gate = evaluate(
            r.text, rms=rms, no_speech_prob=r.no_speech_prob,
            avg_logprob=r.avg_logprob, duration_ms=duration_ms, cfg=cfg,
        )
        total_decode_ms += r.decode_ms
        total_audio_seconds += r.audio_seconds
        text = r.text.strip()
        # Kept only if the gate passed AND there is actual content.
        is_kept = (not gate.drop) and bool(text)
        kept.append(is_kept)
        kept_texts.append(text if is_kept else "")
        if logger is not None:
            logger.log(
                "whisper.super_decode",
                turn_idx=turn_idx,
                super_idx=idx,
                text=text,
                rms=round(rms, 5),
                no_speech_prob=round(r.no_speech_prob, 4),
                avg_logprob=round(r.avg_logprob, 4),
                duration_ms=round(duration_ms, 1),
                decode_ms=round(r.decode_ms, 1),
                dropped=(not is_kept),
                reason=gate.reason if gate.drop else ("empty" if not text else ""),
            )

    text, out_pauses = _stitch(kept_texts, kept, pauses)
    return StitchedResult(
        text=text,
        emotion="",
        event="",
        total_decode_ms=total_decode_ms,
        total_audio_seconds=total_audio_seconds,
        pauses=out_pauses,
    )
