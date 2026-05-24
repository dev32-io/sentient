"""Events emitted by the Silero → Smart-Turn → SenseVoice streaming pipeline.

Kept separate from ``turn_pipeline`` so both the state machine and the
WebSocket wire-format translator can import them without dragging in the
full pipeline (and its torch + silero + sherpa-onnx imports).
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

    ``text`` is the stitched transcript with ``[pause.N]`` placeholder
    tokens inline. ``pauses[N]`` is the duration in milliseconds of the
    pause referenced by ``[pause.N]``.

    Invariant: ``text`` contains exactly ``len(pauses)`` occurrences of
    ``[pause.N]``, indices 0..N-1 each appearing exactly once in order.

    ``emotion`` and ``event`` carry SenseVoice's acoustic classifier
    outputs, wrapped in the ``<|xxx|>`` tag form. ``emotion`` is often
    ``<|NEUTRAL|>`` or ``<|EMO_UNKNOWN|>`` for normal speech; non-trivial
    labels appear on exaggerated prosody. ``event`` is usually
    ``<|Speech|>`` but can be ``<|Laughter|>``, ``<|BGM|>``, etc.
    """

    t_mono_ns: int
    turn_idx: int
    text: str
    emotion: str
    event: str
    decode_ms: float
    audio_seconds: float
    pauses: list[int] = field(default_factory=list)


PipelineEvent = Union[
    VadStart,
    VadEnd,
    SmartTurnEval,
    TurnComplete,
    TurnContinuing,
    TurnRejected,
    TranscriptReady,
]
