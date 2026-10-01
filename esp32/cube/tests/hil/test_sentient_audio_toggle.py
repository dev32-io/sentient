"""Handshake smoke only. Historical transcript was never capture acceptance."""
from __future__ import annotations
import pytest


@pytest.mark.group_a
def test_boot_to_ready(cube_dut):
    # `sentient.status` returns `Ready` only after the full handshake:
    # TLS connect → auth → auth.ok → session.configure → session.ready.
    # The verb-level proof is sufficient; per-step gateway-log greps would
    # need the conftest fixture pointed at ~/.sentient/gateway/logs/<today>.log
    # rather than the per-device cube UDP-tee file. Out of scope for S1.
    rsp = cube_dut.cmd("sentient.status")
    assert rsp["status"] == "Ready", f"expected Ready, got {rsp}"


@pytest.mark.group_a
@pytest.mark.skip(reason="Retired: history/legacy STT cannot prove current capture. Parent acoustic QA must correlate fresh capture and durable entry; explicit injection arm required.")
def test_toggle_uplink_transcript(cube_dut, gateway_logs):
    pass
