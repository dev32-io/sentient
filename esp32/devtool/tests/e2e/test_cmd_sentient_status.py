"""Parity test: sentient.status returns a known SDK status via the devtool path."""
from __future__ import annotations

import json


def test_sentient_status_is_known(devtool):
    p = devtool("--json", "cmd", "sentient.status", check=True)
    payload = json.loads(p.stdout)
    assert "status" in payload, f"response missing 'status' field: {payload!r}"
    assert payload["status"] in {
        "uninit", "connecting", "ready", "listening", "speaking",
        "error", "Ready", "Connecting", "Disconnected", "Authenticating",
        "Reconnecting", "Error",
    }, f"unexpected sentient status: {payload['status']!r}"
