"""Encode-bucket selection: smallest bucket (mel frames) that holds the audio.

Pins the length→bucket mapping the encoder speedup depends on. A bucket that
truncates real audio would silently drop words, so the fit must be conservative
(bucket >= content frames). 16 kHz, HOP_LENGTH 160 → 100 mel frames/s.
"""
from __future__ import annotations

from whisper_stt.whisper_mlx import _pick_bucket_frames

# 5/10/20/30s in mel frames (s * FRAMES_PER_SECOND=100).
_BUCKETS = (500, 1000, 2000, 3000)
_SR = 16_000


def test_short_clip_picks_smallest_bucket() -> None:
    # 0.7s of audio (~70 mel frames) fits the 5s (500) bucket.
    assert _pick_bucket_frames(int(0.7 * _SR), _BUCKETS) == 500


def test_boundary_just_over_5s_promotes_to_10s() -> None:
    # 5.1s (~510 frames) exceeds 500 → next bucket up.
    assert _pick_bucket_frames(int(5.1 * _SR), _BUCKETS) == 1000


def test_exact_bucket_length_fits_that_bucket() -> None:
    # Exactly 5s = 500 frames → fits the 500 bucket (>= is inclusive).
    assert _pick_bucket_frames(5 * _SR, _BUCKETS) == 500


def test_over_largest_bucket_falls_back_to_full_frames() -> None:
    # Longer than every bucket → N_FRAMES (30s) fallback.
    assert _pick_bucket_frames(45 * _SR, _BUCKETS) == 3000
