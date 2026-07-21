"""Per-connection text-buffer -> synth-request queue -> worker task.

``QwenEngine.synthesize()`` takes its reference audio as a plain per-call
argument, so — unlike the retired prior engine — it no longer races
concurrent calls over shared model state. It's still a **blocking,
synchronous** MLX generator on a single GPU/model, so this file keeps
the single-lock design below to avoid two requests fighting over the
same Metal device. Spans this file plus two thin siblings —
``synth_worker.py`` (worker-thread half) and ``synth_metrics.py`` (pure
post-request metrics half):

1. A single injected ``asyncio.Lock`` (one per server process) is held for the FULL
   duration of each request — ``voice_store.get(voice)`` through the last emitted
   chunk — so at most one synthesis runs at a time across the whole service.
2. The blocking generator runs OFF the event loop on the ONE process-wide MLX
   thread (``SynthExecutor``): each request is submitted as a ``SynthJob`` and
   runs there via ``synth_worker.produce_chunks``. All MLX work (warm + every
   ``generate``/``eval``) lives on that single thread because MLX binds array
   stream affinity per-thread — see ``synth_executor.py``. Chunks cross back via a
   bounded ``asyncio.Queue`` (cross-thread ``run_coroutine_threadsafe`` puts); only
   the event loop calls ``ws.send``.
3. ``{"type":"cancel"}`` or a WS close sets a ``threading.Event`` that ``synthesize()``
   checks between chunks, returning early. ``synth_drain.drain_to_ws`` keeps consuming
   to ``QUEUE_STOP`` even after a send failure, so the MLX thread never blocks
   forever on an undrained queue (``close()`` follows the same rule).

One ``SynthesisRunner`` per WebSocket connection: buffered text (``add_text``) moves
onto this connection's own request queue at ``flush()``/``end``; a single background
task drains it sequentially, so flushes on one connection never race locally, and
the shared lock serializes across every other connection's requests too.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any

from websockets.exceptions import ConnectionClosed

from .audio_constants import SOURCE_SAMPLE_RATE
from .encoders import make_encoder
from .event_sender import _safe_log, send_error_event, send_server_event, send_server_event_safe
from .pipeline_events import Done, Started
from .synth_drain import drain_to_ws
from .synth_executor import SynthJob
from .synth_metrics import build_done_fields, build_synth_record, compute_metrics
from .synth_worker import Metrics, SampleCounter, drain_queue_nowait

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .synth_executor import SynthExecutor
    from .voice_store import VoiceStore

log = logging.getLogger("local_tts.synthesis")

# Engine output rate — imported from ``audio_constants`` (the single
# source of truth, MLX-free) to keep this module's non-TYPE_CHECKING
# imports MLX-free — see ``encoders/pcm_encoder.py``.
_SOURCE_SAMPLE_RATE = SOURCE_SAMPLE_RATE

# Bounds a slow WS send to backpressuring the worker thread (blocked on
# ``queue.put``) instead of buffering unbounded audio — not an operator
# tunable, see ``config.md``'s "NOT config" carve-out.
_CHUNK_QUEUE_MAXSIZE = 8

# Non-fatal bound on how long a request waits to confirm its job finished
# on the shared MLX thread (``produce_chunks`` returned) after draining —
# ``QUEUE_STOP`` is its last act, so ``done`` is set essentially at once.
_JOB_DONE_TIMEOUT_S = 2.0

# close() teardown: how long to drain the in-flight chunk_queue while
# waiting for the active job to finish on the shared MLX thread before
# giving up (the thread itself is process-wide and never joined here).
_CLOSE_WORKER_TIMEOUT_S = 3.0
_CLOSE_DRAIN_POLL_S = 0.02  # poll interval for that drain-while-waiting loop


class SynthesisRunner:
    """Owns one connection's text buffer, request queue, and worker task."""

    def __init__(
        self,
        *,
        executor: "SynthExecutor",
        voice_store: "VoiceStore",
        synth_lock: asyncio.Lock,
        ws: Any,
        conn_id: str,
        format_: str,
        sample_rate: int,
        voice: str | None,
        streaming_interval: float,
        default_lang: str,
        conn_log: Any,
        metrics_log: Any,
        frontend: Any,
    ) -> None:
        self._executor = executor
        self._voice_store = voice_store
        self._synth_lock = synth_lock
        self._ws = ws
        self._conn_id = conn_id
        self._format = format_
        self._sample_rate = sample_rate
        self._voice = voice
        self._streaming_interval = streaming_interval
        self._default_lang = default_lang
        self._conn_log = conn_log
        self._metrics_log = metrics_log
        self._frontend = frontend
        self._text_buffer: list[str] = []
        self._queue: "asyncio.Queue[str]" = asyncio.Queue()
        self._cancel_event = threading.Event()
        # Set once `close()` begins; blocks `_run_queue` from starting more.
        self._closing = False
        # In-flight request's chunk queue + job, if any — lets `close()`
        # reach + drain them on an abrupt disconnect.
        self._active_chunk_queue: "asyncio.Queue[Any] | None" = None
        self._active_job: SynthJob | None = None
        self._worker_task = asyncio.create_task(
            self._run_queue(), name=f"tts-synth-{conn_id}"
        )

    def add_text(self, text: str) -> None:
        self._text_buffer.append(text)

    def flush(self) -> None:
        """Run the buffered text through the frontend, then enqueue it."""
        if not self._text_buffer:
            return
        raw = "".join(self._text_buffer)
        self._text_buffer = []
        speakable = self._frontend.process(raw, self._default_lang)
        if not speakable:
            self._conn_log.log("synth.flush_empty_after_frontend", raw_len=len(raw))
            return
        self._queue.put_nowait(speakable)

    def cancel_current(self) -> None:
        """Abort the in-flight request (if any) and drop queued-but-unstarted ones."""
        self._cancel_event.set()
        drain_queue_nowait(self._queue)

    async def close(self) -> None:
        """Stop the worker task; called from the connection's ``finally`` block.

        Graceful-first: hard-cancelling ``_worker_task`` immediately (the
        old behavior) can land while ``synth_drain.drain_to_ws`` is awaiting
        ``chunk_queue.get()`` — the cancel stops it calling ``.get()``
        again, so the MLX thread stuck on (or later filling) a bounded
        ``queue.put()`` blocks that job forever. So: set ``cancel_event``,
        keep the active queue drained until the active JOB finishes on the
        shared MLX thread (its ``done`` event), and only then hard-cancel.

        ``_closing`` is set FIRST (before any ``await`` here) so
        ``_run_queue`` can't start a further request once teardown begins —
        else a second queued request submits a fresh job while this polls
        the FIRST (now-stale) one, and the hard-cancel below lands on that
        second, un-cancelled request instead.
        """
        self._closing = True
        drain_queue_nowait(self._queue)
        self._cancel_event.set()
        job = self._active_job
        deadline = time.monotonic() + _CLOSE_WORKER_TIMEOUT_S
        while job is not None and not job.done.is_set() and time.monotonic() < deadline:
            self._drain_active_queue_nowait()
            await asyncio.sleep(_CLOSE_DRAIN_POLL_S)
        self._drain_active_queue_nowait()  # final sweep
        if job is not None and not job.done.is_set():
            log.warning(
                "synth.close_job_stuck timeout_s=%.1f", _CLOSE_WORKER_TIMEOUT_S,
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
        ref_audio_path = self._voice_store.get_or_default(self._voice)
        encoder = make_encoder(self._format, self._sample_rate)
        counter = SampleCounter()
        loop = asyncio.get_running_loop()
        chunk_queue: "asyncio.Queue[Any]" = asyncio.Queue(maxsize=_CHUNK_QUEUE_MAXSIZE)
        job = SynthJob(
            text=text, ref_audio_path=ref_audio_path, lang_code=self._default_lang,
            streaming_interval=self._streaming_interval, cancel_event=cancel_event,
            encoder=encoder, counter=counter, loop=loop, chunk_queue=chunk_queue,
            done=threading.Event(),
        )
        # `close()` reaches these via `_active_*` on an abrupt disconnect;
        # overwritten fresh next request, so a stale ref is harmless.
        self._active_chunk_queue = chunk_queue
        self._active_job = job
        self._executor.submit(job)

        initial_error: BaseException | None = None
        try:
            await send_server_event(self._ws, Started(request_id=request_id), self._conn_log)
        except ConnectionClosed as exc:
            cancel_event.set()
            initial_error = exc

        ttfa_ms, bytes_sent, error = await drain_to_ws(
            self._ws, chunk_queue, t0, cancel_event, initial_error,
        )
        await asyncio.to_thread(job.done.wait, _JOB_DONE_TIMEOUT_S)
        if error is not None:
            raise error

        decode_ms = (time.monotonic() - t0) * 1000.0
        return compute_metrics(
            request_id=request_id, ttfa_ms=ttfa_ms, decode_ms=decode_ms,
            total_samples=counter.total_samples, source_sample_rate=_SOURCE_SAMPLE_RATE,
            bytes_sent=bytes_sent,
        )

    async def _finish_request(self, metrics: Metrics) -> None:
        """Send the ``Done`` event and log the ``local_tts.synthesize`` metrics
        record — field math and record shape live in ``synth_metrics.py``.
        """
        await send_server_event_safe(self._ws, Done(**build_done_fields(metrics)), self._conn_log)
        record = build_synth_record(
            metrics=metrics, voice_id=self._voice, format=self._format, sample_rate=self._sample_rate,
        )
        _safe_log(self._metrics_log, "local_tts.synthesize", **record)
