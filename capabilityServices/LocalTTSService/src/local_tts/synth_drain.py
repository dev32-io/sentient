"""Drains one synthesis request's chunk queue to the WebSocket.

Split out of ``synthesis.py`` (see that module's docstring for the full
three-part concurrency model this is one part of) purely for line-count
hygiene — this function is near-pure (its only external effect is
``ws.send``), so it moves cleanly to a sibling module alongside
``synth_worker.py`` (worker-thread half) and ``synth_metrics.py``
(post-request metrics half).
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

from websockets.exceptions import ConnectionClosed

from .synth_worker import QUEUE_STOP, WorkerFailure


async def drain_to_ws(
    ws: Any, chunk_queue: "asyncio.Queue[Any]", t0: float,
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
            await ws.send(item)
            bytes_sent += len(item)
        except ConnectionClosed as exc:
            cancel_event.set()
            terminal_error = exc
    return ttfa_ms, bytes_sent, (terminal_error or worker_error)
