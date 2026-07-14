"""Pure (de)serialization tests for the Chatterbox-TTS wire protocol.

No model, no network, no WebSocket — ``parse_client_message`` and
``encode_server_event`` are plain functions over dicts/strings. Mirrors
the sibling STT service's wire-protocol test philosophy: pin the exact
JSON shape at this process boundary (see ``testing.md``'s "Wire /
protocol contract" defensive-test category).
"""

from __future__ import annotations

import json

import pytest

from chatterbox_tts.pipeline_events import (
    Done,
    ErrorEvent,
    Ready,
    Started,
    VoiceCreated,
    VoiceDeleted,
    VoiceListResult,
    WarningEvent,
)
from chatterbox_tts.wire_protocol import (
    CancelMessage,
    EndMessage,
    FlushMessage,
    PingMessage,
    TextMessage,
    VoiceCreateMessage,
    VoiceDeleteMessage,
    VoiceListMessage,
    WireProtocolError,
    encode_server_event,
    parse_client_message,
)

# -----------------------------------------------------------------------------
# Client -> server parsing
# -----------------------------------------------------------------------------


def test_parse_text_message():
    msg = parse_client_message(json.dumps({"type": "text", "text": "hello there"}))
    assert msg == TextMessage(text="hello there")


def test_parse_flush_message():
    assert parse_client_message(json.dumps({"type": "flush"})) == FlushMessage()


def test_parse_end_message():
    assert parse_client_message(json.dumps({"type": "end"})) == EndMessage()


def test_parse_cancel_message():
    assert parse_client_message(json.dumps({"type": "cancel"})) == CancelMessage()


def test_parse_ping_message():
    assert parse_client_message(json.dumps({"type": "ping"})) == PingMessage()


def test_parse_voice_create_message():
    msg = parse_client_message(json.dumps({"type": "voice.create", "name": "Alice"}))
    assert msg == VoiceCreateMessage(name="Alice")


def test_parse_voice_create_with_description_and_tags() -> None:
    msg = parse_client_message(
        json.dumps({"type": "voice.create", "name": "Nova", "description": "Warm", "tags": ["warm", "calm"]})
    )
    assert isinstance(msg, VoiceCreateMessage)
    assert msg.name == "Nova"
    assert msg.description == "Warm"
    assert msg.tags == ["warm", "calm"]


def test_parse_voice_create_defaults_description_and_tags() -> None:
    msg = parse_client_message(json.dumps({"type": "voice.create", "name": "Nova"}))
    assert isinstance(msg, VoiceCreateMessage)
    assert msg.description == ""
    assert msg.tags == []


def test_parse_voice_create_rejects_non_string_tags() -> None:
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "voice.create", "name": "Nova", "tags": [1, 2]}))


def test_parse_voice_list_message():
    assert parse_client_message(json.dumps({"type": "voice.list"})) == VoiceListMessage()


def test_parse_voice_delete_message():
    msg = parse_client_message(json.dumps({"type": "voice.delete", "voiceId": "abc123"}))
    assert msg == VoiceDeleteMessage(voice_id="abc123")


def test_parse_invalid_json_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message("{not json")


def test_parse_non_object_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps(["type", "text"]))


def test_parse_unknown_type_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "bogus"}))


def test_parse_text_missing_field_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "text"}))


def test_parse_voice_create_missing_name_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "voice.create"}))


def test_parse_voice_delete_missing_voice_id_raises():
    with pytest.raises(WireProtocolError):
        parse_client_message(json.dumps({"type": "voice.delete"}))


# -----------------------------------------------------------------------------
# Server -> client encoding
# -----------------------------------------------------------------------------


def test_encode_ready_event():
    payload, binary = encode_server_event(Ready(format="pcm", sample_rate=24000, voice=None))
    assert payload == {"type": "ready", "format": "pcm", "sample_rate": 24000, "voice": None}
    assert binary is None
    # Round trips through the actual wire encoding (json.dumps/loads).
    assert json.loads(json.dumps(payload)) == payload


def test_encode_started_event():
    payload, binary = encode_server_event(Started(request_id="req-1"))
    assert payload == {"type": "started", "requestId": "req-1"}
    assert binary is None


def test_encode_done_event():
    evt = Done(request_id="req-1", ttfa_ms=120.5, rtf=0.31, audio_seconds=2.75)
    payload, binary = encode_server_event(evt)
    assert payload == {
        "type": "done",
        "requestId": "req-1",
        "ttfa_ms": 120.5,
        "rtf": 0.31,
        "audio_seconds": 2.75,
    }
    assert binary is None
    assert json.loads(json.dumps(payload)) == payload


def test_encode_warning_event():
    payload, binary = encode_server_event(WarningEvent(reason="unexpected_binary_frame"))
    assert payload == {"type": "warning", "reason": "unexpected_binary_frame"}
    assert binary is None


def test_encode_error_event():
    payload, binary = encode_server_event(ErrorEvent(reason="reference clip too short"))
    assert payload == {"type": "error", "reason": "reference clip too short"}
    assert binary is None


def test_encode_voice_created_event():
    evt = VoiceCreated(voice_id="v1", name="Alice", created_at=1234.5)
    payload, binary = encode_server_event(evt)
    assert payload == {
        "type": "voice.created",
        "voiceId": "v1",
        "name": "Alice",
        "createdAt": 1234.5,
    }
    assert binary is None


def test_encode_voice_list_event():
    voices = [{"voiceId": "v1", "name": "Alice", "createdAt": 1.0}]
    payload, binary = encode_server_event(VoiceListResult(voices=voices))
    assert payload == {"type": "voice.list", "voices": voices}
    assert binary is None


def test_encode_voice_deleted_event():
    payload, binary = encode_server_event(VoiceDeleted(voice_id="v1"))
    assert payload == {"type": "voice.deleted", "voiceId": "v1"}
    assert binary is None


def test_encode_unknown_event_raises():
    with pytest.raises(ValueError):
        encode_server_event(object())  # type: ignore[arg-type]
