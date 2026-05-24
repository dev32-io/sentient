"""Parity test: state verb returns a known device state via the devtool path."""
from __future__ import annotations

import json


def test_cmd_state_returns_known_state(devtool):
    p = devtool("--json", "cmd", "state", check=True)
    payload = json.loads(p.stdout)
    assert payload["state"] in {
        "UNKNOWN", "STARTING", "WIFI_CONFIGURING", "IDLE", "CONNECTING",
        "LISTENING", "SPEAKING", "UPGRADING", "ACTIVATING", "AUDIO_TESTING",
        "FATAL_ERROR",
    }, f"unexpected state: {payload['state']!r}"
    assert isinstance(payload["ws_connected"], bool), \
        f"ws_connected should be bool, got {type(payload['ws_connected'])}"
    assert isinstance(payload["wifi_connected"], bool), \
        f"wifi_connected should be bool, got {type(payload['wifi_connected'])}"
    # ip is required — enables HTTP auto-discovery.
    assert "ip" in payload, "state response must include ip field"
    assert isinstance(payload["ip"], str), f"ip should be str, got {type(payload['ip'])}"
