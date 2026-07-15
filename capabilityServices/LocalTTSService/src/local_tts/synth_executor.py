"""Single process-wide MLX synthesis thread.

MLX (>= 0.31.2, this service runs 0.32.0) makes Metal GPU streams
**thread-local**, and each array's stream affinity is bound at allocation
time — an array allocated on one thread cannot be ``mx.eval``'d on
another (ml-explore/mlx #3281, #3529; mirrored by mlx-lm #1256 and
vllm-mlx #407). The Qwen model's weights are materialized when the model
is loaded and warmed, so EVERY ``generate()``/``eval()`` afterwards must
run on that same thread — otherwise MLX raises ``There is no
Stream(gpu, N) in current thread``. It surfaces intermittently: stream
ids accumulate as short-lived threads come and go, and eventually an
array bound to a dead thread's ``Stream(gpu, N)`` gets eval'd elsewhere.

The prior design span a fresh ``threading.Thread`` per synthesis request,
which tripped exactly this once the service had served a handful of
requests. Fix: one long-lived daemon thread owns ALL MLX work — it warms
the model on itself (so the weights' stream affinity lives here), then
pulls jobs off a thread-safe queue and runs each through
``synth_worker.produce_chunks`` on that same thread. Synthesis is already
globally serialized (``synthesis.py``'s shared lock admits one request at
a time), so a single worker is the natural design, not a bottleneck.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .synth_worker import produce_chunks

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .engine import QwenEngine  # heavy import cost for non-live tests.

log = logging.getLogger("local_tts.synth_executor")

# Queued in place of a job to tell the worker thread to exit its loop.
_SHUTDOWN = None


@dataclass
class SynthJob:
    """One synthesis request handed to the MLX thread.

    Mirrors ``synth_worker.produce_chunks``'s arguments (minus the engine,
    which the executor owns). ``done`` is set once ``produce_chunks``
    returns — success, worker failure, or cancel — so the event-loop side
    can wait on it in place of joining a per-request thread.
    """

    text: str
    ref_audio_path: str | None
    lang_code: str
    streaming_interval: float
    cancel_event: threading.Event
    encoder: Any
    counter: Any
    loop: asyncio.AbstractEventLoop
    chunk_queue: "asyncio.Queue[Any]"
    done: threading.Event


class SynthExecutor:
    """Owns the MLX engine and the single thread all its work runs on."""

    def __init__(self, engine: "QwenEngine") -> None:
        self._engine = engine
        self._jobs: "queue.Queue[SynthJob | None]" = queue.Queue()
        self._thread = threading.Thread(
            target=self._run, name="tts-mlx-worker", daemon=True
        )
        self._warm_done = threading.Event()
        self._warm_error: BaseException | None = None

    def start_and_warm(self) -> None:
        """Start the MLX thread and block until the model is warmed ON IT.

        Fail-closed: re-raises any warm error on the caller (startup)
        thread, so ``__main__`` aborts before the server accepts a single
        connection — matching the prior ``engine.warm()`` contract.
        """
        self._thread.start()
        self._warm_done.wait()
        if self._warm_error is not None:
            raise self._warm_error

    def submit(self, job: SynthJob) -> None:
        """Queue a job for the MLX thread (non-blocking).

        The shared synth lock upstream admits one request at a time, so
        the queue depth stays ~1 — this queue is the thread hand-off, not
        a concurrency buffer.
        """
        self._jobs.put(job)

    def shutdown(self) -> None:
        """Signal the MLX thread to exit after its current job.

        Best-effort: it's a daemon thread, reaped on process exit
        regardless — this just lets it stop cleanly on graceful shutdown.
        """
        self._jobs.put(_SHUTDOWN)

    def _run(self) -> None:
        """The MLX thread body: warm once, then process jobs until shutdown."""
        if not self._warm_on_thread():
            return
        while True:
            job = self._jobs.get()
            if job is _SHUTDOWN:
                log.info("synth_executor.shutdown")
                return
            self._run_job(job)

    def _warm_on_thread(self) -> bool:
        """Warm the model on THIS thread so its weights' stream affinity lives
        here. Records any failure for ``start_and_warm`` to re-raise; returns
        ``False`` (stopping the loop) on failure.
        """
        try:
            self._engine.warm()
        except BaseException as exc:  # noqa: BLE001 - relayed to the startup thread
            self._warm_error = exc
            self._warm_done.set()
            log.error("synth_executor.warm_failed error=%r", exc)
            return False
        self._warm_done.set()
        return True

    def _run_job(self, job: SynthJob) -> None:
        """Run one job's blocking MLX synthesis on this thread; always set
        ``done`` so the event-loop side never waits forever.
        """
        try:
            produce_chunks(
                self._engine,
                job.text,
                job.ref_audio_path,
                job.lang_code,
                job.streaming_interval,
                job.cancel_event,
                job.encoder,
                job.counter,
                job.loop,
                job.chunk_queue,
            )
        finally:
            job.done.set()
