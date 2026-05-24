"""Phase 3 Task 7 — audio.play_pcm verb smoke (Group A).

Cube-side smoke for the new audio.play_pcm verb. Does NOT verify
audibility (no mic loopback in Phase 3); only verifies:
- Single-payload path: 0.5 s 440 Hz sine round-trips green
- Chunked path: 3 chunks of 0.25 s each commit cleanly
- Bad-params paths emit -32602 Invalid params
- Cube remains responsive after each test (cube-cmd state still IDLE)
"""
from __future__ import annotations

import base64
import math
import struct

import pytest


def pcm16_sine(freq_hz: int, duration_ms: int, sample_rate: int = 16000) -> bytes:
    """Generates raw PCM16 mono bytes for a sine tone."""
    count = sample_rate * duration_ms // 1000
    samples = []
    for i in range(count):
        v = math.sin(2.0 * math.pi * freq_hz * i / sample_rate)
        samples.append(int(v * 16384))
    return struct.pack(f"<{count}h", *samples)


@pytest.mark.group_a
def test_play_pcm_single_payload(cube_dut):
    """Single-payload audio.play_pcm: 0.5 s 440 Hz sine returns ok:true + samples."""
    raw = pcm16_sine(440, 500)
    b64 = base64.b64encode(raw).decode()
    rsp = cube_dut.cmd("audio.play_pcm", params={"b64": b64}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 500 // 1000


@pytest.mark.group_a
def test_play_pcm_chunked(cube_dut):
    """Chunked audio.play_pcm: 3 chunks of 880 Hz sine, committed:true on final."""
    raw = pcm16_sine(880, 750)
    b64 = base64.b64encode(raw).decode()
    # Split full base64 into 3 substrings. Each chunk is a b64 fragment,
    # not valid base64 on its own — the firmware accumulates and decodes
    # only on the final chunk.
    chunk_size = len(b64) // 3 + 1
    chunks = [b64[i:i + chunk_size] for i in range(0, len(b64), chunk_size)]
    of = len(chunks)
    stream_id = "test-chunked-880"

    for idx, chunk in enumerate(chunks):
        rsp = cube_dut.cmd(
            "audio.play_pcm",
            params={
                "b64": chunk,
                "chunk": idx,
                "of": of,
                "stream_id": stream_id,
            },
            timeout=5,
        )
        assert rsp["ok"] is True
        assert rsp["chunk"] == idx
        if idx < of - 1:
            assert rsp.get("committed", False) is False
        else:
            assert rsp.get("committed") is True


@pytest.mark.group_a
def test_play_pcm_bad_b64(cube_dut):
    """Invalid base64 in audio.play_pcm emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.play_pcm", params={"b64": "not-base64!!!"}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_play_pcm_missing_b64(cube_dut):
    """Missing b64 param in audio.play_pcm emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.play_pcm", params={}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_cube_alive_after_play_pcm(cube_dut):
    """Smoke: after all the above, cube must still be IDLE + responsive."""
    state = cube_dut.cmd("state", timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True