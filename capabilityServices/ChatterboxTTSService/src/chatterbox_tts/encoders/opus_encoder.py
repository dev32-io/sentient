"""``OpusEncoder`` — resamples 24 kHz float32 PCM to OGG-Opus bytes.

Implementation choice: this wraps ``soundfile.SoundFile`` (libsndfile)
writing directly to ``format="OGG", subtype="OPUS"``, instead of
driving ``opuslib``'s raw Opus encoder plus a hand-written OGG page
writer. Verified at dev time that the installed libsndfile build
supports the pair (``"OPUS" in soundfile.available_subtypes("OGG")``
is ``True``) — when that holds, it is the simplest correct path to
standards-conformant ``OggS``-framed output: libsndfile owns page
segmentation, granule positions, and CRCs, so there is no hand-rolled
OGG-paging code to get wrong. ``opuslib`` stays a declared dependency
for a future fallback if a deploy target's libsndfile lacks Opus
support, but this encoder does not use it.

Streaming note: input chunks are still resampled and written to the
encoder one at a time (never buffers the full utterance PCM), but
libsndfile's own OGG/Opus writer batches internally and mostly flushes
complete pages at ``close()`` rather than after every ``write()`` call
— so ``encode()`` may yield nothing for several input chunks and then
a larger tail once the stream closes. That page-buffering granularity
is a property of the underlying libsndfile/libopus writer, not of this
wrapper, which yields every new byte as soon as libsndfile makes it
available.
"""

from __future__ import annotations

import io
import logging
from typing import Iterable, Iterator

import numpy as np
import soundfile as sf
import soxr

log = logging.getLogger("chatterbox_tts.encoders.opus_encoder")

# Opus is only defined for mono/stereo at 8/12/16/24/48 kHz; the gateway's
# Opus-everywhere pipeline (see requirements.txt) always terminates at 48 kHz.
_SOURCE_RATE = 24_000
_CHANNELS = 1  # mono voice output

# soundfile/libsndfile format + subtype identifiers for OGG-Opus.
_CONTAINER_FORMAT = "OGG"
_CODEC_SUBTYPE = "OPUS"


class OpusEncoder:
    """Streams OGG-Opus bytes at ``target_rate`` Hz (mono)."""

    def __init__(self, target_rate: int) -> None:
        self._target_rate = target_rate

    def encode(self, pcm24k_chunks: Iterable[np.ndarray]) -> Iterator[bytes]:
        """Resample each chunk to ``target_rate`` and yield OGG-Opus bytes.

        Writes into an in-memory ``BytesIO`` via ``soundfile.SoundFile``
        and yields only the bytes libsndfile has newly appended since
        the last check — never re-reads or re-yields already-emitted
        data. The final page(s) flush when the ``with`` block closes
        the writer, so a trailing yield after the loop is expected
        (see module docstring).
        """
        buf = io.BytesIO()
        emitted = 0
        chunk_count = 0
        with sf.SoundFile(
            buf,
            mode="w",
            samplerate=self._target_rate,
            channels=_CHANNELS,
            format=_CONTAINER_FORMAT,
            subtype=_CODEC_SUBTYPE,
        ) as writer:
            for chunk in pcm24k_chunks:
                chunk_count += 1
                resampled = soxr.resample(chunk, _SOURCE_RATE, self._target_rate)
                writer.write(resampled)
                emitted, page = _drain_new_bytes(buf, emitted)
                if page:
                    log.debug(
                        "opus_encoder.encode flush chunk_idx=%d bytes=%d",
                        chunk_count, len(page),
                    )
                    yield page

        emitted, tail = _drain_new_bytes(buf, emitted)
        if tail:
            log.debug("opus_encoder.encode final_flush bytes=%d", len(tail))
            yield tail
        log.debug(
            "opus_encoder.encode done chunk_count=%d total_bytes=%d",
            chunk_count, emitted,
        )


def _drain_new_bytes(buf: io.BytesIO, since: int) -> tuple[int, bytes]:
    """Return ``(new_offset, bytes written to buf since offset since)``.

    Uses ``buf.tell()`` (the writer's current position, advanced only
    by ``write()`` calls) rather than seeking — seeking the buffer
    between writes would desync libsndfile's own notion of where the
    stream's write cursor is.

    Slices via ``getbuffer()`` (zero-copy ``memoryview``) instead of
    ``getvalue()``, which copies the ENTIRE buffer on every call — with
    ``getvalue()`` this function was O(n^2) CPU and O(total emitted) peak
    memory over a long stream. The memoryview is released (via ``with``)
    before returning: an exported buffer export locks the ``BytesIO``
    against resize, and the next ``sf.write()`` call would raise
    ``BufferError`` if the view were still held open.
    """
    current = buf.tell()
    if current <= since:
        return since, b""
    with buf.getbuffer() as view:
        new_bytes = bytes(view[since:current])
    return current, new_bytes
