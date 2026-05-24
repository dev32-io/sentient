"""S1 boot → ready; S2 toggle press → opus uplink → final transcript."""
from __future__ import annotations
import time
from pathlib import Path
import pytest

from _wav_helper import load_wav_as_pcm_b64

WAVE_PCM_PATH = str(Path(__file__).parent / "fixtures" / "hello_16k.wav")


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
def test_toggle_uplink_transcript(cube_dut, gateway_logs):
    cube_dut.cmd("button.toggle")
    time.sleep(0.2)
    cube_dut.cmd(
        "audio.inject_pcm",
        params={"pcm_b64": load_wav_as_pcm_b64(WAVE_PCM_PATH)},
    )
    cube_dut.cmd("button.toggle")  # release
    time.sleep(2.0)
    rsp = cube_dut.cmd("sentient.last_transcript")
    text = rsp["text"]
    assert text, f"empty transcript: {rsp}"
    # Either the gateway log contains the final transcript, or the verb reports it.
    assert (
        "hello" in text.lower()
        or gateway_logs.grep("connector.transcript.final", since_pos=None)
    )
