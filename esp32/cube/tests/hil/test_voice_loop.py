"""Phase 5 voice-loop verb smoke (Group A).

Cube-side smoke for the full voice loop after the toggle-button screen is
restored. Verifies:
- Boot → IDLE with WS connected (cube already had this; reconfirms after flash)
- button.toggle verb transitions IDLE → Listening
- gateway logs receive cube uplink frames within ~3 s of button press
- ws.disconnect verb is recoverable within 30 s (auto-reconnect via xiaozhi)
- After all the above, cube is back in IDLE + responsive

Operator ear test (full voice round-trip via speaker) lives in Task 6 device
smoke, not here.
"""
from __future__ import annotations

import time

import pytest


# Module-level HIL constants. Keep names in sync with the plan.
kBootToIdleTimeoutSec = 30
kStateTransitionTimeoutSec = 5
kWsDisconnectRecoverySec = 30
kUplinkFrameProbeSec = 3


@pytest.mark.group_a
def test_boot_to_idle(cube_dut):
    """Within 30 s, state must be IDLE and ws_connected=true."""
    deadline = time.time() + kBootToIdleTimeoutSec
    last_state = None
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        last_state = s
        if s.get("state") == "IDLE" and s.get("ws_connected") is True:
            return
        time.sleep(1.0)
    pytest.fail(
        f"cube did not reach IDLE+ws_connected within {kBootToIdleTimeoutSec}s; "
        f"last state: {last_state}"
    )


@pytest.mark.group_a
def test_toggle_to_listening(cube_dut):
    """button.toggle from IDLE transitions to LISTENING within 5 s.

    Cleanup: send button.toggle again to return to IDLE so subsequent tests
    don't inherit a Listening-state cube.
    """
    # Sanity: precondition is IDLE.
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"

    cube_dut.cmd("button.toggle", timeout=5)
    deadline = time.time() + kStateTransitionTimeoutSec
    saw = None
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        saw = s["state"]
        if saw == "LISTENING":
            break
        time.sleep(0.25)
    else:
        pytest.fail(
            f"state did not transition IDLE → LISTENING within "
            f"{kStateTransitionTimeoutSec}s; last={saw}"
        )

    # Cleanup: toggle off
    cube_dut.cmd("button.toggle", timeout=5)
    time.sleep(0.5)


@pytest.mark.group_a
def test_toggle_emits_uplink_frames(cube_dut, gateway_logs):
    """Press button → within 3 s, gateway log shows incoming audio frames.

    Cross-stack assertion: capture gateway log position BEFORE press, grep
    for cube-source frame markers AFTER. The exact log line shape depends on
    the gateway's audio sink; this test asserts the presence of ANY
    cube-source uplink activity in the window.
    """
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"

    pos = gateway_logs.position()
    cube_dut.cmd("button.toggle", timeout=5)
    time.sleep(kUplinkFrameProbeSec)
    cube_dut.cmd("button.toggle", timeout=5)  # cleanup: release toggle
    time.sleep(0.5)

    # Look for any gateway-side audio ingest line. Pattern is broad on
    # purpose; the gateway evolves its log format and the test cares about
    # presence, not exact shape. The substring `audio` is the minimum
    # commitment.
    matches = gateway_logs.grep("audio", since_pos=pos)
    if len(matches) < 1:
        total = gateway_logs.grep("", since_pos=pos)
        pytest.fail(
            f"no gateway-side audio activity observed within "
            f"{kUplinkFrameProbeSec}s of button press; "
            f"audio-pattern matches: {len(matches)}, "
            f"total gateway log lines since press: {len(total)}"
        )


@pytest.mark.group_a
def test_ws_disconnect_recovery(cube_dut):
    """ws.disconnect verb forces a reconnect within 30 s."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"
    assert s["ws_connected"] is True

    # ws.disconnect actually closes the underlying WS; xiaozhi's reconnect
    # logic should re-establish it inside the recovery window.
    cube_dut.cmd("ws.disconnect", timeout=5)

    # Confirm we observed the disconnect (give the daemon a moment).
    time.sleep(1.0)
    s = cube_dut.cmd("state", timeout=5)
    # state may briefly be CONNECTING; ws_connected should be false.
    if s["ws_connected"] is True:
        pytest.fail(f"ws.disconnect did not take effect: {s}")

    # Wait for recovery.
    deadline = time.time() + kWsDisconnectRecoverySec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["ws_connected"] is True:
            return
        time.sleep(2.0)
    pytest.fail(f"ws did not reconnect within {kWsDisconnectRecoverySec}s; last={s}")


@pytest.mark.group_a
def test_cube_alive_after_voice_loop_smoke(cube_dut):
    """Smoke: after the suite above, the cube is still IDLE + responsive."""
    state = cube_dut.cmd("state", timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True
