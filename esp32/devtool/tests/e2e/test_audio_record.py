"""e2e parity test for /audio/record. Captures 1 s @ 16 kHz mono via the
HTTP companion + audio.record_pcm provider wrapper, then asserts the body
size lands in the expected window (32 000 bytes nominal; allow some jitter
from the codec's warmup-frame discard inside AudioService::RecordPcm).
"""
from __future__ import annotations

from pathlib import Path


def test_audio_record_1s(devtool, tmp_path):
    out = tmp_path / "rec.pcm"
    devtool(
        "audio", "record",
        "--duration", "1000",
        "--out", str(out),
        check=True,
    )
    # 16 kHz mono int16 = 32 000 bytes for exactly 1 s. The wrapper's PSRAM
    # alloc is sized off (duration_ms * sample_rate / 1000) * 2, so a clean
    # 1 s capture lands within +/- a few bytes — wide window tolerates any
    # future tweaks to codec warmup discard.
    sz = out.stat().st_size
    assert 28000 < sz < 36000, f"unexpected size {sz} (want ~32000)"
