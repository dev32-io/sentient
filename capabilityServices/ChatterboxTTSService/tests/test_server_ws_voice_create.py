"""``voice.create`` WS coverage (Task 5 review finding: previously zero).

``conftest.py``'s ``_StubVoiceStore.create`` used to raise
``NotImplementedError`` — no non-live test exercised the ``voice.create``
+ binary-wav-upload path at all. See ``connection_session.py``'s
``_create_voice`` for the flow under test: decode -> (under the shared
synth lock) ``voice_store.create`` -> ``voice.created``, or an ``error``
frame on a ``ValueError`` rejection (e.g. clip too short) without
crashing the connection.
"""

from __future__ import annotations

import asyncio
import json

from websockets.asyncio.client import connect

from chatterbox_tts.server import Server

from .conftest import (
    _FAKE_CREATED_AT,
    _FAKE_VOICE_ID,
    _make_config,
    _RaisingVoiceStore,
    _serve,
    _StubEngine,
    _StubVoiceStore,
    _tiny_wav_bytes,
)


def test_voice_create_replies_voice_created(tmp_path):
    """``voice.create`` + a binary wav frame -> ``voice.created``."""

    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "voice.create", "name": "Test Voice"}))
                await ws.send(_tiny_wav_bytes())
                resp = json.loads(await ws.recv())
                assert resp == {
                    "type": "voice.created", "voiceId": _FAKE_VOICE_ID,
                    "name": "Test Voice", "createdAt": _FAKE_CREATED_AT,
                }
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_voice_create_rejects_without_crashing(tmp_path):
    """A ``VoiceStore.create`` rejection (e.g. clip too short) becomes an
    ``error`` frame, not a crash — connection stays usable afterward.
    """

    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _RaisingVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "voice.create", "name": "Too Short"}))
                await ws.send(_tiny_wav_bytes())
                resp = json.loads(await ws.recv())
                assert resp["type"] == "error"
                assert "too short" in resp["reason"]

                # Connection stays usable after a rejected voice.create.
                await ws.send(json.dumps({"type": "ping"}))
                pong = json.loads(await ws.recv())
                assert pong == {"type": "pong"}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())
