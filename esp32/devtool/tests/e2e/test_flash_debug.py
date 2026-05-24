"""e2e parity test for ``esp32-devtool flash --profile debug``.

Verifies the absorbed-from-flash.sh path end-to-end:
1. ``flash`` returns 0 (idf.py build+flash + daemon respawn + READY marker).
2. The cube responds to ``cmd state`` afterwards in a non-error state.

Burns one flash per run. The prod-profile counterpart (test_flash_prod.py)
is deferred to Task 22 (audit-prod-strip).
"""
from __future__ import annotations

import json


def test_flash_debug_succeeds_and_cube_returns_to_idle(devtool):
    p = devtool("flash", "--profile", "debug", timeout_s=300.0)
    assert p.returncode == 0, (
        f"stderr: {p.stderr[-2000:]}\nstdout: {p.stdout[-1000:]}"
    )
    state = json.loads(devtool("cmd", "state", check=True).stdout)
    assert state["state"] in {"IDLE", "CONNECTING", "LISTENING", "CONNECTED"}
