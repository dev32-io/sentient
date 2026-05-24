"""Phase 5 WiFi + WS recovery smoke (Group A).

Verifies the cube auto-recovers from a forced WiFi disconnect within the
expected window. Run sequentially after test_voice_loop.py because a WiFi
cycle is the most disruptive single test in the suite.

These tests assume the cube is online and at IDLE before the first case.
"""
from __future__ import annotations

import time

import pytest


kWifiDisconnectDetectSec = 5
kWifiReconnectSec = 60
kWsReconnectAfterWifiSec = 30


@pytest.mark.group_a
def test_wifi_disconnect_takes_ws_down(cube_dut):
    """wifi.disconnect verb causes ws_connected to flip to False within 5 s."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"
    assert s["wifi_connected"] is True
    assert s["ws_connected"] is True

    cube_dut.cmd("wifi.disconnect", timeout=5)

    deadline = time.time() + kWifiDisconnectDetectSec
    last = None
    while time.time() < deadline:
        last = cube_dut.cmd("state", timeout=5)
        if last["wifi_connected"] is False or last["ws_connected"] is False:
            return
        time.sleep(0.1)
    pytest.fail(
        f"wifi.disconnect did not deactivate WiFi/WS within "
        f"{kWifiDisconnectDetectSec}s; last={last}"
    )


@pytest.mark.group_a
def test_wifi_reconnect_restores_ws(cube_dut):
    """After a wifi.reconnect, both wifi and ws come back within their windows.

    Depends on `test_wifi_disconnect_takes_ws_down` having JUST run — this
    test issues `wifi.reconnect` against a cube whose WiFi was just downed.
    Pytest runs tests in file order within one module; the file ordering
    guarantees this precondition.
    """
    cube_dut.cmd("wifi.reconnect", timeout=5)

    # Wait for WiFi first.
    deadline = time.time() + kWifiReconnectSec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["wifi_connected"] is True:
            break
        time.sleep(2.0)
    else:
        pytest.fail(f"wifi did not reconnect within {kWifiReconnectSec}s")

    # Now wait for WS.
    deadline = time.time() + kWsReconnectAfterWifiSec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["ws_connected"] is True:
            return
        time.sleep(2.0)
    pytest.fail(f"ws did not reconnect within {kWsReconnectAfterWifiSec}s after wifi up")


@pytest.mark.group_a
def test_cube_alive_after_wifi_recovery(cube_dut):
    """Final sanity: cube is back to IDLE + fully connected."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE"
    assert s["wifi_connected"] is True
    assert s["ws_connected"] is True
