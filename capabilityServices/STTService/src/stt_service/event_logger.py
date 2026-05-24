"""Structured JSONL logging for the STT service.

Two log streams, both persisted to the mounted logs volume:

- ``service.jsonl`` — coarse service events (startup, connection
  open/close, errors). One JSON object per line.
- ``conn_<id>.jsonl`` — per-connection fine-grained event trace (every
  VAD transition, every Smart-Turn evaluation, every frame delivery
  back to the client). One JSON object per line.

Each event carries both a monotonic timestamp (``t_mono_ns``) for
computing latency deltas and a wall-clock ISO-8601 timestamp (``ts``)
for humans.

Python note — ``threading.Lock``:
  A ``Lock`` ensures that at most one thread can execute the code inside
  ``with self._lock:`` at a time. In Kotlin you'd use ``synchronized {}``
  or ``Mutex`` from coroutines. We need this because the Python ``wave``
  module uses the GIL for thread safety, but file writes can interleave
  on line boundaries without explicit locking. The ``with`` statement
  guarantees the lock is released even if an exception occurs — just
  like Kotlin's ``use {}`` for Closeable resources.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def _now() -> tuple[str, int]:
    """Return ``(iso_utc, monotonic_ns)`` — wall clock + relative clock.

    Two clocks because they serve different purposes:
    - Wall clock (``ts``) tells you WHEN something happened in human time.
    - Monotonic clock (``t_mono_ns``) tells you HOW LONG things took.
      Unlike wall clock it never jumps backward (NTP adjustments, DST).
    """
    return (
        datetime.now(timezone.utc).isoformat(timespec="microseconds"),
        time.monotonic_ns(),
    )


class JsonlLogger:
    """Append-only JSON-lines writer with thread-safe flush.

    One instance per log file. Writing is synchronous — this is fine for
    a single-client service at audio rates (<100 events/sec) and avoids
    the need for a background flush thread.

    Python note — ``buffering=1``:
      This tells Python to flush the write buffer after every newline,
      so a ``tail -f service.jsonl`` on the host sees events in real
      time without waiting for the OS buffer to fill. Equivalent to
      Kotlin's ``BufferedWriter`` with auto-flush.
    """

    def __init__(self, path: Path, *, echo_stdout: bool = False) -> None:
        self._path = path
        self._echo = echo_stdout
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fp = path.open("a", encoding="utf-8", buffering=1)

    @property
    def path(self) -> Path:
        """The filesystem path of the log file.

        Python note — ``@property``:
          This decorator turns a method into a read-only attribute.
          ``logger.path`` reads like a field access, but actually calls
          this method. It's Python's equivalent of a Kotlin ``val``
          property with a custom getter: ``val path: Path get() = _path``.
        """
        return self._path

    def log(self, event: str, **fields: Any) -> None:
        """Append one JSON line to the log file.

        ``**fields`` is Python's "keyword arguments" syntax — the caller
        can pass any number of ``key=value`` pairs and they arrive as a
        dictionary. Example: ``logger.log("vad.start", turn_idx=5)``
        puts ``{"turn_idx": 5}`` into ``fields``. Kotlin's closest
        equivalent is ``vararg`` but for named params you'd typically
        pass a ``Map<String, Any>``.
        """
        ts, mono = _now()
        record: dict[str, Any] = {
            "ts": ts,
            "t_mono_ns": mono,
            "event": event,
        }
        record.update(fields)
        line = json.dumps(record, separators=(",", ":"), default=_json_default)
        with self._lock:
            self._fp.write(line)
            self._fp.write("\n")
        if self._echo:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def close(self) -> None:
        """Flush and close the underlying file handle."""
        with self._lock:
            if not self._fp.closed:
                self._fp.flush()
                self._fp.close()


def _default_clock() -> datetime:
    """Module-level callable so tests can substitute a stub via dependency injection."""
    return datetime.now(timezone.utc)


class RotatingJsonlLogger:
    """JSON-lines writer that rolls over daily by UTC date.

    The active filename is ``<dir>/<YYYY-MM-DD>-<basename>.jsonl``. The
    date is checked on every ``log()`` call; when it changes, the
    current file handle is closed and a new one is opened. The check is
    a single string comparison — cheap enough to run per-write at audio
    rates (10s–100s/sec) without a background timer thread.

    The ``clock`` parameter is a callable returning a UTC ``datetime``.
    Tests pass a stub; production code uses ``_default_clock``.
    """

    def __init__(
        self,
        basename: str,
        log_dir: Path,
        *,
        echo_stdout: bool = False,
        clock: Callable[[], datetime] = _default_clock,
    ) -> None:
        self._basename = basename
        self._dir = log_dir
        self._echo = echo_stdout
        self._clock = clock
        self._lock = threading.Lock()
        log_dir.mkdir(parents=True, exist_ok=True)
        self._date: str = ""
        self._fp = None  # type: ignore[assignment]
        self._closed = False

    def _path_for(self, date_str: str) -> Path:
        return self._dir / f"{date_str}-{self._basename}.jsonl"

    def _ensure_active_file(self, date_str: str) -> None:
        """Open the file for `date_str`, closing any previous handle. Caller holds the lock."""
        if self._fp is not None and not self._fp.closed:
            self._fp.flush()
            self._fp.close()
        self._fp = self._path_for(date_str).open("a", encoding="utf-8", buffering=1)
        self._date = date_str

    def log(self, event: str, **fields: Any) -> None:
        """Append one JSON line to today's log file. No-op after close()."""
        ts, mono = _now()
        record: dict[str, Any] = {
            "ts": ts,
            "t_mono_ns": mono,
            "event": event,
        }
        record.update(fields)
        line = json.dumps(record, separators=(",", ":"), default=_json_default)

        date_str = self._clock().strftime("%Y-%m-%d")

        with self._lock:
            if self._closed:
                return
            if date_str != self._date:
                self._ensure_active_file(date_str)
            assert self._fp is not None  # narrows for mypy / type checkers
            self._fp.write(line)
            self._fp.write("\n")

        if self._echo:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def close(self) -> None:
        """Flush and close the underlying file handle. Idempotent."""
        with self._lock:
            self._closed = True
            if self._fp is not None and not self._fp.closed:
                self._fp.flush()
                self._fp.close()


def _json_default(value: Any) -> Any:
    """Fallback JSON encoder for numpy scalars and bytes lengths.

    ``json.dumps`` calls this function for any value it doesn't know
    how to serialize. We convert numpy scalars to native Python types
    and bytes objects to their length (we don't want to base64-encode
    megabytes of audio into a log line).
    """
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            pass
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"__bytes_len__": len(value)}
    return repr(value)


ONE_DAY_SECONDS = 24 * 60 * 60


def prune_old_logs(log_dir: Path, retention_days: int) -> None:
    """Delete ``*.jsonl`` files in ``log_dir`` older than ``retention_days``.

    No-op when ``retention_days <= 0`` or when the directory does not
    exist. Per-file failures (permission denied, file vanished mid-stat)
    are swallowed so one bad file never aborts the pass.
    """
    if retention_days <= 0:
        return
    cutoff = time.time() - retention_days * ONE_DAY_SECONDS

    try:
        entries = list(log_dir.glob("*.jsonl"))
    except OSError:
        return

    for entry in entries:
        try:
            if entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            continue
