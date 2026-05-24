"""PCM16 <-> WAV helpers used by the turn pipeline.

These are pure functions — no state, no side effects, no external deps
beyond numpy and the Python standard library. A great target for unit
tests if you ever add them.

Python note — ``io.BytesIO``:
  ``BytesIO`` is an in-memory file-like object. The stdlib ``wave``
  module wants to write to a "file", but we don't want an actual file
  on disk — we just want the WAV bytes in memory so we can send them
  over the WebSocket. ``BytesIO`` gives ``wave`` a fake file to write
  into, and ``buf.getvalue()`` retrieves the accumulated bytes at the
  end. This is Python's equivalent of Java's ``ByteArrayOutputStream``.
"""

from __future__ import annotations

import io
import wave

import numpy as np


def pcm16_to_wav_bytes(pcm16_bytes: bytes, sample_rate: int) -> bytes:
    """Wrap raw PCM16 LE mono samples in a RIFF/WAV container.

    The output is a complete, valid ``.wav`` file you can open in any
    audio player. The RIFF header adds 44 bytes of overhead.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 2 bytes per sample = 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm16_bytes)
    return buf.getvalue()


def f32_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    """Convert a float32 array in [-1, 1] to little-endian signed 16-bit bytes.

    Steps:
    1. Clip to [-1, 1] to prevent integer overflow on conversion.
    2. Scale from float range [-1, 1] to int16 range [-32767, 32767].
    3. Cast to ``<i2`` (little-endian signed 16-bit integer — the
       standard PCM16 byte order).
    4. ``.tobytes()`` returns the raw memory — each sample is exactly 2
       bytes, no header, ready to embed in a WAV or stream over a socket.
    """
    clipped = np.clip(audio, -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()
