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

import numpy as np
import pytest
from websockets.asyncio.client import connect

from chatterbox_tts.server import Server

from .conftest import _make_config, _serve, _StubEngine, _StubVoiceStore

# Negotiated PCM contract values (CONTRACT.md §1.1 / audio_constants.py's
# SOURCE_SAMPLE_RATE) — literals per this file's sibling live test above;
# named here only because the tolerance check below reuses the rate twice.
_PCM_CONTRACT_SAMPLE_RATE = 24000
_PCM16_BYTES_PER_SAMPLE = 2
# Relative slack for the decoded-sample-count vs. audio_seconds*rate check:
# requesting the engine's native SOURCE_SAMPLE_RATE (24000) is an identity
# resample, so this should track tightly, but per-chunk soxr calls (no
# cross-chunk resampler state, see PcmEncoder.encode) can shift by a few
# samples at each chunk boundary.
_SAMPLE_COUNT_TOLERANCE = 0.05


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


@pytest.mark.parametrize("invalid_sample_rate", ["0", "-1", "-48000"])
def test_ready_falls_back_on_non_positive_sample_rate(tmp_path, invalid_sample_rate):
    """A ``0`` or negative ``?sample_rate=`` must fall back to the default
    at negotiation time (CONTRACT.md §1.1: "any positive integer"),
    rather than passing through and only failing later inside the worker.
    """

    async def run() -> None:
        config = _make_config(tmp_path)
        server = Server(config, _StubEngine(), _StubVoiceStore())
        ws_server, port = await _serve(server)
        try:
            url = f"ws://127.0.0.1:{port}/?sample_rate={invalid_sample_rate}"
            async with connect(url) as ws:
                ready = json.loads(await ws.recv())
                assert ready["sample_rate"] == config.default_sample_rate
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


@pytest.mark.live
def test_real_synthesis_pcm_negotiation_roundtrip(tmp_path):
    """Live: ``?format=pcm&sample_rate=24000`` negotiation streams
    decodable PCM16 audio end-to-end with the real model — the
    audiobook-reuse guarantee (Task 17). The SERVICE stays
    codec-negotiable for direct consumers like this even though the
    gateway's live path only ever requests opus (see
    ``shared/config/src/schema.ts``'s ``ttsConfigSchema``, opus-only by
    schema as of Task 17).

    The wire ``done`` event carries no ``sample_rate`` field (only
    ``requestId``/``ttfa_ms``/``rtf``/``audio_seconds`` —
    ``wire_protocol.py``'s ``_done_payload``, matching CONTRACT.md's
    ``done`` field table), so the negotiated rate is checked two ways
    instead: the ``ready`` echo (mirrors
    ``test_ready_echoes_negotiated_params``'s stub coverage, now against
    the real engine), and at the data level — 24000 is also the engine's
    native ``SOURCE_SAMPLE_RATE`` (``audio_constants.py``), so requesting
    it is an identity resample and the decoded PCM16 sample count must
    track ``done["audio_seconds"] * 24000`` closely.
    """
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
            url = f"ws://127.0.0.1:{port}/?format=pcm&sample_rate={_PCM_CONTRACT_SAMPLE_RATE}"
            async with connect(url) as ws:
                ready = json.loads(await ws.recv())
                assert ready == {
                    "type": "ready", "format": "pcm",
                    "sample_rate": _PCM_CONTRACT_SAMPLE_RATE, "voice": None,
                }

                await ws.send(json.dumps({"type": "text", "text": "Hello."}))
                await ws.send(json.dumps({"type": "end"}))

                started = json.loads(await ws.recv())
                assert started["type"] == "started"

                frames: list[bytes] = []
                done = None
                while done is None:
                    frame = await ws.recv()
                    if isinstance(frame, bytes):
                        frames.append(frame)
                    else:
                        done = json.loads(frame)
                        assert done["type"] == "done"

                assert len(frames) >= 1
                audio = b"".join(frames)
                assert len(audio) % _PCM16_BYTES_PER_SAMPLE == 0

                samples = np.frombuffer(audio, dtype="<i2")
                assert samples.size > 0
                assert np.any(samples != 0)  # plausible (non-silent) content

                assert done["requestId"] == started["requestId"]
                expected_samples = done["audio_seconds"] * _PCM_CONTRACT_SAMPLE_RATE
                assert abs(samples.size - expected_samples) <= expected_samples * _SAMPLE_COUNT_TOLERANCE
        finally:
            ws_server.close()
            await ws_server.wait_closed()

    asyncio.run(run())
