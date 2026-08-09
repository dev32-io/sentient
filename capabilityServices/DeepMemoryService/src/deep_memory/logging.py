"""Tagged logging for the deep-memory service.

Every module gets its logger through :func:`get_logger`, which namespaces it
under ``deep_memory.*`` so the tag reflects the file's position in the
hierarchy (mirrors the gateway's tagged-logger convention).

**Content discipline.** This service holds raw per-user memory text. NOTHING in
this codebase logs entry text, search queries, or any memory content at ANY
level — only ids, kinds, counts, statuses, and scope ids. Helpers here take
counts/ids, never bodies.

Naming note: this file is ``deep_memory.logging``. A bare ``import logging``
anywhere (including inside this file) is an *absolute* import that resolves to
the stdlib module, never to this one — so there is no shadowing hazard. We
alias it ``std_logging`` here only for reading clarity.
"""

from __future__ import annotations

import logging as std_logging
import time
from pathlib import Path

_ROOT_TAG = "deep_memory"

# Line format for stdout — matches the sibling native services.
_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

# How old (seconds) a *.log file must be before startup pruning removes it,
# per configured retention_days. One day in seconds.
_SECONDS_PER_DAY = 86400


def get_logger(name: str) -> std_logging.Logger:
    """Return the service logger for ``name`` (namespaced under ``deep_memory``)."""
    return std_logging.getLogger(f"{_ROOT_TAG}.{name}")


def configure_logging(level: str, log_dir: Path | None, retention_days: int) -> None:
    """Configure stdout (and optional file) logging for the whole service.

    ``level`` is one of ``debug|info|warning|error`` (case-insensitive). When
    ``log_dir`` is given, a daily-rotated file handler is added and stale files
    beyond ``retention_days`` are pruned first.
    """
    resolved_level = getattr(std_logging, level.upper(), std_logging.INFO)
    handlers: list[std_logging.Handler] = [std_logging.StreamHandler()]

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        prune_old_logs(log_dir, retention_days)
        day = time.strftime("%Y-%m-%d")
        handlers.append(std_logging.FileHandler(log_dir / f"{day}.log", encoding="utf-8"))

    formatter = std_logging.Formatter(_LOG_FORMAT)
    for handler in handlers:
        handler.setFormatter(formatter)

    root = std_logging.getLogger(_ROOT_TAG)
    root.setLevel(resolved_level)
    root.handlers.clear()
    for handler in handlers:
        root.addHandler(handler)
    # Don't propagate to the Python root logger — we own our handlers.
    root.propagate = False


def prune_old_logs(log_dir: Path, retention_days: int) -> None:
    """Delete ``*.log`` files older than ``retention_days`` (0 disables)."""
    if retention_days <= 0 or not log_dir.is_dir():
        return
    cutoff = time.time() - retention_days * _SECONDS_PER_DAY
    for entry in log_dir.glob("*.log"):
        try:
            if entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            # A file that vanished or can't be removed is not worth crashing over.
            pass
