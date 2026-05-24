"""Live CPU / memory sampler for the PoC service.

Samples the process (not the host) at a fixed cadence and writes one JSONL
record per sample to ``metrics.jsonl`` on the mounted logs volume. These
numbers are what you want when benchmarking the Silero+Smart-Turn impact on
an RPi5 — ``psutil.Process()`` reads ``/proc/self/*``, which reports this
container's own usage regardless of cgroup visibility quirks.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import psutil

from .event_logger import JsonlLogger


class MetricsSampler:
    """Background asyncio task that periodically logs process metrics."""

    def __init__(
        self,
        logs_dir: Path,
        *,
        interval_ms: int,
    ) -> None:
        self._interval = interval_ms / 1000.0
        self._proc = psutil.Process(os.getpid())
        # Prime cpu_percent so the first real reading is non-zero.
        self._proc.cpu_percent(None)
        self._logger = JsonlLogger(logs_dir / "metrics.jsonl", echo_stdout=False)
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name="metrics-sampler")

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        self._logger.close()

    async def _run(self) -> None:
        while not self._stop_event.is_set():
            self._log_sample()
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self._interval,
                )
            except asyncio.TimeoutError:
                continue
            else:
                break

    def _log_sample(self) -> None:
        try:
            with self._proc.oneshot():
                rss_mb = self._proc.memory_info().rss / (1024 * 1024)
                cpu_pct = self._proc.cpu_percent(None)
                num_threads = self._proc.num_threads()
                num_fds = self._proc.num_fds() if hasattr(self._proc, "num_fds") else None
        except psutil.NoSuchProcess:  # pragma: no cover — shutting down
            return

        # System context (host-wide in a container, but still useful as a
        # relative signal for load during the benchmark run).
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
