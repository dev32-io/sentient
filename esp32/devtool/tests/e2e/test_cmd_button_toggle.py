"""Parity test: button.toggle fires and returns ok via the devtool path."""
from __future__ import annotations

import json
import time


def test_button_toggle_executes(devtool):
    p = devtool("--json", "cmd", "button.toggle", check=True)
    payload = json.loads(p.stdout)
    assert payload.get("ok") is True, f"expected ok=true, got {payload!r}"
    # Restore: toggle back to leave the cube in its prior state.
    time.sleep(0.5)
    devtool("--json", "cmd", "button.toggle", check=True)
