"""Per-turn pause accounting.

Tracks silence intervals between VAD end → next VAD start *within* a
single turn. A "pause" here is specifically a mid-turn break the speaker
took that Silero picked up but Smart-Turn decided was not the end of the
turn. Cross-turn silence is not a pause — it's dead air.

Durations are reported in **integer milliseconds**, adjusted for
Silero's ``VAD_MIN_SILENCE_MS`` detection lag so the numbers reflect
the speaker's perceived pause, not the detection artifact.
"""

from __future__ import annotations


class PauseTracker:
    """Mutable per-turn list of pause durations in milliseconds."""

    def __init__(self, detection_lag_ns: int) -> None:
        self._detection_lag_ns = detection_lag_ns
        self._durations_ms: list[int] = []
        self._last_end_ns: int | None = None

    def reset(self) -> None:
        self._durations_ms = []
        self._last_end_ns = None

    def on_vad_end(self, end_ns: int) -> None:
        self._last_end_ns = end_ns

    def on_vad_start(self, start_ns: int) -> int | None:
        """Close any open pause and return its duration in ms.

        Returns ``None`` if there was no prior VAD end (e.g. the very
        first VAD start of a turn).
        """
        if self._last_end_ns is None:
            return None
        actual_ns = (start_ns - self._last_end_ns) + self._detection_lag_ns
        ms = round(actual_ns / 1_000_000)
        self._durations_ms.append(ms)
        self._last_end_ns = None
        return ms

    def durations_ms(self) -> list[int]:
        return list(self._durations_ms)

    def __len__(self) -> int:
        return len(self._durations_ms)
