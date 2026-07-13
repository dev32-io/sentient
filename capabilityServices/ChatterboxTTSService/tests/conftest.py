"""Shared non-live WS-test fixtures for ``test_server_ws*.py``.

Split out of ``test_server_ws.py`` purely for file-size hygiene (this
project's line cap applies under ``capabilityServices/**`` too) once the
Task 5 review added enough new test scenarios (voice.create coverage,
the abrupt-disconnect worker-thread regression, the cross-connection
serialization invariant) to push a single file over the cap. All the
stub engine/voice-store classes here are dependency-light: no MLX, no
filesystem, no real model — see each class's own docstring.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import soundfile as sf
from websockets.asyncio.server import Server as WsServer
from websockets.asyncio.server import serve

from chatterbox_tts.config import Config, HealthConfig, ServerConfig
from chatterbox_tts.server import Server

_SENTINEL_CONDS = object()

# A fixed fake ``voiceId``/``createdAt`` pair, so ``_StubVoiceStore.create``
# behaves deterministically without touching any real id/clock scheme.
_FAKE_VOICE_ID = "b" * 32
_FAKE_CREATED_AT = 1_700_000_000.0


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

    def get_or_default(self, voice_id):
        return _SENTINEL_CONDS

    def list(self) -> list[dict]:
        return list(self._voices)

    def create(self, ref_wav, sr, name):
        result = {"voiceId": _FAKE_VOICE_ID, "name": name, "createdAt": _FAKE_CREATED_AT}
        self._voices.append(result)
        return result

    def delete(self, voice_id) -> bool:
        return False


class _RaisingVoiceStore(_StubVoiceStore):
    """``create()`` always rejects — simulates a too-short reference clip."""

    def create(self, ref_wav, sr, name):
        raise ValueError("too short")


def _tiny_wav_bytes(seconds: float = 0.05, sr: int = 24000) -> bytes:
    """A small, real, decodable WAV — enough to pass ``_decode_wav``, whose
    correctness (not clip-duration policy, which is ``VoiceStore``'s job)
    is all these tests need.
    """
    samples = np.zeros(int(seconds * sr), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="FLOAT")
    return buf.getvalue()


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
