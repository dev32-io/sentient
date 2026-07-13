"""Worker-thread side of one synthesis request: MLX generate -> encode -> hand off.

Split out of ``synthesis.py`` (which owns the event-loop side: the
request queue, the drain loop, metrics) purely to keep both files under
the project's line cap — these two files together implement the single
concurrency design described in ``synthesis.py``'s module docstring.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np

from .encoders import AudioEncoder

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .chatterbox_mlx import ChatterboxEngine  # heavy import cost for non-live tests.

# Sentinel pushed onto the cross-thread chunk queue to mark "no more chunks".
QUEUE_STOP = object()


class WorkerFailure:
    """Wraps an exception raised inside the synthesis worker thread."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException) -> None:
        self.exc = exc


class SampleCounter:
    """Thread-shared running total of raw 24 kHz PCM samples produced."""

    def __init__(self) -> None:
        self.total_samples = 0

    def add(self, chunk: np.ndarray) -> None:
        self.total_samples += chunk.size


@dataclass
class Metrics:
    request_id: str
    ttfa_ms: float
    rtf: float
    audio_seconds: float
    decode_ms: float
    bytes_sent: int


def _count_chunks(pcm_iter, counter: SampleCounter):
    """Pass PCM chunks through unchanged, tallying total sample count."""
    for chunk in pcm_iter:
        counter.add(chunk)
        yield chunk


def produce_chunks(
    engine: "ChatterboxEngine",
    text: str,
    conds: object,
    streaming_interval: float,
    cancel_event: threading.Event,
    encoder: AudioEncoder,
    counter: SampleCounter,
    loop: asyncio.AbstractEventLoop,
    chunk_queue: "asyncio.Queue[Any]",
) -> None:
    """Runs on a worker thread: drive the blocking MLX generator, encode, hand off.

    Every encoded byte-chunk is pushed onto ``chunk_queue`` via
    ``run_coroutine_threadsafe`` (the standard, documented way to push
    into an asyncio primitive from a non-event-loop thread) so the event
    loop is the only thing that ever touches the WebSocket. Backpressure
    comes from the queue's bounded size: ``.result()`` blocks this thread
    until the event loop drains room. On any exception the failure is
    wrapped and enqueued so the event-loop side surfaces it as an
    ``error`` frame instead of hanging on the sentinel forever.
    """
    try:
        pcm_iter = engine.synthesize(text, conds, streaming_interval, cancel_event)
        for encoded in encoder.encode(_count_chunks(pcm_iter, counter)):
            if cancel_event.is_set():
                break
            asyncio.run_coroutine_threadsafe(chunk_queue.put(encoded), loop).result()
    except Exception as exc:  # surfaced as an `error` frame by the event-loop side
        asyncio.run_coroutine_threadsafe(chunk_queue.put(WorkerFailure(exc)), loop).result()
    finally:
        asyncio.run_coroutine_threadsafe(chunk_queue.put(QUEUE_STOP), loop).result()


def drain_queue_nowait(queue: "asyncio.Queue[Any]") -> None:
    """Best-effort clear of not-yet-started queued requests (used by cancel)."""
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return
