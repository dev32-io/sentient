"""Wire-protocol (de)serialization for the Chatterbox-TTS WS server.

Two directions, kept in one module because they're two halves of the
same contract (see ``CONTRACT.md``):

- ``parse_client_message(raw)`` — JSON text frame -> typed ``ClientMessage``.
  Raises ``WireProtocolError`` (never a bare ``KeyError``/``TypeError``) on
  anything malformed, so callers can turn a bad message into an ``error``
  frame instead of crashing the connection (see ``error-handling.md``).
- ``encode_server_event(evt)`` -> ``(json_dict, binary_payload)`` — mirrors
  the STT service's ``event_to_wire``. The caller sends the dict as a text
  frame and, if the second element is not ``None``, a binary frame right
  after. No event in this service currently carries a binary payload (audio
  frames are sent directly by the synthesis drain loop, not routed through
  this function) — the tuple shape is kept for symmetry with STT and to
  leave room for a future event that does.

This module is deliberately pure (de)serialization only — no ``ws.send``,
no logging. The async I/O wrapper that actually sends an encoded event
over a connection (``send_server_event``) lives in ``event_sender.py``,
kept separate so this file stays focused and under the project's line cap.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Union

from .pipeline_events import (
    Done,
    ErrorEvent,
    Ready,
    ServerEvent,
    Started,
    VoiceCreated,
    VoiceDeleted,
    VoiceListResult,
    WarningEvent,
)


class WireProtocolError(ValueError):
    """Raised when an inbound client message fails to parse.

    Subclasses ``ValueError`` (matches ``config.py``'s ``ConfigError``
    convention in this service) so callers who catch ``ValueError`` also
    catch protocol errors.
    """


# -----------------------------------------------------------------------------
# Client -> server message types
# -----------------------------------------------------------------------------


@dataclass
class TextMessage:
    """Incremental text delta; buffered until the next ``flush``/``end``."""

    text: str


@dataclass
class FlushMessage:
    """Synthesize whatever text is buffered now (sentence boundary)."""


@dataclass
class EndMessage:
    """No more text is coming; synthesize any remaining buffered text."""


@dataclass
class CancelMessage:
    """Abort the in-flight synthesis request immediately."""


@dataclass
class PingMessage:
    """Liveness probe; server replies ``pong``."""


@dataclass
class VoiceCreateMessage:
    """Start a voice-pack upload; the next binary frame is the reference wav."""

    name: str


@dataclass
class VoiceListMessage:
    """List every persisted voice pack."""


@dataclass
class VoiceDeleteMessage:
    """Delete a voice pack by id."""

    voice_id: str


ClientMessage = Union[
    TextMessage,
    FlushMessage,
    EndMessage,
    CancelMessage,
    PingMessage,
    VoiceCreateMessage,
    VoiceListMessage,
    VoiceDeleteMessage,
]

# Wire ``type`` discriminator values. Named constants per the no-magic-
# strings rule — every literal below is used in exactly one branch of
# ``parse_client_message``/``encode_server_event`` plus its test.
_TYPE_TEXT = "text"
_TYPE_FLUSH = "flush"
_TYPE_END = "end"
_TYPE_CANCEL = "cancel"
_TYPE_PING = "ping"
_TYPE_PONG = "pong"
_TYPE_VOICE_CREATE = "voice.create"
_TYPE_VOICE_LIST = "voice.list"
_TYPE_VOICE_DELETE = "voice.delete"
_TYPE_READY = "ready"
_TYPE_STARTED = "started"
_TYPE_DONE = "done"
_TYPE_WARNING = "warning"
_TYPE_ERROR = "error"
_TYPE_VOICE_CREATED = "voice.created"
_TYPE_VOICE_DELETED = "voice.deleted"


def parse_client_message(raw: str) -> ClientMessage:
    """Parse one JSON text frame into a typed ``ClientMessage``.

    Raises ``WireProtocolError`` for invalid JSON, a non-object payload,
    a missing/unknown ``type``, or a message missing a required field —
    never lets a malformed message propagate as an unhandled exception.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WireProtocolError(f"invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise WireProtocolError("client message must be a JSON object")

    kind = parsed.get("type")
    if kind == _TYPE_TEXT:
        return TextMessage(text=_require_str(parsed, "text", kind))
    if kind == _TYPE_FLUSH:
        return FlushMessage()
    if kind == _TYPE_END:
        return EndMessage()
    if kind == _TYPE_CANCEL:
        return CancelMessage()
    if kind == _TYPE_PING:
        return PingMessage()
    if kind == _TYPE_VOICE_CREATE:
        return VoiceCreateMessage(name=_require_str(parsed, "name", kind))
    if kind == _TYPE_VOICE_LIST:
        return VoiceListMessage()
    if kind == _TYPE_VOICE_DELETE:
        return VoiceDeleteMessage(voice_id=_require_str(parsed, "voiceId", kind))

    raise WireProtocolError(f"unknown client message type: {kind!r}")


def _require_str(parsed: dict[str, Any], field_name: str, kind: str) -> str:
    """Pull a required non-empty string field out of a parsed client message."""
    value = parsed.get(field_name)
    if not isinstance(value, str) or not value:
        raise WireProtocolError(
            f"'{kind}' message requires a non-empty string '{field_name}' field"
        )
    return value


# -----------------------------------------------------------------------------
# Server -> client event encoding
# -----------------------------------------------------------------------------


def _ready_payload(evt: Ready) -> dict[str, Any]:
    return {
        "type": _TYPE_READY, "format": evt.format, "sample_rate": evt.sample_rate, "voice": evt.voice,
    }


def _done_payload(evt: Done) -> dict[str, Any]:
    return {
        "type": _TYPE_DONE, "requestId": evt.request_id, "ttfa_ms": evt.ttfa_ms,
        "rtf": evt.rtf, "audio_seconds": evt.audio_seconds,
    }


def _voice_created_payload(evt: VoiceCreated) -> dict[str, Any]:
    return {
        "type": _TYPE_VOICE_CREATED, "voiceId": evt.voice_id, "name": evt.name, "createdAt": evt.created_at,
    }


# Ordered ``(type, encoder)`` pairs — first structural match wins. A plain
# dict keyed by class would work too, but this reads top-to-bottom like
# the ``if isinstance`` chain it replaces, and stays open to a future
# event type needing a subclass match instead of an exact one.
_ENCODERS: tuple[tuple[type, Any], ...] = (
    (Ready, _ready_payload),
    (Started, lambda evt: {"type": _TYPE_STARTED, "requestId": evt.request_id}),
    (Done, _done_payload),
    (WarningEvent, lambda evt: {"type": _TYPE_WARNING, "reason": evt.reason}),
    (ErrorEvent, lambda evt: {"type": _TYPE_ERROR, "reason": evt.reason}),
    (VoiceCreated, _voice_created_payload),
    (VoiceListResult, lambda evt: {"type": _TYPE_VOICE_LIST, "voices": evt.voices}),
    (VoiceDeleted, lambda evt: {"type": _TYPE_VOICE_DELETED, "voiceId": evt.voice_id}),
)


def encode_server_event(evt: ServerEvent) -> tuple[dict[str, Any], bytes | None]:
    """Return ``(json_dict, binary_payload)`` for a server-emitted event.

    See the module docstring for why every event today returns ``None``
    for the binary half (audio frames bypass this function entirely).
    """
    for event_type, encoder in _ENCODERS:
        if isinstance(evt, event_type):
            return encoder(evt), None

    # Fail loud: a new ServerEvent variant added without an entry above
    # would otherwise silently vanish instead of reaching the client.
    raise ValueError(f"unknown server event type: {type(evt).__name__}")
