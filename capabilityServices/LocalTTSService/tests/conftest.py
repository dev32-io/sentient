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

from local_tts.config import Config, HealthConfig, ServerConfig
from local_tts.server import Server
from local_tts.synth_executor import SynthExecutor

_SENTINEL_REF_PATH = object()

# A fixed fake ``voiceId``/``createdAt`` pair, so ``_StubVoiceStore.create``
# behaves deterministically without touching any real id/clock scheme.
_FAKE_VOICE_ID = "b" * 32
_FAKE_CREATED_AT = 1_700_000_000.0


class _StubEngine:
    """Fake ``QwenEngine``: no MLX model, satisfies the shape ``server.py`` needs."""

    def warm(self) -> None:
        pass  # no model to warm — the executor still calls this on its thread

    def synthesize(self, text, ref_audio_path, lang_code, streaming_interval, cancel):
        return iter(())  # not exercised by the non-live cases


class _StubVoiceStore:
    """Fake ``VoiceStore``: in-memory, no filesystem, no model."""

    def __init__(self) -> None:
        self._voices: list[dict] = []

    def get(self, voice_id):
        return _SENTINEL_REF_PATH

    def get_or_default(self, voice_id):
        return _SENTINEL_REF_PATH

    def list(self) -> list[dict]:
        return list(self._voices)

    def create(self, ref_wav, sr, name, description="", tags=None):
        result = {"voiceId": _FAKE_VOICE_ID, "name": name, "createdAt": _FAKE_CREATED_AT}
        self._voices.append(result)
        return result

    def delete(self, voice_id) -> bool:
        return False


class _RaisingVoiceStore(_StubVoiceStore):
    """``create()`` always rejects — simulates a too-short reference clip."""

    def create(self, ref_wav, sr, name, description="", tags=None):
        raise ValueError("too short")


def _tiny_wav_bytes(seconds: float = 0.05, sr: int = 24000) -> bytes:
    """A small, real, decodable WAV — enough to pass ``_decode_audio``, whose
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
        default_lang="auto",
        voice_dir=str(tmp_path / "voices"),
        log_dir=str(tmp_path / "logs"),
        retention_days=7,
        metrics_interval_ms=0,  # disable the background psutil sampler for tests
        builtin_voice_dir=str(tmp_path / "builtin_voices"),
        voice_description_max_len=240,
        voice_tag_max_len=24,
        voice_max_tags=8,
    )


def _make_server(config: Config, engine, voice_store) -> Server:
    """Build a ``Server`` wired to a warmed ``SynthExecutor`` around ``engine``.

    The service now runs all MLX work on the executor's single thread (see
    ``synth_executor.py``), so tests construct the server the same way
    ``__main__`` does — the stub/live engine is warmed on that thread here.
    The executor thread is a daemon, reaped when the test process exits.
    """
    executor = SynthExecutor(engine)
    executor.start_and_warm()
    return Server(config, executor, voice_store)


async def _serve(server: Server) -> tuple[WsServer, int]:
    """Start ``server.handle`` on an ephemeral loopback port; returns ``(ws_server, port)``."""
    ws_server = await serve(server.handle, "127.0.0.1", 0)
    port = ws_server.sockets[0].getsockname()[1]
    return ws_server, port
