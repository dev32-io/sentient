"""e2e parity tests for /touch endpoint."""
from __future__ import annotations

import json
import re
import time


def test_touch_corner_returns_ok(devtool):
    """POST /touch with a non-button coord returns {"ok": true}.

    Uses (50,50) (a corner) instead of (240,240) (the toggle widget) so we
    don't trigger the IDLE→LISTENING audio path. A separate pre-existing
    I2S DMA-alloc panic lives on that path (reproduces via button.toggle
    without /touch) and would reboot the cube mid-suite, masking the verb's
    real behaviour.
    """
    p = devtool("touch", "50", "50", check=True)
    assert json.loads(p.stdout) == {"ok": True}


def test_touch_emits_touch_tap_evt(devtool, cube_port):
    """Synthetic tap reaches LVGL indev → press/release detector emits touch.tap EVT.

    Taps a corner coord (50, 50) instead of center (240, 240) so we don't hit
    the toggle widget — keeps the test focused on the indev wire, not on the
    downstream IDLE→LISTENING audio path (which has a separate pre-existing
    I2S DMA-alloc bug we track outside this task).
    """
    devtool("touch", "50", "50", "--hold", "120", check=True)
    time.sleep(0.3)  # give the press→release tick + EVT flush time to land
    ring = devtool(
        "daemon", "ring", "--port", cube_port,
        "--lines", "200", "--filter", "touch.tap", check=True,
    ).stdout
    # The daemon ring serves events as a single JSON blob `{"events": [...]}`
    # where each entry is itself a JSON-encoded firmware log/EVT line — so
    # inner quotes appear backslash-escaped. Pattern accepts both shapes
    # (`"x":50` and `\"x\":50`) so the test stays robust to the transport.
    pat = re.compile(
        r'\\?"event\\?"\s*:\s*\\?"touch\.tap\\?"'
        r'\s*,\s*\\?"x\\?"\s*:\s*50'
        r'\s*,\s*\\?"y\\?"\s*:\s*50'
    )
    assert pat.search(ring) is not None, (
        f"no synthetic touch.tap EVT for (50,50) in ring buffer:\n{ring[-2000:]}"
    )
