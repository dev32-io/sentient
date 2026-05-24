"""Auto-recovery utilities for unattended e2e parity tests."""
from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path


READY_TIMEOUT_S = 30.0
FLASH_RETRY_MAX = 1  # one reflash; then bail

# Absolute path so recovery helpers work regardless of PATH.
_DEVTOOL_BIN = str(Path(__file__).resolve().parents[2] / "bin" / "esp32-devtool")


@dataclass
class CubeHealth:
    responsive: bool
    info: dict | None
    ring_tail: str


def _run(cmd: list[str], *, timeout_s: float = 10.0) -> tuple[int, str, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout_s}s"


def cube_is_responsive(timeout_s: float = 3.0) -> bool:
    rc, _, _ = _run([_DEVTOOL_BIN, "cmd", "state"], timeout_s=timeout_s)
    return rc == 0


def cube_info() -> dict | None:
    rc, out, _ = _run([_DEVTOOL_BIN, "--json", "info"], timeout_s=5.0)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def dump_ring(lines: int = 200) -> str:
    rc, out, _ = _run(
        [_DEVTOOL_BIN, "daemon", "ring", "--port", "/dev/cu.usbmodem101",
         "--lines", str(lines)],
        timeout_s=5.0,
    )
    return out if rc == 0 else "<ring unavailable>"


def attempt_soft_recovery() -> bool:
    rc, _, _ = _run([_DEVTOOL_BIN, "restart"], timeout_s=10.0)
    if rc != 0:
        return False
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        if cube_is_responsive(timeout_s=2.0):
            return True
        time.sleep(1.0)
    return False


def attempt_hard_recovery() -> bool:
    rc, _, _ = _run([_DEVTOOL_BIN, "flash", "--profile", "debug"],
                    timeout_s=180.0)
    if rc != 0:
        return False
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        if cube_is_responsive(timeout_s=2.0):
            return True
        time.sleep(2.0)
    return False


def ensure_healthy() -> CubeHealth:
    """Auto-recover. Raise if hard-recovery also fails (AXP2101 fault signature)."""
    if cube_is_responsive():
        return CubeHealth(True, cube_info(), "")

    if attempt_soft_recovery():
        return CubeHealth(True, cube_info(), "recovered via restart verb")

    if attempt_hard_recovery():
        return CubeHealth(True, cube_info(), "recovered via reflash")

    ring = dump_ring(500)
    raise RuntimeError(
        "cube unresponsive after restart + reflash; AXP2101 fault likely. "
        "PHYSICAL RECOVERY REQUIRED: unplug + hold BOOT + replug.\n"
        f"Last 500 ring lines:\n{ring}"
    )
