"""S7 corrupt token in creds → Error, no retry storm."""
import pytest

@pytest.mark.group_b  # operator-confirmed because it requires re-flash with bad creds
def test_bad_token_yields_error(cube_dut, gateway_logs):
    rsp = cube_dut.cmd("sentient.status")
    assert rsp["status"] == "Error", \
        f"bad-token cube should be Error, got {rsp}"
