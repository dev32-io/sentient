"""Per-connection text-buffer -> synth-request queue -> worker task.

This module owns the one piece of this service with a real concurrency
hazard (see ``chatterbox_mlx.py``'s class docstring): ``ChatterboxEngine
.synthesize()`` mutates the shared ``lru_cache``'d model singleton's
``model._conds`` and is a **blocking, synchronous** MLX generator on a
single GPU. The rules this module (plus ``synth_worker.py``, its worker-
thread half) follow, verbatim from the task brief:

1. A single ``asyncio.Lock`` (injected, one per server process) is held
   for the FULL duration of each synthesis request — from
   ``voice_store.get(voice)`` through the last emitted chunk — so at
   most one synthesis runs at a time across the whole service.
2. The blocking generator runs OFF the event loop, on a worker thread
   (``synth_worker.produce_chunks``). Encoded byte-chunks are handed
   back to the event loop via a bounded ``asyncio.Queue`` (cross-thread
   puts use ``asyncio.run_coroutine_threadsafe``). The event loop is the
   only thing that ever calls ``ws.send``.
3. ``{"type":"cancel"}`` or a WS close sets a ``threading.Event`` that
   ``synthesize()`` checks between chunks, so the generator returns
   early and the worker thread unwinds. ``_drain_to_ws`` keeps consuming
   the chunk queue until the worker's ``QUEUE_STOP`` sentinel even after
   a send failure — otherwise the worker thread could block forever on a
   queue nobody is draining anymore.

One ``SynthesisRunner`` is constructed per WebSocket connection. Buffered
text (``add_text``) accumulates until ``flush()`` (sentence boundary) or
``end`` moves it onto this connection's own request queue, which a
single background task drains sequentially — so multiple flushes on one
connection never race each other locally, and the shared lock serializes
them against every other connection's requests too.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any

from websockets.exceptions import ConnectionClosed

from .encoders import make_encoder
from .event_sender import send_server_event
from .pipeline_events import Done, ErrorEvent, Started
from .synth_worker import (
    QUEUE_STOP,
    Metrics,
    SampleCounter,
    WorkerFailure,
    drain_queue_nowait,
    produce_chunks,
)

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .chatterbox_mlx import ChatterboxEngine  # heavy import cost for non-live tests.
    from .voice_store import VoiceStore

log = logging.getLogger("chatterbox_tts.synthesis")

# Chatterbox-Turbo engine output rate (``chatterbox_mlx.SAMPLE_RATE``).
# Duplicated as a plain constant here rather than importing the engine
# module, mirroring ``encoders/pcm_encoder.py``'s established rationale:
# keep this module's non-TYPE_CHECKING imports free of the heavy MLX
# stack so non-live tests stay fast and dependency-light.
_SOURCE_SAMPLE_RATE = 24_000

# Bounded so a slow WS send applies backpressure to the worker thread
# (it blocks on ``queue.put`` once full) instead of buffering an
# unbounded amount of encoded audio in memory. Internal implementation
# detail, not an operator tunable — see ``config.md``'s "HTTP status
# codes... are NOT config" carve-out.
_CHUNK_QUEUE_MAXSIZE = 8

# Non-fatal: a daemon thread that outlives this timeout is still reaped
# on process exit; this just bounds how long a request "waits" to
# confirm the worker fully exited before moving on.
_WORKER_JOIN_TIMEOUT_S = 2.0


class SynthesisRunner:
    """Owns one connection's text buffer, request queue, and worker task."""

    def __init__(
        self,
        *,
        engine: "ChatterboxEngine",
        voice_store: "VoiceStore",
        synth_lock: asyncio.Lock,
        ws: Any,
        conn_id: str,
        format_: str,
        sample_rate: int,
        voice: str | None,
        streaming_interval: float,
        conn_log: Any,
        metrics_log: Any,
    ) -> None:
        self._engine = engine
        self._voice_store = voice_store
        self._synth_lock = synth_lock
        self._ws = ws
        self._conn_id = conn_id
        self._format = format_
        self._sample_rate = sample_rate
        self._voice = voice
        self._streaming_interval = streaming_interval
        self._conn_log = conn_log
        self._metrics_log = metrics_log
        self._text_buffer: list[str] = []
        self._queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._cancel_event = threading.Event()
        self._worker_task = asyncio.create_task(
            self._run_queue(), name=f"tts-synth-{conn_id}"
        )

    def add_text(self, text: str) -> None:
        self._text_buffer.append(text)

    def flush(self) -> None:
        """Move buffered text onto the request queue, if any is buffered."""
        if not self._text_buffer:
            return
        text = "".join(self._text_buffer)
        self._text_buffer = []
        self._queue.put_nowait(text)

    def cancel_current(self) -> None:
        """Abort the in-flight request (if any) and drop queued-but-unstarted ones."""
        self._cancel_event.set()
        drain_queue_nowait(self._queue)

    async def close(self) -> None:
        """Stop the worker task; called from the connection's ``finally`` block."""
        self._cancel_event.set()
        self._worker_task.cancel()
        try:
            await self._worker_task
        except (asyncio.CancelledError, Exception):
            pass

    async def _run_queue(self) -> None:
        while True:
            text = await self._queue.get()
            self._cancel_event = threading.Event()
            try:
                await self._handle_one_request(text)
            except ConnectionClosed:
                return

    async def _handle_one_request(self, text: str) -> None:
        request_id = uuid.uuid4().hex[:12]
        t0 = time.monotonic()
        cancel_event = self._cancel_event
        self._conn_log.log(
            "synth.request_start", request_id=request_id, text_len=len(text),
            format=self._format, sample_rate=self._sample_rate, voice=self._voice,
        )
        try:
            async with self._synth_lock:
                metrics = await self._run_and_drain(text, request_id, cancel_event, t0)
        except ConnectionClosed:
            cancel_event.set()
            raise
        except Exception as exc:
            log.exception("synth.request_failed request_id=%s", request_id)
            await self._send_safe(ErrorEvent(reason=str(exc) or type(exc).__name__))
            return
        await self._finish_request(metrics)

    async def _run_and_drain(
        self, text: str, request_id: str, cancel_event: threading.Event, t0: float,
    ) -> Metrics:
        conds = self._resolve_conds()
        encoder = make_encoder(self._format, self._sample_rate)
        counter = SampleCounter()
        loop = asyncio.get_running_loop()
        chunk_queue: "asyncio.Queue[Any]" = asyncio.Queue(maxsize=_CHUNK_QUEUE_MAXSIZE)
        worker = threading.Thread(
            target=produce_chunks,
            args=(
                self._engine, text, conds, self._streaming_interval, cancel_event,
                encoder, counter, loop, chunk_queue,
            ),
            daemon=True,
            name=f"tts-worker-{request_id}",
        )
        worker.start()

        initial_error: BaseException | None = None
        try:
            await send_server_event(self._ws, Started(request_id=request_id), self._conn_log)
        except ConnectionClosed as exc:
            cancel_event.set()
            initial_error = exc

        ttfa_ms, bytes_sent, error = await self._drain_to_ws(
            chunk_queue, t0, cancel_event, initial_error,
        )
        await asyncio.to_thread(worker.join, _WORKER_JOIN_TIMEOUT_S)
        if error is not None:
            raise error

        decode_ms = (time.monotonic() - t0) * 1000.0
        audio_seconds = counter.total_samples / _SOURCE_SAMPLE_RATE
        rtf = (decode_ms / 1000.0) / audio_seconds if audio_seconds > 0 else 0.0
        return Metrics(request_id, ttfa_ms or decode_ms, rtf, audio_seconds, decode_ms, bytes_sent)

    def _resolve_conds(self) -> object:
        try:
            return self._voice_store.get(self._voice)
        except ValueError:
            log.warning(
                "synth.invalid_voice_id falling back to default voice=%r", self._voice,
            )
            return self._voice_store.get(None)

    async def _drain_to_ws(
        self,
        chunk_queue: "asyncio.Queue[Any]",
        t0: float,
        cancel_event: threading.Event,
        initial_error: BaseException | None,
    ) -> tuple[float | None, int, BaseException | None]:
        """Drain ``chunk_queue`` to the ``QUEUE_STOP`` sentinel, sending each
        chunk over the WS. Keeps draining (without sending) after a send
        failure so the worker thread's blocking ``queue.put`` calls always
        unblock — never leaving it stuck waiting on a queue nobody reads.
        """
        ttfa_ms: float | None = None
        bytes_sent = 0
        terminal_error = initial_error
        worker_error: BaseException | None = None
        while True:
            item = await chunk_queue.get()
            if item is QUEUE_STOP:
                break
            if isinstance(item, WorkerFailure):
                worker_error = item.exc
                continue
            if terminal_error is not None:
                continue
            try:
                if ttfa_ms is None:
                    ttfa_ms = (time.monotonic() - t0) * 1000.0
                await self._ws.send(item)
                bytes_sent += len(item)
            except ConnectionClosed as exc:
                cancel_event.set()
                terminal_error = exc
        return ttfa_ms, bytes_sent, (terminal_error or worker_error)

    async def _finish_request(self, metrics: Metrics) -> None:
        await self._send_safe(
            Done(
                request_id=metrics.request_id,
                ttfa_ms=round(metrics.ttfa_ms, 2),
                rtf=round(metrics.rtf, 4),
                audio_seconds=round(metrics.audio_seconds, 3),
            )
        )
        self._metrics_log.log(
            "chatterbox.synthesize",
            request_id=metrics.request_id,
            ttfa_ms=round(metrics.ttfa_ms, 2),
            rtf=round(metrics.rtf, 4),
            audio_seconds=round(metrics.audio_seconds, 3),
            decode_ms=round(metrics.decode_ms, 2),
            voice_id=self._voice,
            format=self._format,
            sample_rate=self._sample_rate,
            bytes_sent=metrics.bytes_sent,
        )

    async def _send_safe(self, evt) -> None:
        """Send an event, swallowing a closed-connection failure (nothing to tell)."""
        try:
            await send_server_event(self._ws, evt, self._conn_log)
        except ConnectionClosed:
            pass
