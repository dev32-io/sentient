"""Entry point for ``python -m stt_service``.

Python note — ``__main__.py``:
  When you run ``python -m stt_service``, Python:
  1. Finds the ``stt_service`` package on ``PYTHONPATH``.
  2. Imports ``stt_service/__init__.py`` (package init).
  3. Executes ``stt_service/__main__.py`` (this file).

  This is similar to declaring an entry point in ``AndroidManifest.xml``
  or having a ``fun main()`` in a Kotlin file — it's the "start here"
  marker for the runtime.

  The actual server logic lives in ``server.py``. This file is
  intentionally minimal — its only job is to wire up config, logging,
  and call ``asyncio.run()`` to start the async event loop.

Python note — ``asyncio.run()``:
  This is the bridge between sync and async Python. It creates a new
  event loop, runs the given coroutine until it completes, then cleans
  up. Think of it as Kotlin's ``runBlocking { ... }`` — it blocks the
  calling thread until all async work finishes. You call it ONCE at
  the top of your program; everything inside uses ``await``.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from .config import load_config
from .event_logger import prune_old_logs
from .server import run_server


def main() -> None:
    """Load config, set up logging, start the async server."""

    # Read container-internal paths from environment variables set in
    # the Dockerfile. These are NOT in config.yaml — see config.py
    # docstring for the rationale.
    config_path = Path(os.environ.get("STT_CONFIG_PATH", "/app/config/config.yaml"))
    model_dir = Path(os.environ.get("STT_MODEL_DIR", "/app/models"))
    log_dir = Path(os.environ.get("STT_LOG_DIR", "/app/logs"))
    recording_dir = Path(os.environ.get("STT_RECORDING_DIR", "/app/data/recordings"))

    config = load_config(
        config_path,
        model_dir=model_dir,
        log_dir=log_dir,
        recording_dir=recording_dir,
    )

    # Ensure the log dir exists, then prune anything older than the
    # configured retention window before we start writing new files.
    log_dir.mkdir(parents=True, exist_ok=True)
    prune_old_logs(log_dir, config.logging.retention_days)

    # Configure Python's built-in logging. This controls what appears
    # in ``docker logs stt-service``. The JSONL structured logs
    # (service.jsonl, conn_*.jsonl, metrics.jsonl) are separate and
    # always capture everything.
    logging.basicConfig(
        level=getattr(logging, config.logging.level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    asyncio.run(run_server(config))


# Python note — ``if __name__ == "__main__":``:
#   This guard ensures ``main()`` only runs when the file is executed
#   directly (``python __main__.py`` or ``python -m stt_service``),
#   not when it's imported by another module. It's a universal Python
#   convention — every executable script has this guard. There's no
#   Kotlin equivalent because Kotlin's ``fun main()`` is always the
#   entry point by declaration, not by runtime check.
if __name__ == "__main__":
    main()
