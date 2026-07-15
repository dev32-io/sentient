"""Events emitted by the local-tts synthesis + voice-management pipeline.

This module contains only dataclass definitions — no logic, no imports
of heavy libraries (mlx, mlx_audio, soundfile). That lets ``wire_protocol.py``
(and anything that only needs to encode/inspect events, e.g. tests) import
these types without pulling in the ML stack. Mirrors the sibling STT
service's ``pipeline_events.py`` split: pure event data here, wire
translation in ``wire_protocol.py``.

Python note — ``Union`` types: see the STT service's ``pipeline_events.py``
for the full walkthrough of why we use ``Union[]`` here instead of a
Kotlin-style sealed class.

Naming note: the dataclasses below are named ``ErrorEvent``/``WarningEvent``
rather than ``Error``/``Warning`` — those are Python builtin exception
names, and shadowing them (even locally) invites confusing bugs at any
import site that does ``from .pipeline_events import *`` or reads this
module's names side-by-side with builtins. The wire ``type`` string is
still plain ``"error"``/``"warning"`` (see ``wire_protocol.encode_server_event``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union


@dataclass
class Ready:
    """First frame on every connection — echoes the negotiated connect params."""

    format: str
    sample_rate: int
    voice: str | None


@dataclass
class Started:
    """A synthesis request began; binary audio frames follow until ``Done``."""

    request_id: str


@dataclass
class Done:
    """A synthesis request finished; audio has fully drained to the client."""

    request_id: str
    ttfa_ms: float
    rtf: float
    audio_seconds: float


@dataclass
class WarningEvent:
    """Non-fatal condition worth surfacing (e.g. an unexpected binary frame)."""

    reason: str


@dataclass
class ErrorEvent:
    """A request failed (bad input, synth exception); the connection stays open."""

    reason: str


@dataclass
class VoiceCreated:
    """A new voice pack was persisted via ``voice.create``."""

    voice_id: str
    name: str
    created_at: float


@dataclass
class VoiceListResult:
    """Response to ``voice.list`` — every persisted pack's metadata."""

    voices: list[dict] = field(default_factory=list)


@dataclass
class VoiceDeleted:
    """A voice pack was removed (or didn't exist — delete is idempotent)."""

    voice_id: str


# Type alias listing every event this service can emit over the wire.
# Used in function signatures that accept or return "any server event".
ServerEvent = Union[
    Ready,
    Started,
    Done,
    WarningEvent,
    ErrorEvent,
    VoiceCreated,
    VoiceListResult,
    VoiceDeleted,
]
