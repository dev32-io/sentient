"""Super-segment grouping: split only at gaps >= min_pause_ms."""
from __future__ import annotations

import numpy as np

from whisper_stt.super_segment import group_super_segments


def _seg(val: int, n: int = 4) -> np.ndarray:
    return np.full(n, float(val), dtype=np.float32)


def test_merge_short_split_long() -> None:
    segs = [_seg(0), _seg(1), _seg(2), _seg(3)]
    supers, pauses = group_super_segments(segs, [500, 2500, 300], min_pause_ms=2000)
    assert len(supers) == 2
    assert supers[0].tolist() == [0, 0, 0, 0, 1, 1, 1, 1]   # s0+s1
    assert supers[1].tolist() == [2, 2, 2, 2, 3, 3, 3, 3]   # s2+s3
    assert pauses == [2500]


def test_single_segment_no_pause() -> None:
    supers, pauses = group_super_segments([_seg(0)], [], min_pause_ms=2000)
    assert len(supers) == 1
    assert pauses == []


def test_all_short_gaps_merge_to_one() -> None:
    supers, pauses = group_super_segments([_seg(0), _seg(1), _seg(2)], [300, 400], min_pause_ms=2000)
    assert len(supers) == 1
    assert pauses == []


def test_empty() -> None:
    supers, pauses = group_super_segments([], [], min_pause_ms=2000)
    assert supers == []
    assert pauses == []
