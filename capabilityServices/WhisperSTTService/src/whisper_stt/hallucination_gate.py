"""Safety-net gate: drop hallucinated / noise super-segments.

Whisper hallucinates plausible filler on short or near-silent audio. A super-
segment is dropped when it is (1) too quiet (RMS floor — phrase-agnostic), or
(2) Whisper's own signals say non-speech (no_speech_prob AND avg_logprob), or
(3) it exactly matches a known filler-hallucination phrase AND is short or quiet
(so a real, loud phrase survives).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .config import WhisperConfig

# Unicode-aware: strip everything that is not a word char or whitespace.
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


@dataclass
class GateResult:
    drop: bool
    reason: str


def rms_of(audio: np.ndarray) -> float:
    """Root-mean-square amplitude of float32 audio. 0.0 for empty."""
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


def _normalize(text: str) -> str:
    return _PUNCT_RE.sub("", text).strip().lower()


def evaluate(
    text: str,
    *,
    rms: float,
    no_speech_prob: float,
    avg_logprob: float,
    duration_ms: float,
    cfg: "WhisperConfig",
) -> GateResult:
    """Decide whether to drop this super-segment as a hallucination/noise."""
    if rms < cfg.rms_energy_floor:
        return GateResult(True, "low_energy")
    # Independent decode-signal gates. These were previously AND-ed, but on
    # hallucinations no_speech_prob stays ~0.0 (Whisper is sure it's speech), so
    # the AND never fired and low-confidence junk like "You" (avg_logprob -1.99)
    # slipped through. Whisper's own transcribe applies logprob_threshold
    # independently — so do we now: a low-confidence decode drops on its own.
    if avg_logprob < cfg.logprob_threshold:
        return GateResult(True, "low_confidence")
    if no_speech_prob > cfg.no_speech_threshold:
        return GateResult(True, "no_speech")
    norm = _normalize(text)
    phrases = {_normalize(p) for p in cfg.hallucination_phrases}
    if norm in phrases:
        short = duration_ms < cfg.hallucination_max_duration_ms
        quiet = rms < cfg.rms_energy_floor * cfg.phrase_energy_multiplier
        if short or quiet:
            return GateResult(True, "hallucination_phrase")
    return GateResult(False, "")
