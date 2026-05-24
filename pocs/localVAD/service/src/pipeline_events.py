"""Events emitted by the Silero + Smart-Turn streaming pipeline.

Kept separate from ``turn_pipeline`` so both the state machine and the
WebSocket wire-format translator can import them without dragging in the
full pipeline (and its torch + silero imports).
"""

from __future__ import annotations

from dataclasses import dataclass
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


PipelineEvent = Union[
    VadStart,
    VadEnd,
    SmartTurnEval,
    TurnComplete,
    TurnContinuing,
]
