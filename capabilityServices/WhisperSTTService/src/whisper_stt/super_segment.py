"""Group Silero VAD micro-segments into super-segments.

A super-segment is a run of micro-segments separated only by SHORT gaps
(< min_pause_ms). A gap >= min_pause_ms is a real mid-turn pause: it splits
super-segments and becomes a [pause.N] downstream. Merging short-gap micro-
segments gives Whisper whole-phrase context (and re-joins VAD's mid-word
over-splits), which is what stops short-clip hallucination.
"""

from __future__ import annotations

import numpy as np


def group_super_segments(
    segments: list[np.ndarray],
    gaps_ms: list[int],
    min_pause_ms: int,
) -> tuple[list[np.ndarray], list[int]]:
    """Return (super-segment audios, inter-super-segment pause durations).

    ``gaps_ms[i]`` is the silence between ``segments[i]`` and ``segments[i+1]``.
    A gap >= ``min_pause_ms`` splits; shorter gaps merge. ``pauses`` holds the
    splitting gap durations in order, len == len(super_segments) - 1.
    Defensive: tolerates ``len(gaps_ms) != len(segments) - 1``.
    """
    if not segments:
        return [], []
    groups: list[list[np.ndarray]] = [[segments[0]]]
    pauses: list[int] = []
    for i in range(len(segments) - 1):
        gap = gaps_ms[i] if i < len(gaps_ms) else 0
        if gap >= min_pause_ms:
            groups.append([segments[i + 1]])
            pauses.append(gap)
        else:
            groups[-1].append(segments[i + 1])
    supers = [np.concatenate(g) for g in groups]
    return supers, pauses
