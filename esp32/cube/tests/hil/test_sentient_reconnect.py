"""S5 cube survives a gateway restart within 30 s."""
from __future__ import annotations
import subprocess, time
from pathlib import Path
import pytest

@pytest.mark.group_a
def test_reconnect_after_gateway_restart(cube_dut):
    # Direct container restart — avoids depending on compose-file env (e.g.
    # HOST_DOCKER_GID) that's only resolved by the bringing-up shell.
    subprocess.check_call(["docker", "restart", "sentient-gateway"])
    deadline = time.time() + 30
    last = None
    while time.time() < deadline:
        rsp = cube_dut.cmd("sentient.status")
        last = rsp["status"]
        if last == "Ready":
            return
        time.sleep(1.0)
    pytest.fail(f"cube did not reach Ready within 30s; last status={last}")
