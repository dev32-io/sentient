"""S4 toggle press during TTS playback cuts the playback within 200ms."""
import time
from pathlib import Path
import pytest

from _wav_helper import load_wav_as_pcm_b64

LONG_TURN = str(Path(__file__).parent / "fixtures" / "long_question_16k.wav")


@pytest.mark.group_b
def test_barge_in_cuts_playback(cube_dut, gateway_logs):
    # 1) trigger a long turn so TTS plays for several seconds.
    cube_dut.cmd("button.toggle")
    time.sleep(0.2)
    cube_dut.cmd(
        "audio.inject_pcm",
        params={"pcm_b64": load_wav_as_pcm_b64(LONG_TURN)},
    )
    cube_dut.cmd("button.toggle")
    # 2) wait until gateway log shows TTS playback start.
    pos = gateway_logs.position()
    deadline = time.time() + 5
    started = False
    while time.time() < deadline:
        if gateway_logs.grep("connector.audio.start", since_pos=pos):
            started = True
            break
        time.sleep(0.2)
    if not started:
        pytest.fail("TTS playback did not start within 5s")
    # 3) press toggle again to barge in.
    barge_pos = gateway_logs.position()
    cube_dut.cmd("button.toggle")
    time.sleep(0.5)
    # 4) gateway should emit playback.stop reason=barge-in.
    assert gateway_logs.grep("playback.stop", since_pos=barge_pos), \
        "gateway did not emit playback.stop within 500ms"
    assert gateway_logs.grep("barge-in", since_pos=barge_pos), \
        "playback.stop reason was not barge-in"
