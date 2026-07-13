"""``AudioEncoder`` protocol + factory — the terminal decorator stage.

Every synthesis pipeline in this service ends with an ``AudioEncoder``:
it consumes the 24 kHz float32 PCM chunks ``ChatterboxEngine.synthesize``
yields (see ``chatterbox_mlx.py``) and produces wire-format bytes ready
to send over the WebSocket. Two implementations exist today —
``OpusEncoder`` (the gateway's default, OGG-Opus @ 48 kHz) and
``PcmEncoder`` (raw PCM16-LE at any target rate) — selected at runtime
by ``make_encoder`` from ``config.default_format`` /
``config.default_sample_rate`` (see ``config.py``).

``AudioEncoder`` is a ``Protocol`` (structural typing) rather than an
ABC: ``OpusEncoder`` and ``PcmEncoder`` satisfy it by shape alone, with
no import-time coupling back to this module.
"""

from __future__ import annotations

from typing import Iterable, Iterator, Protocol

import numpy as np

# Encoder format identifiers accepted by ``make_encoder``. Kept as named
# constants (not inline string literals) per the no-magic-strings rule.
FORMAT_OPUS = "opus"
FORMAT_PCM = "pcm"


class AudioEncoder(Protocol):
    """Terminal pipeline stage: 24 kHz float32 PCM chunks -> wire-format bytes.

    Implementations stream: they consume ``pcm24k_chunks`` one chunk at
    a time and yield bytes as they become available, never buffering
    the full utterance unless the underlying codec genuinely requires
    it (see ``OpusEncoder``'s docstring for the one place that applies).
    """

    def encode(self, pcm24k_chunks: Iterable[np.ndarray]) -> Iterator[bytes]:
        """Resample + encode a stream of 24 kHz float32 PCM chunks."""
        ...


def make_encoder(format: str, target_rate: int) -> AudioEncoder:
    """Build the ``AudioEncoder`` for ``format`` at ``target_rate`` Hz.

    ``format`` is one of ``FORMAT_OPUS`` ("opus") or ``FORMAT_PCM``
    ("pcm"). Raises ``ValueError`` for any other value.

    Imports are deferred to inside each branch so this module — the
    shared entry point every caller imports — never pays for loading
    both encoder implementations when it only needs one.
    """
    if format == FORMAT_OPUS:
        from chatterbox_tts.encoders.opus_encoder import OpusEncoder

        return OpusEncoder(target_rate)
    if format == FORMAT_PCM:
        from chatterbox_tts.encoders.pcm_encoder import PcmEncoder

        return PcmEncoder(target_rate)
    raise ValueError(
        f"unknown audio encoder format: {format!r} (expected {FORMAT_OPUS!r} or {FORMAT_PCM!r})"
    )
