"""Per-connection text-buffer -> synth-request queue -> worker task.

Owns this service's one real concurrency hazard (see ``chatterbox_mlx
.py``'s class docstring): ``ChatterboxEngine.synthesize()`` mutates the
shared ``lru_cache``'d model singleton's ``model._conds`` and is a
**blocking, synchronous** MLX generator on a single GPU. Rules below,
verbatim from the task brief, span this file plus two thin siblings —
``synth_worker.py`` (worker-thread half) and ``synth_metrics.py`` (pure
post-request metrics half):

1. A single injected ``asyncio.Lock`` (one per server process) is held
   for the FULL duration of each request — ``voice_store.get(voice)``
   through the last emitted chunk — so at most one synthesis runs at a
   time across the whole service.
2. The blocking generator runs OFF the event loop on a worker thread
   (``synth_worker.produce_chunks``); encoded chunks cross back via a
   bounded ``asyncio.Queue`` (cross-thread ``run_coroutine_threadsafe``
   puts). Only the event loop ever calls ``ws.send``.
3. ``{"type":"cancel"}`` or a WS close sets a ``threading.Event`` that
   ``synthesize()`` checks between chunks, so the generator returns
   early. ``_drain_to_ws`` keeps consuming to ``QUEUE_STOP`` even after
   a send failure, so the worker thread never blocks forever on an
   undrained queue (``close()`` follows the same rule).

One ``SynthesisRunner`` per WebSocket connection: buffered text
(``add_text``) moves onto this connection's own request queue at
``flush()``/``end``; a single background task drains it sequentially,
so flushes on one connection never race locally, and the shared lock
serializes across every other connection's requests too.
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
from .event_sender import _safe_log, send_error_event, send_server_event, send_server_event_safe
from .pipeline_events import Done, Started
from .synth_metrics import build_done_fields, build_synth_record, compute_metrics
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

# Chatterbox-Turbo engine output rate (``chatterbox_mlx.SAMPLE_RATE``),
# duplicated as a plain constant (not imported) to keep this module's
# non-TYPE_CHECKING imports MLX-free — see ``encoders/pcm_encoder.py``.
_SOURCE_SAMPLE_RATE = 24_000

# Bounds a slow WS send to backpressuring the worker thread (blocked on
# ``queue.put``) instead of buffering unbounded audio. Internal detail,
# not an operator tunable — see ``config.md``'s "NOT config" carve-out.
_CHUNK_QUEUE_MAXSIZE = 8

# Non-fatal: an over-timeout daemon thread is still reaped on exit; this
# only bounds how long a request "waits" to confirm it fully exited.
_WORKER_JOIN_TIMEOUT_S = 2.0

# close() teardown: how long to drain the in-flight chunk_queue while
# waiting for its worker thread to exit before hard-cancelling regardless
# (daemon thread — reaped on process exit either way).
_CLOSE_WORKER_TIMEOUT_S = 3.0
_CLOSE_DRAIN_POLL_S = 0.02  # poll interval for that drain-while-waiting loop


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
        # Set once `close()` begins; blocks `_run_queue` from starting more.
        self._closing = False
        # In-flight request's chunk queue + worker thread, if any — lets
        # `close()` reach + drain them on an abrupt disconnect.
        self._active_chunk_queue: "asyncio.Queue[Any] | None" = None
        self._active_worker_thread: threading.Thread | None = None
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
        """Stop the worker task; called from the connection's ``finally`` block.

        Graceful-first: hard-cancelling ``_worker_task`` immediately (the
        old behavior) can land while ``_drain_to_ws`` is awaiting
        ``chunk_queue.get()`` — the cancel stops it calling ``.get()``
        again, so a producer stuck on (or later filling) a bounded
        ``queue.put()`` blocks forever: a leaked daemon thread. So: set
        ``cancel_event``, keep the active queue drained until its worker
        THREAD actually exits, and only then hard-cancel.

        ``_closing`` is set FIRST (before any ``await`` here) so
        ``_run_queue`` can't start a further request once teardown begins —
        else a second queued request starts against a fresh worker thread
        while this polls the FIRST (now-stale) one, and the hard-cancel
        below lands on that second, un-cancelled request instead.
        """
        self._closing = True
        drain_queue_nowait(self._queue)
        self._cancel_event.set()
        thread = self._active_worker_thread
        deadline = time.monotonic() + _CLOSE_WORKER_TIMEOUT_S
        while thread is not None and thread.is_alive() and time.monotonic() < deadline:
            self._drain_active_queue_nowait()
            await asyncio.sleep(_CLOSE_DRAIN_POLL_S)
        self._drain_active_queue_nowait()  # final sweep
        if thread is not None and thread.is_alive():
            log.warning(
                "synth.close_worker_thread_stuck thread=%s timeout_s=%.1f",
                thread.name, _CLOSE_WORKER_TIMEOUT_S,
            )
        self._worker_task.cancel()
        try:
            await self._worker_task
        except (asyncio.CancelledError, Exception):
            pass

    def _drain_active_queue_nowait(self) -> None:
        if self._active_chunk_queue is not None:
            drain_queue_nowait(self._active_chunk_queue)

    async def _run_queue(self) -> None:
        while True:
            if self._closing:
                return
            text = await self._queue.get()
            if self._closing:
                return
            self._cancel_event = threading.Event()
            try:
                await self._handle_one_request(text)
            except ConnectionClosed:
                return

    async def _handle_one_request(self, text: str) -> None:
        request_id = uuid.uuid4().hex[:12]
        t0 = time.monotonic()
        cancel_event = self._cancel_event
        _safe_log(
            self._conn_log, "synth.request_start", request_id=request_id, text_len=len(text),
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
            await send_error_event(self._ws, exc, self._conn_log)
            return
        await self._finish_request(metrics)

    async def _run_and_drain(
        self, text: str, request_id: str, cancel_event: threading.Event, t0: float,
    ) -> Metrics:
        conds = self._voice_store.get_or_default(self._voice)
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
        # `close()` reaches this via `_active_*` on an abrupt disconnect;
        # overwritten fresh next request, so a stale ref is harmless.
        self._active_chunk_queue = chunk_queue
        self._active_worker_thread = worker
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
        return compute_metrics(
            request_id=request_id, ttfa_ms=ttfa_ms, decode_ms=decode_ms,
            total_samples=counter.total_samples, source_sample_rate=_SOURCE_SAMPLE_RATE,
            bytes_sent=bytes_sent,
        )

    async def _drain_to_ws(
        self, chunk_queue: "asyncio.Queue[Any]", t0: float,
        cancel_event: threading.Event, initial_error: BaseException | None,
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
        """Send the ``Done`` event and log the ``chatterbox.synthesize`` metrics
        record — field math and record shape live in ``synth_metrics.py``.
        """
        await send_server_event_safe(self._ws, Done(**build_done_fields(metrics)), self._conn_log)
        record = build_synth_record(
            metrics=metrics, voice_id=self._voice, format=self._format, sample_rate=self._sample_rate,
        )
        _safe_log(self._metrics_log, "chatterbox.synthesize", **record)
