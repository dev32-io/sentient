"""HIL fixtures.

`cube_port` resolves the cube's USB-CDC port via glob (`/dev/cu.usbmodem*`) and
passes it explicitly to `CubeDut` + `SerialDut`. We don't rely on the
devtool's internal auto-detect because the HIL `.venv` doesn't have the full
devtool CLI env — the devtool binary itself is invoked via `uv run --script`
so the path resolution is fine, but explicit `--port` avoids re-scanning per
verb call.
"""
from __future__ import annotations

import glob
import re
import time
from pathlib import Path

import pytest
import serial

from cube_dut import CUBE_DIR, CubeDut


class SerialDut:
    """Tail-and-expect wrapper over a pyserial connection.

    Avoids pytest-embedded's flash/reset machinery — we expect the cube
    to already be running. Tests issue verbs via CubeDut.cmd(); checkpoints
    are read via SerialDut.expect().
    """

    def __init__(self, port: str) -> None:
        self.port = port
        self._serial = serial.Serial(port, 115200, timeout=0.2)
        self._buf: list[str] = []

    def expect(self, pattern, timeout: float = 10.0):
        compiled = pattern if hasattr(pattern, "search") else re.compile(pattern)
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self._serial.readline()
            if not line:
                continue
            try:
                d = line.decode("utf-8", errors="replace").rstrip()
            except UnicodeDecodeError:
                continue
            self._buf.append(d)
            m = compiled.search(d)
            if m is not None:
                return m
        raise AssertionError(
            f"timeout waiting for {pattern!r}; last lines: {self._buf[-5:]}"
        )

    def close(self) -> None:
        try:
            self._serial.close()
        except Exception:
            pass


@pytest.fixture(scope="session")
def cube_port() -> str:
    """Detect /dev/cu.usbmodem* once for the session.

    Globbing here (not delegating to `esp32-devtool info`) keeps the fixture
    fast and dependency-light — `info` would require WiFi-up and an extra
    daemon RTT just to learn the port we can see directly via /dev.
    """
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not candidates:
        raise RuntimeError(
            "no /dev/cu.usbmodem* device found. Plug in cube via USB-C."
        )
    if len(candidates) > 1:
        # Same disambiguation policy as scripts/find-port.sh — first wins.
        # If this fires in practice, pass --port via env to disambiguate.
        pass
    return candidates[0]


@pytest.fixture(scope="session")
def serial_dut(cube_port):
    """Serial tail-and-expect fixture. Do NOT use alongside cube_dut.cmd() in
    the same test — they would fight for the same port. Use serial_dut only in
    tests that exclusively read (group_b/c checkpoint/event tests).
    """
    dut = SerialDut(cube_port)
    yield dut
    dut.close()


@pytest.fixture(scope="session")
def cube_dut(cube_port) -> CubeDut:
    """CubeDut fixture for sending JSON-RPC verbs via `esp32-devtool` subprocess.

    Intentionally does NOT depend on serial_dut — each cmd() shells out to the
    devtool, which talks to the port-holding daemon over Unix socket, so it
    never conflicts with serial_dut's persistent pyserial connection.
    """
    return CubeDut(None, cube_port)


@pytest.fixture(scope="session")
def gateway_logs():
    repo_root = CUBE_DIR.parents[1]
    today = time.strftime("%Y-%m-%d")
    log_path = repo_root / "gateway" / "logs" / f"cube-cube-001-{today}.log"

    class GatewayLogs:
        def grep(self, pattern: str, *, since_pos: int = 0) -> list[str]:
            if not log_path.exists():
                return []
            with open(log_path) as f:
                f.seek(since_pos)
                return [ln for ln in f if pattern in ln]

        def position(self) -> int:
            return log_path.stat().st_size if log_path.exists() else 0

    return GatewayLogs()
