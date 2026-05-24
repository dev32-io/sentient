"""Events emitted by the Silero -> Smart-Turn -> SenseVoice pipeline.

This module contains only dataclass definitions — no logic, no imports
of heavy libraries (torch, sherpa-onnx). That lets the wire-protocol
layer import these types without pulling in the entire ML stack.

Python note — ``Union`` types:
  In Kotlin you'd declare a ``sealed class PipelineEvent`` with data-class
  subtypes. Python has no built-in sealed classes, so we use ``Union[]``
  (or the ``|`` shorthand available since Python 3.10) to create a
  "type alias" that lists every allowed member. Static type checkers
  (mypy, pyright) will flag code that handles a ``PipelineEvent`` without
  covering all variants — analogous to Kotlin's ``when`` exhaustiveness
  check on sealed classes.

Python note — ``field(default_factory=list)``:
  Mutable default values in Python are a classic trap. If you wrote
  ``pauses: list[int] = []`` directly, every instance would SHARE the
  same list object (because default arguments are evaluated once at class
  definition time, not per-instance). ``field(default_factory=list)``
  ensures each instance gets its own fresh ``[]``. This is a Python
  quirk with no Kotlin equivalent — Kotlin's ``data class(val x:
  MutableList<Int> = mutableListOf())`` always allocates per-instance.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Union


@dataclass
class VadStart:
    """Silero's ``VADIterator`` just fired ``{'start'}``."""

    t_mono_ns: int
    turn_idx: int


@dataclass
class VadEnd:
    """Silero's ``VADIterator`` just fired ``{'end'}`` (min-silence elapsed)."""

    t_mono_ns: int
    turn_idx: int


@dataclass
class SmartTurnEval:
    """A single Smart-Turn v3 inference completed."""

    t_mono_ns: int
    turn_idx: int
    probability: float
    prediction: int
    eval_ms: float
    audio_seconds: float


@dataclass
class TurnComplete:
    """Smart-Turn decided the turn is finished; full audio is packaged."""

    t_mono_ns: int
    turn_idx: int
    wav_bytes: bytes
    duration_ms: float
    smart_turn_probability: float
    smart_turn_eval_ms: float
    wav_path: Path


@dataclass
class TurnContinuing:
    """Smart-Turn decided the user paused but isn't done. Keep accumulating."""

    t_mono_ns: int
    turn_idx: int
    probability: float
    eval_ms: float


@dataclass
class TurnRejected:
    """A turn was finalized internally but dropped before emit.

    Usual reason: SenseVoice returned no letter/digit content AND the
    audio event tag was plain ``<|Speech|>`` — a desk knock, click, or
    cough that fooled Silero into firing a VAD start. Laughter, BGM,
    and other non-speech events are NOT rejected. No WAV is written.
    """

    t_mono_ns: int
    turn_idx: int
    reason: str
    text: str
    audio_event: str
    decode_ms: float
    audio_seconds: float


@dataclass
class TranscriptReady:
    """SenseVoice finished decoding the finalized turn audio.

    ``text`` contains ``[pause.N]`` placeholder tokens inline. The
    ``pauses`` list has the duration in milliseconds for each one.

    Invariant: ``text`` contains exactly ``len(pauses)`` occurrences of
    ``[pause.N]``, indices 0..N-1 each appearing exactly once in order.
    """

    t_mono_ns: int
    turn_idx: int
    text: str
    emotion: str
    event: str
    decode_ms: float
    audio_seconds: float
    pauses: list[int] = field(default_factory=list)


# Type alias listing every event the pipeline can emit. Use this in
# function signatures that accept or return "any pipeline event".
#
# Python note: ``Union[A, B, C]`` means "exactly one of A, B, or C".
# Since Python 3.10 you can write ``A | B | C`` instead, but we use
# Union here for explicitness and compatibility.
PipelineEvent = Union[
    VadStart,
    VadEnd,
    SmartTurnEval,
    TurnComplete,
    TurnContinuing,
    TurnRejected,
    TranscriptReady,
]
