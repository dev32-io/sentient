"""Per-turn pause accounting.

Tracks silence intervals between VAD end -> next VAD start *within* a
single turn. A "pause" here is specifically a mid-turn break the speaker
took that Silero picked up but Smart-Turn decided was not the end of the
turn. Cross-turn silence is not a pause — it's dead air.

Durations are reported in **integer milliseconds**, adjusted for
Silero's ``VAD_MIN_SILENCE_MS`` detection lag so the numbers reflect
the speaker's perceived pause, not the detection artifact.

Python note — dunder methods (``__len__``):
  The ``__len__`` method at the bottom lets you write ``len(tracker)``
  just like ``len(some_list)``. Python uses this "dunder" (double-
  underscore) protocol extensively — ``__str__`` for ``str()``,
  ``__eq__`` for ``==``, ``__iter__`` for ``for x in ...``, etc.
  It's loosely analogous to Kotlin's ``operator fun`` overloading,
  but convention-based rather than keyword-based.
"""

from __future__ import annotations


class PauseTracker:
    """Mutable per-turn list of pause durations in milliseconds.

    Lifecycle:
    1. Call ``reset()`` at the start of a new turn.
    2. Call ``on_vad_end(ns)`` each time Silero fires ``vad_end``.
    3. Call ``on_vad_start(ns)`` each time Silero fires ``vad_start``
       after the first one — this closes the open pause and records
       its duration.
    4. Call ``durations_ms()`` when the turn finalizes to get the
       complete list.
    """

    def __init__(self, detection_lag_ns: int) -> None:
        self._detection_lag_ns = detection_lag_ns
        self._durations_ms: list[int] = []
        self._last_end_ns: int | None = None

    def reset(self) -> None:
        """Clear all state for a new turn."""
        self._durations_ms = []
        self._last_end_ns = None

    def on_vad_end(self, end_ns: int) -> None:
        """Record the timestamp of a VAD end event."""
        self._last_end_ns = end_ns

    def on_vad_start(self, start_ns: int) -> int | None:
        """Close any open pause and return its duration in ms.

        Returns ``None`` if there was no prior VAD end (e.g. the very
        first VAD start of a turn).
        """
        if self._last_end_ns is None:
            return None
        # Add the detection lag back in because Silero's reported "end"
        # timestamp lags the actual moment silence began by roughly
        # VAD_MIN_SILENCE_MS. Without this correction, measured pauses
        # would systematically undercount by that amount.
        actual_ns = (start_ns - self._last_end_ns) + self._detection_lag_ns
        ms = round(actual_ns / 1_000_000)
        self._durations_ms.append(ms)
        self._last_end_ns = None
        return ms

    def durations_ms(self) -> list[int]:
        """Return a copy of all pause durations recorded so far."""
        return list(self._durations_ms)

    def __len__(self) -> int:
        return len(self._durations_ms)
