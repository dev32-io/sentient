"""Whisper signal extraction: worst-case no_speech_prob / avg_logprob."""
from __future__ import annotations

from whisper_stt.whisper_mlx import _extract_signals


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
