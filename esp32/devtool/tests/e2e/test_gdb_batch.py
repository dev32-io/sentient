"""e2e parity test for ``esp32-devtool gdb --batch``.

Mirrors `esp32/cube/scripts/gdb-batch.sh`: spawn openocd via idf.py, attach
xtensa-gdb to the cube's built-in USB-Serial-JTAG, dump threads, detach.
JTAG halts the cube for the duration of the gdb session; ``quit`` releases
it. The conftest's auto_recover_per_test fixture verifies the cube comes
back to a normal state afterwards.
"""
from __future__ import annotations

from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"


def test_gdb_batch_dumps_threads(devtool):
    p = devtool("gdb", "--batch", str(FIXTURES / "gdb_thread_dump.gdb"),
                timeout_s=60.0)
    assert p.returncode == 0, f"stderr: {p.stderr[-2000:]}"
    out = p.stdout
    # gdb's "info threads" output uses "Id" + "Target Id" + "Frame" columns;
    # "thread apply all bt 5" produces "Thread N (..." lines + #0..#4 frames.
    assert "Thread" in out or "#0" in out, f"no thread dump:\n{out[:1500]}"
