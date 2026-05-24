"""e2e parity test fixtures. Fully unattended — auto-recover on every signal of trouble."""
from __future__ import annotations

import glob
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Generator

import pytest

# Ensure cli/ is importable for direct calls (tests use the CLI binary too).
DEVTOOL_ROOT = Path(__file__).resolve().parents[2]
if str(DEVTOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(DEVTOOL_ROOT))

# Absolute path to the esp32-devtool wrapper script. Used by the `devtool`
# fixture so tests don't depend on the binary being on PATH.
_DEVTOOL_BIN = str(DEVTOOL_ROOT / "bin" / "esp32-devtool")

from tests.e2e.recovery import (  # noqa: E402
    cube_info,
    cube_is_responsive,
    dump_ring,
    ensure_healthy,
)


@pytest.fixture(scope="session", autouse=True)
def cube_ready() -> Generator[dict, None, None]:
    """Once-per-session readiness gate + final teardown."""
    try:
        health = ensure_healthy()
    except RuntimeError as e:
        pytest.exit(str(e), returncode=4)
    yield health.info or {}
    # Final teardown: nothing — daemon idles itself.


@pytest.fixture(autouse=True)
def auto_recover_per_test(request) -> Generator[None, None, None]:
    """Per-test: pre-check responsiveness; on test failure, dump diagnostics."""
    if not cube_is_responsive(timeout_s=2.0):
        try:
            ensure_healthy()
        except RuntimeError as e:
            pytest.exit(str(e), returncode=4)
    yield
    rep = getattr(request.node, "rep_call", None)
    if rep is not None and rep.failed:
        info = cube_info()
        ring = dump_ring(200)
        sys.stderr.write(f"\n=== FAILURE DIAGNOSTICS for {request.node.name} ===\n")
        sys.stderr.write(f"info: {json.dumps(info)}\n")
        sys.stderr.write(f"ring tail:\n{ring}\n")


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Stash phase reports onto the item so auto_recover_per_test can read them."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


@pytest.fixture(scope="session")
def cube_port() -> str:
    """Resolve the cube's USB-CDC port via the same glob the board manifest uses.

    Mirrors `boards/cube.yaml#usb.port_glob` — keeps the test independent of any
    cached auto-detect state. Skips the test if no port (or multiple) is found
    rather than masking the ambiguity.
    """
    candidates = sorted(glob.glob("/dev/cu.usbmodem*")) or sorted(
        glob.glob("/dev/ttyACM*")
    ) or sorted(glob.glob("/dev/ttyUSB*"))
    if not candidates:
        pytest.skip("no /dev/cu.usbmodem* port found for cube")
    if len(candidates) > 1:
        pytest.skip(f"multiple candidate ports: {candidates}; pass --port explicitly")
    return candidates[0]


@pytest.fixture
def devtool():
    """Subprocess wrapper. Returns a callable: devtool(*args) -> CompletedProcess."""
    def call(*args: str, timeout_s: float = 30.0, check: bool = False) -> subprocess.CompletedProcess:
        p = subprocess.run(
            [_DEVTOOL_BIN, *args],
            capture_output=True, text=True, timeout=timeout_s,
        )
        if check:
            assert p.returncode == 0, (
                f"esp32-devtool {' '.join(args)} → rc={p.returncode}\n"
                f"stdout: {p.stdout}\nstderr: {p.stderr}"
            )
        return p
    return call


@pytest.fixture
def clear_ring():
    """Snapshot the daemon ring via a unique mark verb; return a callable that
    fetches new lines since that mark.

    The daemon ring is in-memory-only. Instead of truncating, we tag with a
    marker and have the helper return only lines after it. Requires the cube
    firmware to expose a `mark` verb (Task 14 migrates it; until then this
    falls back to no-mark behaviour and returns the full tail).
    """
    marker = f"test-marker-{time.time()}"
    subprocess.run(
        [_DEVTOOL_BIN, "cmd", "mark", "--param", f"label={marker}"],
        capture_output=True, text=True, timeout=5.0,
    )

    def grep_since() -> list[str]:
        ring = dump_ring(20000)
        if marker not in ring:
            return ring.split("\n")
        lines = ring.split("\n")
        for i, line in enumerate(lines):
            if marker in line:
                return lines[i + 1:]
        return []

    return grep_since
