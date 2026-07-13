"""``PcmEncoder`` — resamples 24 kHz float32 PCM to raw PCM16-LE bytes.

Simplest of the two encoders: no container framing, just resample each
chunk to ``target_rate`` and convert straight to little-endian signed
16-bit samples. Mirrors the conversion in the sibling STT service's
``whisper_stt/wav_codec.py::f32_to_pcm16_bytes`` (clip -> scale -> cast
-> ``.tobytes()``), generalized to an arbitrary target rate.
"""

from __future__ import annotations

import logging
from typing import Iterable, Iterator

import numpy as np
import soxr

from ..audio_constants import SOURCE_SAMPLE_RATE

log = logging.getLogger("chatterbox_tts.encoders.pcm_encoder")

# Chatterbox-Turbo engine output rate — imported from ``audio_constants``
# (the single source of truth, MLX-free) rather than ``chatterbox_mlx``
# itself, to keep this encoder's only external dependencies numeric
# (numpy, soxr) — it never needs to know about the MLX/model layer.
_SOURCE_RATE = SOURCE_SAMPLE_RATE

# float32 [-1, 1] -> int16 [-32767, 32767] scale factor. One below the
# full int16 range (32768) so a sample exactly at +1.0 never overflows
# after rounding — matches ``wav_codec.f32_to_pcm16_bytes``.
_PCM16_SCALE = 32767.0

# Little-endian signed 16-bit — the standard PCM16 byte order used
# throughout this codebase's wire contracts.
_PCM16_DTYPE = "<i2"


class PcmEncoder:
    """Streams raw PCM16-LE bytes at ``target_rate`` Hz, mono."""

    def __init__(self, target_rate: int) -> None:
        self._target_rate = target_rate

    def encode(self, pcm24k_chunks: Iterable[np.ndarray]) -> Iterator[bytes]:
        """Resample each chunk to ``target_rate`` and yield PCM16-LE bytes.

        One output chunk per input chunk — no cross-chunk buffering is
        needed for raw PCM, so this is fully streaming.
        """
        chunk_count = 0
        total_bytes = 0
        for chunk in pcm24k_chunks:
            resampled = soxr.resample(chunk, _SOURCE_RATE, self._target_rate)
            clipped = np.clip(resampled, -1.0, 1.0)
            pcm16_bytes = (clipped * _PCM16_SCALE).astype(_PCM16_DTYPE).tobytes()
            chunk_count += 1
            total_bytes += len(pcm16_bytes)
            yield pcm16_bytes
        log.debug(
            "pcm_encoder.encode done chunk_count=%d total_bytes=%d",
            chunk_count, total_bytes,
        )
