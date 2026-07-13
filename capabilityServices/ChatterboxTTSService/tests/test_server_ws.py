"""WS server tests for the Chatterbox-TTS service.

Non-live: builds a ``Server`` against a lightweight stub engine/voice
store (no MLX, no model load) and drives it over a real WebSocket on an
ephemeral loopback port — connect negotiation, ping/pong, empty
``voice.list``. The real synthesis roundtrip (``text`` -> ``end`` ->
``started`` -> binary -> ``done``) needs the actual model and is
``@pytest.mark.live`` (excluded from the default run, see
``pyproject.toml``'s ``addopts``).

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
from websockets.asyncio.server import Server as WsServer
from websockets.asyncio.server import serve

from chatterbox_tts.config import Config, HealthConfig, ServerConfig
from chatterbox_tts.server import Server

_SENTINEL_CONDS = object()


class _StubEngine:
    """Fake ``ChatterboxEngine``: no MLX model, satisfies the shape ``server.py`` needs."""

    def default_conditionals(self) -> object:
        return _SENTINEL_CONDS

    def synthesize(self, text, conds, streaming_interval, cancel):
        return iter(())  # not exercised by the non-live cases


class _StubVoiceStore:
    """Fake ``VoiceStore``: in-memory, no filesystem, no model."""

    def __init__(self) -> None:
        self._voices: list[dict] = []

    def get(self, voice_id):
        return _SENTINEL_CONDS

    def list(self) -> list[dict]:
        return list(self._voices)

    def create(self, ref_wav, sr, name):
        raise NotImplementedError("not exercised by the non-live tests")

    def delete(self, voice_id) -> bool:
        return False


def _make_config(tmp_path: Path) -> Config:
    return Config(
        schema_version=1,
        model="stub-model",
        server=ServerConfig(host="127.0.0.1", port=0, max_message_bytes=16_000_000),
        health=HealthConfig(port=0),
        default_format="opus",
        default_sample_rate=48000,
        streaming_interval=0.5,
        exaggeration=0.5,
        cfg_weight=0.5,
        voice_dir=str(tmp_path / "voices"),
        log_dir=str(tmp_path / "logs"),
        retention_days=7,
        metrics_interval_ms=0,  # disable the background psutil sampler for tests
    )


async def _serve(server: Server) -> tuple[WsServer, int]:
    """Start ``server.handle`` on an ephemeral loopback port; returns ``(ws_server, port)``."""
    ws_server = await serve(server.handle, "127.0.0.1", 0)
    port = ws_server.sockets[0].getsockname()[1]
    return ws_server, port


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
