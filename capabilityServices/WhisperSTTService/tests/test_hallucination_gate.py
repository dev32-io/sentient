"""Hallucination gate: drop noise/phantom super-segments, keep real speech."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from whisper_stt.hallucination_gate import evaluate, rms_of


@dataclass
class _Cfg:
    no_speech_threshold: float = 0.6
    logprob_threshold: float = -1.0
    rms_energy_floor: float = 0.005
    hallucination_phrases: tuple[str, ...] = ("thank you", "you", "bye")
    hallucination_max_duration_ms: int = 1500
    phrase_energy_multiplier: float = 2.0


def test_rms_of_silence_is_zero() -> None:
    assert rms_of(np.zeros(100, dtype=np.float32)) == 0.0


def test_drop_low_energy() -> None:
    r = evaluate("Yeah", rms=0.001, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=600, cfg=_Cfg())
    assert r.drop and r.reason == "low_energy"


def test_drop_no_speech() -> None:
    r = evaluate("noise", rms=0.05, no_speech_prob=0.9, avg_logprob=-2.0,
                 duration_ms=1000, cfg=_Cfg())
    assert r.drop and r.reason == "no_speech"


def test_drop_phrase_short() -> None:
    r = evaluate("Thank you.", rms=0.05, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=800, cfg=_Cfg())
    assert r.drop and r.reason == "hallucination_phrase"


def test_keep_phrase_long_and_loud() -> None:
    r = evaluate("thank you", rms=0.05, no_speech_prob=0.1, avg_logprob=-0.2,
                 duration_ms=1800, cfg=_Cfg())
    assert not r.drop


def test_keep_real_speech() -> None:
    r = evaluate("how about tomorrow", rms=0.05, no_speech_prob=0.1,
                 avg_logprob=-0.2, duration_ms=1400, cfg=_Cfg())
    assert not r.drop
