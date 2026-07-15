"""Tests for the pluggable audio encoders (Task 3).

Exercises ``make_encoder`` end-to-end for both wire formats against a
synthetic 24 kHz float32 tone (the shape ``QwenEngine.synthesize``
yields — see ``engine.py``). No model load, no I/O beyond an
in-memory buffer — fast and dependency-free at test time.
"""

import io

import numpy as np
import soundfile as sf

from local_tts.encoders import make_encoder


def _tone(sec, sr=24000):
    t = np.linspace(0, sec, int(sec * sr), endpoint=False)
    return (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def test_pcm_encoder_resamples_and_frames():
    enc = make_encoder("pcm", 48000)
    out = b"".join(enc.encode([_tone(0.5)]))
    # 0.5s @48k, 16-bit mono = 48000*0.5*2 bytes (± resampler edge)
    assert abs(len(out) - 48000 * 0.5 * 2) < 2000


def test_opus_encoder_produces_ogg_opus():
    enc = make_encoder("opus", 48000)
    out = b"".join(enc.encode([_tone(0.5)]))
    assert out[:4] == b"OggS"  # OGG container magic
    # decodes back to ~48k mono
    data, sr = sf.read(io.BytesIO(out))
    assert sr == 48000


def test_unknown_format_raises():
    import pytest

    with pytest.raises(ValueError):
        make_encoder("mp3", 48000)
