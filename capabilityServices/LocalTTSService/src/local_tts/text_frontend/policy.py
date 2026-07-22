"""Tunables that decide WHAT the text frontend speaks.

Separate from ``config.py`` on purpose: ``config.py`` owns "what does
config.yaml contain", this owns "what does the speech policy need". The
server builds one of these at startup and hands it to the frontend, so
every stage below reads the same immutable policy object instead of
reaching back into global config.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SpeechPolicy:
    """Immutable speech-shaping policy for one process."""

    # Tables with MORE than this many body cells (rows x columns) are
    # summarized ("a table with N rows and M columns") instead of read.
    table_max_cells: int
    # Inline-code spans longer than this are treated as non-prose and
    # replaced by a phrase rather than spoken verbatim.
    code_span_max_chars: int
    # When a span is dropped, speak a short placeholder phrase ("a
    # command") instead of leaving a hole in the sentence.
    speak_dropped_spans: bool
