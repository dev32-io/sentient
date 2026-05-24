"""e2e parity test for /audio/inject. POSTs 1 s of silence as raw PCM16LE
mono, then asserts the response echoes {"ok": true, "samples": 16000}.

The provider pushes samples into the shared inject ring (main/audio/
audio_inject_ring.cc); the response sample count is the request body's
total, not the ring's accepted count, so the test is robust to ring-state
between runs.
"""
from __future__ import annotations

import json


def test_audio_inject_1s_silence(devtool, tmp_path):
    pcm = b"\x00\x00" * 16000  # 1 second of silence at 16 kHz mono int16
    in_path = tmp_path / "silence.pcm"
    in_path.write_bytes(pcm)
    p = devtool("audio", "inject", "--in", str(in_path), check=True)
    payload = json.loads(p.stdout)
    assert payload["ok"] is True
    assert payload["samples"] == 16000
