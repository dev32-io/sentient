"""PCM16 ↔ WAV helpers used by the turn pipeline."""

from __future__ import annotations

import io
import wave

import numpy as np


def pcm16_to_wav_bytes(pcm16_bytes: bytes, sample_rate: int) -> bytes:
    """Wrap raw PCM16 LE mono samples in a RIFF/WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm16_bytes)
    return buf.getvalue()


def f32_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    """Convert a float32 array in [-1, 1] to little-endian signed 16-bit bytes."""
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()
