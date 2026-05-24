"""Auto-detect e2e: with no ``--board`` override, ``info`` must resolve the
cube via USB-port glob + ``/info`` HTTP discovery, returning the expected
JSON shape.

Cube must be on USB and at IDLE (WiFi connected, HTTP server up) — the
session-scoped ``cube_ready`` fixture in ``conftest.py`` enforces both.
"""
from __future__ import annotations

import json


_INFO_TIMEOUT_S = 10.0


def test_auto_detect_resolves_cube_via_info(devtool) -> None:
    p = devtool("--json", "info", check=True, timeout_s=_INFO_TIMEOUT_S)
    payload = json.loads(p.stdout)
    assert payload["board"] == "cube", f"unexpected board: {payload!r}"
    assert payload["ip"], f"missing ip in info payload: {payload!r}"
    assert payload["chip"] == "esp32-s3", f"unexpected chip: {payload!r}"
