"""Per-connection message router for the Chatterbox-TTS WS server.

Owns the ``ready`` handshake, routing parsed client messages
(text/flush/end/cancel/ping/voice.*) to the right handler, the
``voice.create`` binary-upload buffering, and this connection's
``SynthesisRunner``. Kept separate from ``server.py`` (which owns
connection *lifecycle*: accept, health endpoint, signals) so each file
stays under the project's line cap.

Locking note: ``voice.list``/``voice.delete`` never touch the shared
model singleton, so they run without the synth lock. Qwen3-TTS's
``VoiceStore.create`` only writes a reference wav to disk — it doesn't
touch the shared model the way the retired Chatterbox engine's
``prepare_conditionals`` did — but ``voice.create`` still runs under the
same ``synth_lock`` ``SynthesisRunner`` uses for text synthesis, kept
for simplicity rather than because it's still load-bearing. It runs via
``asyncio.to_thread`` (like the synth worker thread) rather than inline,
so the file write doesn't stall the event loop for every other
connection waiting on that same lock.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
from typing import TYPE_CHECKING, Any

import numpy as np
import soundfile as sf

from .event_sender import send_server_event
from .pipeline_events import ErrorEvent, Ready, VoiceCreated, VoiceDeleted, VoiceListResult, WarningEvent
from .synthesis import SynthesisRunner
from .wire_protocol import (
    CancelMessage,
    EndMessage,
    FlushMessage,
    PingMessage,
    TextMessage,
    VoiceCreateMessage,
    VoiceDeleteMessage,
    VoiceListMessage,
    WireProtocolError,
    parse_client_message,
)

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .qwen_engine import QwenEngine  # heavy import cost for non-live tests.
    from .voice_store import VoiceStore

log = logging.getLogger("chatterbox_tts.connection_session")

_PONG_PAYLOAD = json.dumps({"type": "pong"})

# Cap on the logged `type` hint pulled from a malformed client message —
# a client could put an arbitrarily long string there; keep log lines
# bounded (`logging.md`: truncate string previews to <=120 chars).
_TYPE_HINT_MAX_LEN = 120


class ConnectionSession:
    """Routes one WebSocket connection's messages; owns its ``SynthesisRunner``."""

    def __init__(
        self,
        *,
        ws: Any,
        conn_id: str,
        engine: "QwenEngine",
        voice_store: "VoiceStore",
        synth_lock: asyncio.Lock,
        format_: str,
        sample_rate: int,
        voice: str | None,
        streaming_interval: float,
        default_lang: str,
        conn_log: Any,
        metrics_log: Any,
    ) -> None:
        self._ws = ws
        self._voice_store = voice_store
        self._synth_lock = synth_lock
        self._format = format_
        self._sample_rate = sample_rate
        self._voice = voice
        self._conn_log = conn_log
        self._pending_voice_create: VoiceCreateMessage | None = None
        self._synth = SynthesisRunner(
            engine=engine, voice_store=voice_store, synth_lock=synth_lock, ws=ws,
            conn_id=conn_id, format_=format_, sample_rate=sample_rate, voice=voice,
            streaming_interval=streaming_interval, default_lang=default_lang,
            conn_log=conn_log, metrics_log=metrics_log,
        )

    async def send_ready(self) -> None:
        evt = Ready(format=self._format, sample_rate=self._sample_rate, voice=self._voice)
        await send_server_event(self._ws, evt, self._conn_log)

    async def close(self) -> None:
        await self._synth.close()

    async def handle_message(self, message: str | bytes) -> None:
        if isinstance(message, bytes):
            await self._handle_binary(message)
        else:
            await self._handle_text(message)

    async def _handle_text(self, raw: str) -> None:
        try:
            msg = parse_client_message(raw)
        except WireProtocolError as exc:
            self._conn_log.log(
                "control.recv_invalid", raw_len=len(raw), msg_type=_type_hint(raw), error=str(exc),
            )
            await send_server_event(self._ws, ErrorEvent(reason=str(exc)), self._conn_log)
            return
        self._conn_log.log("control.recv", kind=type(msg).__name__)
        await self._route(msg)

    async def _route(self, msg: Any) -> None:
        if isinstance(msg, TextMessage):
            self._synth.add_text(msg.text)
        elif isinstance(msg, (FlushMessage, EndMessage)):
            self._synth.flush()
        elif isinstance(msg, CancelMessage):
            self._synth.cancel_current()
        elif isinstance(msg, PingMessage):
            await self._ws.send(_PONG_PAYLOAD)
        elif isinstance(msg, VoiceCreateMessage):
            self._pending_voice_create = msg
        elif isinstance(msg, VoiceListMessage):
            await send_server_event(
                self._ws, VoiceListResult(voices=self._voice_store.list()), self._conn_log,
            )
        elif isinstance(msg, VoiceDeleteMessage):
            await self._handle_voice_delete(msg.voice_id)

    async def _handle_voice_delete(self, voice_id: str) -> None:
        try:
            deleted = self._voice_store.delete(voice_id)
        except ValueError as exc:
            await send_server_event(self._ws, ErrorEvent(reason=str(exc)), self._conn_log)
            return
        if not deleted:
            log.info("voice.delete missing voice_id=%s", voice_id)
        await send_server_event(self._ws, VoiceDeleted(voice_id=voice_id), self._conn_log)

    async def _handle_binary(self, data: bytes) -> None:
        pending = self._pending_voice_create
        if pending is None:
            self._conn_log.log("binary.unexpected", bytes=len(data))
            await send_server_event(self._ws, WarningEvent(reason="unexpected_binary_frame"), self._conn_log)
            return
        self._pending_voice_create = None
        await self._create_voice(pending, data)

    async def _create_voice(self, pending: VoiceCreateMessage, audio_bytes: bytes) -> None:
        try:
            array, sr = _decode_audio(audio_bytes)
        except Exception as exc:
            log.warning("voice.create decode_failed error=%r", exc)
            await send_server_event(
                self._ws, ErrorEvent(reason=f"invalid wav data: {exc}"), self._conn_log,
            )
            return
        try:
            async with self._synth_lock:
                result = await asyncio.to_thread(
                    self._voice_store.create, array, sr, pending.name, pending.description, pending.tags
                )
        except ValueError as exc:
            await send_server_event(self._ws, ErrorEvent(reason=str(exc)), self._conn_log)
            return
        except Exception:
            log.exception("voice.create failed name=%s", pending.name)
            await send_server_event(
                self._ws, ErrorEvent(reason="voice creation failed"), self._conn_log,
            )
            return
        evt = VoiceCreated(
            voice_id=result["voiceId"], name=result["name"], created_at=result["createdAt"],
        )
        await send_server_event(self._ws, evt, self._conn_log)


def _type_hint(raw: str) -> str | None:
    """Best-effort, structure-agnostic extraction of a malformed client
    message's ``type`` field for error-log context — never the raw
    content itself (see ``logging.md``: lengths/ids/types only, never
    text/transcript content). Only called after ``parse_client_message``
    already failed, so this must not raise on any input. Truncated to
    ``_TYPE_HINT_MAX_LEN`` — a client controls this string's length.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    kind = parsed.get("type")
    if not isinstance(kind, str):
        return None
    return kind[:_TYPE_HINT_MAX_LEN]


def _decode_audio(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode an uploaded reference clip to mono float32 PCM + its sample rate.

    Accepts any container libsndfile can read — wav / flac / ogg / **mp3**
    (libsndfile >=1.1). Content-sniffed by soundfile, so the caller need not
    declare the format. Multi-channel input is downmixed to mono.
    """
    array, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    if array.ndim > 1:
        array = array.mean(axis=1).astype(np.float32)
    return array, sr
