"""HIL smoke: CubeDut.cmd works end-to-end against a running cube."""
import pytest


@pytest.mark.group_a
def test_state_verb_roundtrip(cube_dut):
    """state verb returns the expected fields with reasonable values."""
    state = cube_dut.cmd("state")
    assert "state" in state
    assert "wifi_connected" in state
    assert "ws_connected" in state
    assert "cycle_id" in state
    assert isinstance(state["wifi_connected"], bool)
    assert isinstance(state["ws_connected"], bool)
    assert state["state"] in (
        "UNKNOWN", "STARTING", "WIFI_CONFIGURING", "IDLE", "CONNECTING",
        "LISTENING", "SPEAKING", "UPGRADING", "ACTIVATING", "AUDIO_TESTING",
        "FATAL_ERROR",
    )


@pytest.mark.group_a
def test_mark_verb_roundtrip(cube_dut):
    """mark verb returns ok:true, confirming the verb is registered and executes.

    Note: >>> MARK output is emitted before the RSP on the serial line; it is
    consumed (and discarded) by CubeDut.cmd() while waiting for <<< RSP.
    Asserting the RSP result is sufficient for group_a automation — physical
    MARK line inspection belongs to a group_b/c test with a human observer.
    """
    result = cube_dut.cmd("mark", params={"label": "hil-smoke-mark"})
    assert result.get("ok") is True
