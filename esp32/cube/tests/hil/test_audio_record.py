"""Phase 4 Task 7 — audio.record_rms + audio.record_pcm verb smoke (Group A).

Cube-side smoke for the new mic-capture verbs. Verifies:
- record_rms returns a non-zero RMS when the room is quiet (proves the codec
  input path is alive — silent codec would return zero samples, RMS = 0)
- record_rms quiet baseline is below an empty-room threshold
- record_pcm shape: samples == ms * 16000 / 1000, b64 length sane
- record_pcm round-trip via audio.inject_pcm: injecting a known tone then
  recording reads back the SAME samples (injection hook short-circuits the
  codec; this verifies the verb-level read loop is correct)
- bad-params paths emit -32602 Invalid params

Operator ear test (record live speech → b64 → play_pcm round-trip) lives
in Task 8 device smoke, not here.
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
def test_record_rms_quiet_nonzero(cube_dut):
    """Quiet-room RMS is > 0 (codec alive) AND < 2000 (no loud noise)."""
    rsp = cube_dut.cmd("audio.record_rms", params={"ms": 500}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 500 // 1000
    rms = rsp["rms"]
    assert rms > 0.0, f"RMS = {rms} — codec input path may be disabled"
    assert rms < 2000.0, f"RMS = {rms} — room is too loud for quiet baseline"


@pytest.mark.group_a
def test_record_pcm_shape(cube_dut):
    """record_pcm 250 ms returns ~4000 samples + matching b64 length."""
    rsp = cube_dut.cmd("audio.record_pcm", params={"ms": 250}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 250 // 1000
    assert rsp["rate"] == 16000
    raw = base64.b64decode(rsp["b64"])
    # 4000 samples * 2 bytes = 8000 raw bytes
    assert len(raw) == rsp["samples"] * 2
    # b64 encoding inflates by 4/3 (plus padding)
    expected_b64_len = ((len(raw) + 2) // 3) * 4
    assert len(rsp["b64"]) == expected_b64_len


@pytest.mark.group_a
def test_record_pcm_round_trip_via_inject(cube_dut):
    """inject_pcm tone → record_pcm reads back the same samples.

    The injection hook in ReadAudioData short-circuits the codec when the
    injection ring buffer is non-empty. This proves the verb-side read +
    base64-encode path is correct WITHOUT depending on a live mic.
    """
    # 100 ms of 440 Hz sine — 1600 samples = 3200 bytes.
    raw = pcm16_sine(440, 100)
    b64_in = base64.b64encode(raw).decode()
    inject_rsp = cube_dut.cmd(
        "audio.inject_pcm", params={"pcm_b64": b64_in}, timeout=5,
    )
    assert inject_rsp["ok"] is True

    # Record EXACTLY the injected length back. The hook drains sample-by-sample.
    rec_rsp = cube_dut.cmd(
        "audio.record_pcm", params={"ms": 100}, timeout=5,
    )
    assert rec_rsp["ok"] is True
    out = base64.b64decode(rec_rsp["b64"])

    # Allow for first-frame warmup discard in RecordPcm: the first 30 ms
    # (480 samples = 960 bytes) of the injected stream may be eaten by the
    # warmup-discard frame inside AudioService::RecordPcm. Compare what
    # remains: the tail of the recorded buffer should match the tail of
    # the injected buffer for at least the post-warmup window.
    warmup_bytes = 480 * 2  # 30 ms @ 16 kHz mono
    assert len(out) == len(raw)
    # Compare the post-warmup tail (skip first warmup_bytes of `raw` to
    # account for the warmup discard).
    assert out[: len(raw) - warmup_bytes] == raw[warmup_bytes:][: len(raw) - warmup_bytes], (
        "post-warmup tail mismatch — injection ring read order broken"
    )


@pytest.mark.group_a
def test_record_rms_bad_ms(cube_dut):
    """ms below minimum emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_rms", params={"ms": 5}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_record_pcm_bad_ms(cube_dut):
    """ms above maximum emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_pcm", params={"ms": 5000}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_record_missing_ms(cube_dut):
    """Missing ms in audio.record_rms emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_rms", params={}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_cube_alive_after_record(cube_dut):
    """Smoke: after all the above, cube must still be IDLE + responsive."""
    state = cube_dut.cmd("state", timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True
