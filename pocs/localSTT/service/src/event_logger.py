"""Structured JSONL logging for the PoC service.

Two log streams, both persisted to the mounted /app/logs volume:

- ``service.jsonl`` — coarse service events (startup, connection open/close,
  errors). One JSON object per line.
- ``conn_<id>.jsonl`` — per-connection fine-grained event trace (every VAD
  transition, every Smart-Turn evaluation, every frame delivery back to the
  client). One JSON object per line.

Each event carries both a monotonic timestamp (``t_mono_ns``) for computing
latency deltas and a wall-clock ISO-8601 timestamp (``ts``) for humans.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> tuple[str, int]:
    """Return ``(iso_utc, monotonic_ns)`` — wall clock + relative clock."""
    return (
        datetime.now(timezone.utc).isoformat(timespec="microseconds"),
        time.monotonic_ns(),
    )


class JsonlLogger:
    """Append-only JSON-lines writer with thread-safe flush.

    One instance per log file. Writing is synchronous — this is fine for a
    single-client PoC at audio rates (<100 events/sec) and eliminates the
    need for a background flush thread.
    """

    def __init__(self, path: Path, *, echo_stdout: bool = False) -> None:
        self._path = path
        self._echo = echo_stdout
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        # ``buffering=1`` → line-buffered in text mode, so a tail -f sees
        # events as they happen even without an explicit flush.
        self._fp = path.open("a", encoding="utf-8", buffering=1)

    @property
    def path(self) -> Path:
        return self._path

    def log(self, event: str, **fields: Any) -> None:
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
        with self._lock:
            if not self._fp.closed:
                self._fp.flush()
                self._fp.close()


def _json_default(value: Any) -> Any:
    """Fallback JSON encoder for numpy scalars and bytes lengths."""
    # Numpy scalars: expose as native Python scalars.
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:  # pragma: no cover — defensive
            pass
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"__bytes_len__": len(value)}
    return repr(value)
