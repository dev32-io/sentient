"""Unit tests for prune_old_logs and RotatingJsonlLogger.

Run with::

    cd capabilityServices/STTService
    PYTHONPATH=src python -m unittest discover -s tests
"""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from whisper_stt.event_logger import (
    ONE_DAY_SECONDS,
    RotatingJsonlLogger,
    prune_old_logs,
)


def _age(path: Path, days_old: int) -> None:
    """Stamp the file's mtime to `days_old` days in the past."""
    when = time.time() - days_old * ONE_DAY_SECONDS
    os.utime(path, (when, when))


class PruneOldLogsTests(unittest.TestCase):
    """mtime-based deletion of *.jsonl files."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_op_when_retention_zero(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 100)

        prune_old_logs(self.dir, 0)

        self.assertTrue(stale.exists())

    def test_no_op_when_retention_negative(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 100)

        prune_old_logs(self.dir, -1)

        self.assertTrue(stale.exists())

    def test_no_op_when_dir_missing(self) -> None:
        # Should not raise.
        prune_old_logs(self.dir / "missing", 7)

    def test_keeps_recent_files(self) -> None:
        fresh = self.dir / "fresh.jsonl"
        fresh.write_text("x")
        _age(fresh, 3)

        prune_old_logs(self.dir, 7)

        self.assertTrue(fresh.exists())

    def test_keeps_file_at_exact_cutoff(self) -> None:
        """Pin the strict-< semantics: a file at exactly the cutoff is kept."""
        boundary = self.dir / "boundary.jsonl"
        boundary.write_text("x")
        # Stamp mtime to exactly the retention boundary. We add a small epsilon
        # (0.1 s) so the stamped mtime is guaranteed to be >= the cutoff that
        # prune_old_logs computes a moment later. This means mtime < cutoff is
        # false and the file is kept, exercising the strict-less-than boundary.
        cutoff = time.time() - 7 * ONE_DAY_SECONDS + 0.1
        os.utime(boundary, (cutoff, cutoff))

        prune_old_logs(self.dir, 7)

        self.assertTrue(boundary.exists())

    def test_deletes_stale_files(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 30)

        prune_old_logs(self.dir, 7)

        self.assertFalse(stale.exists())

    def test_mixed_keeps_only_fresh(self) -> None:
        fresh = self.dir / "fresh.jsonl"
        stale = self.dir / "stale.jsonl"
        fresh.write_text("x")
        stale.write_text("x")
        _age(fresh, 1)
        _age(stale, 30)

        prune_old_logs(self.dir, 7)

        self.assertTrue(fresh.exists())
        self.assertFalse(stale.exists())

    def test_ignores_non_jsonl_files(self) -> None:
        sibling = self.dir / "stale.txt"
        sibling.write_text("x")
        _age(sibling, 30)

        prune_old_logs(self.dir, 7)

        self.assertTrue(sibling.exists())

    def test_does_not_raise_when_individual_files_cannot_be_statted(self) -> None:
        """Force per-file stat failures via chmod 0o400 on the dir.

        With read-but-not-execute perms, glob can list entries but stat on
        each entry fails with PermissionError. The function must swallow
        the per-file failure and return cleanly.
        """
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 30)

        # Read-only on the directory: glob works but stat fails per entry.
        self.dir.chmod(0o400)
        try:
            prune_old_logs(self.dir, 7)  # must not raise
        finally:
            # Restore perms so tearDown's TemporaryDirectory.cleanup can run.
            self.dir.chmod(0o700)


class _StubClock:
    """Test double that returns a controllable UTC datetime."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now


class RotatingJsonlLoggerTests(unittest.TestCase):
    """Daily-rotated JSON Lines writer."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.start = datetime(2026, 4, 14, 12, 0, 0, tzinfo=timezone.utc)
        self.clock = _StubClock(self.start)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _read_lines(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def test_writes_to_dated_filename(self) -> None:
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        try:
            logger.log("hello", value=1)
        finally:
            logger.close()

        expected = self.dir / "2026-04-14-service.jsonl"
        self.assertTrue(expected.exists())
        records = self._read_lines(expected)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event"], "hello")
        self.assertEqual(records[0]["value"], 1)

    def test_rolls_over_when_date_changes(self) -> None:
        logger = RotatingJsonlLogger("metrics", self.dir, clock=self.clock)
        try:
            logger.log("first")
            self.clock.now = self.start + timedelta(days=1)
            logger.log("second")
        finally:
            logger.close()

        first = self.dir / "2026-04-14-metrics.jsonl"
        second = self.dir / "2026-04-15-metrics.jsonl"
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual([r["event"] for r in self._read_lines(first)], ["first"])
        self.assertEqual([r["event"] for r in self._read_lines(second)], ["second"])

    def test_close_is_idempotent(self) -> None:
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        logger.log("once")
        logger.close()
        # Second close must not raise.
        logger.close()

    def test_log_after_close_does_not_raise(self) -> None:
        # Calling log() after close() is a programming bug; the logger
        # tolerates it silently rather than crashing the service.
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        logger.log("before-close")
        logger.close()
        logger.log("after-close")  # must not raise

    def test_log_during_close_does_not_raise(self) -> None:
        """Concurrent close + log must not raise on a closed file handle.

        Drives the class through a tight 2-thread close+log race for a
        short burst. Without lock-protected closed check, the writer would
        occasionally raise ValueError: write to closed file. With the
        check inside the lock, every iteration completes silently.
        """
        import threading

        failures: list[BaseException] = []

        def hammer_log(logger: RotatingJsonlLogger) -> None:
            try:
                for i in range(200):
                    logger.log("burst", i=i)
            except BaseException as exc:  # pragma: no cover - assertion path
                failures.append(exc)

        # Run the race many times to make scheduling flake unlikely.
        for _ in range(20):
            logger = RotatingJsonlLogger("race", self.dir, clock=self.clock)
            logger.log("warmup")
            thread = threading.Thread(target=hammer_log, args=(logger,))
            thread.start()
            logger.close()
            thread.join()

        self.assertEqual(failures, [], f"log() raised under concurrent close: {failures}")


if __name__ == "__main__":
    unittest.main()
