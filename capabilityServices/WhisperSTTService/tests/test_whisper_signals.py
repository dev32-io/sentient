"""Whisper signal extraction: worst-case no_speech_prob / avg_logprob."""
from __future__ import annotations

from whisper_stt.whisper_mlx import _extract_signals, _pick_constrained_language


def test_pick_constrained_ignores_non_candidate_winner() -> None:
    # Full autodetect would pick "id" (Indonesian) for "Halo?"; constrained to
    # en/zh it must pick the best of ONLY those two.
    probs = {"id": 0.70, "en": 0.20, "zh": 0.05, "ja": 0.05}
    assert _pick_constrained_language(probs, ("en", "zh")) == "en"


def test_pick_constrained_picks_zh_when_higher() -> None:
    probs = {"id": 0.6, "zh": 0.3, "en": 0.1}
    assert _pick_constrained_language(probs, ("en", "zh")) == "zh"


def test_pick_constrained_missing_candidate_defaults_zero() -> None:
    assert _pick_constrained_language({"en": 0.4}, ("en", "zh")) == "en"


def test_extract_worst_case_across_segments() -> None:
    result = {"segments": [
        {"no_speech_prob": 0.2, "avg_logprob": -0.3},
        {"no_speech_prob": 0.8, "avg_logprob": -1.5},
    ]}
    no_speech, logprob = _extract_signals(result)
    assert no_speech == 0.8   # max (worst)
    assert logprob == -1.5    # min (worst)


def test_extract_empty_segments_treated_as_no_speech() -> None:
    no_speech, logprob = _extract_signals({"segments": []})
    assert no_speech == 1.0
    assert logprob == -10.0
