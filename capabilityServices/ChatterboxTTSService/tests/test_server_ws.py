"""Core WS server tests for the Chatterbox-TTS service.

Non-live: builds a ``Server`` against a lightweight stub engine/voice
store (no MLX, no model load) and drives it over a real WebSocket on an
ephemeral loopback port — connect negotiation, ping/pong, ``voice.list``/
``voice.delete``, malformed-message handling. See ``conftest.py`` for the
shared stubs, and the sibling ``test_server_ws_voice_create.py`` /
``test_server_ws_concurrency.py`` for the ``voice.create`` and
disconnect/serialization coverage split out for file-size hygiene. The
real synthesis roundtrip (``text`` -> ``end`` -> ``started`` -> binary ->
``done``) needs the actual model and is ``@pytest.mark.live`` (excluded
from the default run, see ``pyproject.toml``'s ``addopts``).

No ``pytest-asyncio`` dependency: each test is a plain sync function
whose body drives an inner async function via ``asyncio.run(...)`` —
matches this service's existing dependency-light test style (see
``test_chatterbox_mlx.py``/``test_voice_store.py``'s ``@live`` split).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import connect

from chatterbox_tts.server import Server

from .conftest import _make_config, _serve, _StubEngine, _StubVoiceStore


def test_ready_echoes_negotiated_params(tmp_path):
    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/?format=pcm&sample_rate=24000") as ws:
                ready = json.loads(await ws.recv())
                assert ready == {
                    "type": "ready", "format": "pcm", "sample_rate": 24000, "voice": None,
                }
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_ready_falls_back_when_no_query_params(tmp_path):
    async def run() -> None:
        config = _make_config(tmp_path)
        server = Server(config, _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                ready = json.loads(await ws.recv())
                assert ready["format"] == config.default_format
                assert ready["sample_rate"] == config.default_sample_rate
                assert ready["voice"] is None
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_ping_pong(tmp_path):
    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "ping"}))
                pong = json.loads(await ws.recv())
                assert pong == {"type": "pong"}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_voice_list_empty(tmp_path):
    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "voice.list"}))
                resp = json.loads(await ws.recv())
                assert resp == {"type": "voice.list", "voices": []}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_voice_delete_missing_is_idempotent(tmp_path):
    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "voice.delete", "voiceId": "a" * 32}))
                resp = json.loads(await ws.recv())
                assert resp == {"type": "voice.deleted", "voiceId": "a" * 32}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


def test_malformed_message_replies_error_not_crash(tmp_path):
    async def run() -> None:
        server = Server(_make_config(tmp_path), _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            async with connect(f"ws://127.0.0.1:{port}/") as ws:
                await ws.recv()  # ready
                await ws.send("{not json")
                resp = json.loads(await ws.recv())
                assert resp["type"] == "error"

                # Connection stays usable after a malformed message.
                await ws.send(json.dumps({"type": "ping"}))
                pong = json.loads(await ws.recv())
                assert pong == {"type": "pong"}
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())


@pytest.mark.live
def test_real_synthesis_roundtrip(tmp_path):
    """Live: ``text`` -> ``end`` -> ``started`` -> >=1 binary frame -> ``done`` (``ttfa_ms>0``)."""
    from chatterbox_tts.chatterbox_mlx import ChatterboxEngine
    from chatterbox_tts.voice_store import VoiceStore

    async def run() -> None:
        config = _make_config(tmp_path)
        engine = ChatterboxEngine("mlx-community/Chatterbox-Turbo-TTS-8bit", 0.5, 0.5)
        engine.warm()
        voice_store = VoiceStore(engine, Path(config.voice_dir))
        server = Server(config, engine, voice_store)
        ws_server, port = await _serve(server)
        try:
            url = f"ws://127.0.0.1:{port}/?format=pcm&sample_rate=24000"
            async with connect(url) as ws:
                await ws.recv()  # ready
                await ws.send(json.dumps({"type": "text", "text": "Hello there, this is a test."}))
                await ws.send(json.dumps({"type": "end"}))

                started = json.loads(await ws.recv())
                assert started["type"] == "started"
                assert started["requestId"]

                binary_frames = 0
                done = None
                while done is None:
                    frame = await ws.recv()
                    if isinstance(frame, bytes):
                        binary_frames += 1
                        assert len(frame) > 0
                    else:
                        done = json.loads(frame)
                        assert done["type"] == "done"

                assert binary_frames >= 1
                assert done["requestId"] == started["requestId"]
                assert done["ttfa_ms"] > 0
                assert done["audio_seconds"] > 0
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())
