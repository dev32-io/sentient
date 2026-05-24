"""Sanity-check that the rewritten HIL fixtures still expose CubeDut.cmd() correctly.

Runs a fast subset of the Phase 6 HIL suite (`test_smoke.py`) against the live
cube via the HIL `.venv`. If this passes, the wire shape (verb in → JSON-RPC
result dict out) of `CubeDut.cmd()` matches what every Phase 6 test expects.

Pinned to test_smoke.py — covers verb roundtrip + param passing in <5s, vs
test_sentient_audio_toggle.py which drives full STT/TTS and adds ~10s + paid
service dependence.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]
HIL_DIR = REPO / "esp32" / "cube" / "tests" / "hil"
HIL_PYTEST = REPO / "esp32" / "cube" / ".venv" / "bin" / "pytest"


def test_phase6_hil_smoke_subset_passes():
    """Run the HIL smoke subset via the cube .venv's pytest.

    Bypasses pytest-timeout (HIL venv doesn't have it); subprocess.run has its
    own outer timeout instead.
    """
    assert HIL_PYTEST.exists(), (
        f"HIL pytest not found at {HIL_PYTEST}; "
        f"run `esp32-devtool setup --hil` first"
    )
    p = subprocess.run(
        [str(HIL_PYTEST), "test_smoke.py", "-x", "-q"],
        cwd=str(HIL_DIR),
        capture_output=True,
        text=True,
        timeout=60.0,
    )
    assert p.returncode == 0, (
        f"phase6 HIL smoke regressed (rc={p.returncode}):\n"
        f"STDOUT:\n{p.stdout}\n"
        f"STDERR:\n{p.stderr}"
    )
