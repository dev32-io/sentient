"""Parity test: `esp32-devtool logs --source usb` returns ring-buffer lines."""
from __future__ import annotations


def test_logs_ring_returns_recent(devtool):
    """One-shot (no --follow) USB ring fetch — must return recent cube lines.

    The cube logs use the ``sentient.cube.*`` tag hierarchy and the daemon
    additionally surfaces boundary markers (``<<<`` RSP/EVT) when verbs run.
    We accept any of these as a signal of usable content.
    """
    p = devtool("logs", "--source", "usb", "--lines", "100", timeout_s=15.0)
    assert p.returncode == 0, (
        f"esp32-devtool logs exited {p.returncode}\n"
        f"stdout: {p.stdout[:500]}\nstderr: {p.stderr[:500]}"
    )
    assert (
        "sentient.cube" in p.stdout
        or "[usb" in p.stdout
        or "<<<" in p.stdout
    ), f"no usable log content: {p.stdout[:500]}"
