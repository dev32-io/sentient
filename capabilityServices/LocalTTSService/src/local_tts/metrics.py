"""Live CPU / memory sampler for the local-tts service.

Samples the process (not the host) at a fixed cadence and writes one
JSONL record per sample to ``metrics.jsonl`` under ``config.log_dir``.
These numbers let you benchmark the MLX/Metal synthesis workload's
resource footprint on the Mac mini — ``psutil.Process()`` reads
``/proc/self/*``, which reports this process's own usage.

Python note — ``asyncio.create_task``:
  This is how you launch a "background coroutine" that runs concurrently
  with the main event loop. Closest Kotlin analogue: ``launch { ... }``
  inside a CoroutineScope — it starts a new coroutine that runs in the
  background until cancelled or completed.

Python note — ``asyncio.Event``:
  An ``Event`` is a boolean flag that coroutines can wait on. Think of
  it like a Kotlin ``CompletableDeferred<Unit>()`` — you ``set()`` it
  from one coroutine and ``await event.wait()`` in another.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import psutil

from .event_logger import RotatingJsonlLogger


class MetricsSampler:
    """Background asyncio task that periodically logs process metrics."""

    def __init__(self, logs_dir: Path, *, interval_ms: int) -> None:
        self._interval = interval_ms / 1000.0
        self._enabled = interval_ms > 0
        self._proc = psutil.Process(os.getpid())
        # Prime cpu_percent so the first real reading is non-zero.
        # psutil needs a "baseline" measurement to compute the delta.
        self._proc.cpu_percent(None)
        self._logger = RotatingJsonlLogger(
            "metrics", logs_dir, echo_stdout=False,
        )
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        """Start the background sampling loop. No-op if disabled or already started."""
        if not self._enabled or self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="metrics-sampler")

    async def stop(self) -> None:
        """Signal the background loop to stop and wait for it to finish."""
        self._stop_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        self._logger.close()

    async def _run(self) -> None:
        """Main loop: sample, sleep, repeat until stopped."""
        while not self._stop_event.is_set():
            self._log_sample()
            try:
                # ``wait_for`` with a timeout acts like "sleep, but
                # wake up early if someone calls stop_event.set()".
                # This is more responsive than a plain ``asyncio.sleep``
                # because the loop exits immediately on shutdown rather
                # than waiting for the full sleep interval to elapse.
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._interval,
                )
            except asyncio.TimeoutError:
                continue
            else:
                break

    def _log_sample(self) -> None:
        """Take one snapshot of CPU, memory, threads, and file descriptors."""
        try:
            # ``oneshot()`` is a context manager that batches the
            # /proc reads into a single system call. Without it,
            # each ``memory_info()``, ``cpu_percent()``, etc. would
            # be a separate read — measurably slower under load.
            with self._proc.oneshot():
                rss_mb = self._proc.memory_info().rss / (1024 * 1024)
                cpu_pct = self._proc.cpu_percent(None)
                num_threads = self._proc.num_threads()
                num_fds = (
                    self._proc.num_fds()
                    if hasattr(self._proc, "num_fds")
                    else None
                )
        except psutil.NoSuchProcess:
            return

        load1, load5, load15 = psutil.getloadavg()
        vmem = psutil.virtual_memory()

        self._logger.log(
            "metrics.sample",
            rss_mb=round(rss_mb, 2),
            cpu_percent=round(cpu_pct, 2),
            num_threads=num_threads,
            num_fds=num_fds,
            host_loadavg_1m=round(load1, 2),
            host_loadavg_5m=round(load5, 2),
            host_loadavg_15m=round(load15, 2),
            host_mem_used_percent=round(vmem.percent, 2),
            host_mem_available_mb=round(vmem.available / (1024 * 1024), 2),
        )
