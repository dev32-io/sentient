"""decode_turn: group -> decode -> gate -> stitch with [pause.N]."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from whisper_stt.turn_decoder import decode_turn
from whisper_stt.whisper_mlx import TranscriptResult


@dataclass
class _Cfg:
    min_pause_ms: int = 2000               # matches prod default; gaps below merge
    no_speech_threshold: float = 0.6
    logprob_threshold: float = -1.0
    rms_energy_floor: float = 0.0          # 0 => energy never drops (isolate stitch)
    hallucination_phrases: tuple[str, ...] = ("thank you",)
    hallucination_max_duration_ms: int = 1500
    phrase_energy_multiplier: float = 2.0


class _FakeStt:
    """Returns canned transcripts in call order."""
    def __init__(self, texts: list[str]) -> None:
        self._texts = texts
        self._i = 0

    def transcribe(self, audio: np.ndarray) -> TranscriptResult:
        t = self._texts[self._i]
        self._i += 1
        return TranscriptResult(text=t, emotion="", event="",
                                decode_ms=1.0, audio_seconds=audio.size / 16000,
                                no_speech_prob=0.1, avg_logprob=-0.2)


def _seg(n: int = 32000) -> np.ndarray:   # ~2s of non-silent audio
    return np.full(n, 0.1, dtype=np.float32)


def test_two_supersegments_one_pause() -> None:
    stt = _FakeStt(["how about tomorrow", "and the day after"])
    r = decode_turn(stt, [_seg(), _seg()], [2500], cfg=_Cfg(), logger=None, turn_idx=0)
    assert r.text == "how about tomorrow [pause.0] and the day after"
    assert r.pauses == [2500]


def test_single_supersegment_no_pause() -> None:
    stt = _FakeStt(["what's the weather"])
    r = decode_turn(stt, [_seg()], [], cfg=_Cfg(), logger=None, turn_idx=0)
    assert r.text == "what's the weather"
    assert r.pauses == []


def test_dropped_phantom_supersegment_yields_rejected_empty() -> None:
    # single short quiet phantom -> phrase gate drops -> empty
    cfg = _Cfg(rms_energy_floor=0.0)
    stt = _FakeStt(["Thank you."])
    short = np.full(8000, 0.001, dtype=np.float32)  # ~0.5s, quiet
    r = decode_turn(stt, [short], [], cfg=cfg, logger=None, turn_idx=0)
    assert r.text == ""


def test_middle_drop_collapses_pauses() -> None:
    # real, phantom(dropped), real -> one pause between the two kept, summed
    cfg = _Cfg(rms_energy_floor=0.0)
    stt = _FakeStt(["hello there", "thank you", "goodbye now"])
    quiet_short = np.full(8000, 0.001, dtype=np.float32)
    r = decode_turn(stt, [_seg(), quiet_short, _seg()], [2100, 2200],
                    cfg=cfg, logger=None, turn_idx=0)
    assert r.text == "hello there [pause.0] goodbye now"
    assert r.pauses == [4300]   # 2100 + 2200 collapsed
