"""WebSocket entry point for the Silero + Smart-Turn v3 PoC service.

Wire protocol (server ↔ browser):

  Client → Server
    - Binary frame: raw PCM16 LE mono @ 16 kHz (any length; rechunked
      server-side to 512-sample Silero windows).
    - Text JSON ``{"type": "hello", ...}``  (optional, logged only)
    - Text JSON ``{"type": "ping"}``        (server replies ``{"type": "pong"}``)

  Server → Client
    - Text JSON ``{"type": "ready", "sampleRate": 16000, ...}``       on connect
    - Text JSON ``{"type": "vad_start", "turnIdx": ...}``
    - Text JSON ``{"type": "vad_end", "turnIdx": ...}``
    - Text JSON ``{"type": "smart_turn_eval", "turnIdx": ..., "probability": ...,
                    "prediction": ..., "evalMs": ...}``
    - Text JSON ``{"type": "turn_continuing", "turnIdx": ..., "probability": ...}``
    - Text JSON ``{"type": "turn_complete", "turnIdx": ..., "durationMs": ...,
                    "smartTurnProbability": ..., "wavBytesLen": ..., "wavPath": ...}``
      followed immediately by one binary WAV frame (the full turn audio).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import uuid
from pathlib import Path

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .event_logger import JsonlLogger
from .metrics import MetricsSampler
from .pipeline_events import PipelineEvent
from .smart_turn import SmartTurn
from .turn_pipeline import TurnPipeline, get_silero_model
from .wire_protocol import event_to_wire

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("localvad")


# ---------------------------------------------------------------------------
# Environment → config
# ---------------------------------------------------------------------------


def _env_path(key: str, default: str) -> Path:
    return Path(os.environ.get(key, default)).resolve()


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    return int(raw)


HOST = os.environ.get("LOCALVAD_HOST", "0.0.0.0")
PORT = _env_int("LOCALVAD_PORT", 8765)
MODEL_DIR = _env_path("LOCALVAD_MODEL_DIR", "/app/models")
LOG_DIR = _env_path("LOCALVAD_LOG_DIR", "/app/logs")
RECORDING_DIR = _env_path("LOCALVAD_RECORDING_DIR", "/app/recordings")
METRICS_INTERVAL_MS = _env_int("LOCALVAD_METRICS_INTERVAL_MS", 1000)


# ---------------------------------------------------------------------------
# Connection handler
# ---------------------------------------------------------------------------


class Server:
    """Owns shared models + metrics sampler; creates per-connection pipelines."""

    def __init__(self) -> None:
        self._service_log = JsonlLogger(LOG_DIR / "service.jsonl", echo_stdout=True)
        self._metrics = MetricsSampler(LOG_DIR, interval_ms=METRICS_INTERVAL_MS)
        self._smart_turn: SmartTurn | None = None

    # -- lifecycle -----------------------------------------------------------

    def start_background(self) -> None:
        self._metrics.start()
        self._service_log.log(
            "service.ready",
            host=HOST,
            port=PORT,
            model_dir=str(MODEL_DIR),
            log_dir=str(LOG_DIR),
            recording_dir=str(RECORDING_DIR),
            metrics_interval_ms=METRICS_INTERVAL_MS,
        )

    async def stop(self) -> None:
        await self._metrics.stop()
        self._service_log.log("service.stopping")
        self._service_log.close()

    def load_models(self) -> None:
        log.info("loading Silero VAD (torch JIT)…")
        get_silero_model()
        log.info("Silero VAD ready")

        log.info("loading Smart-Turn v3 ONNX from %s", MODEL_DIR)
        self._smart_turn = SmartTurn(MODEL_DIR)
        log.info("Smart-Turn ready: %s", self._smart_turn.model_path)

        self._service_log.log(
            "models.loaded",
            silero_backend="torch_jit",
            smart_turn_path=str(self._smart_turn.model_path),
        )

    # -- per-connection ------------------------------------------------------

    async def handle(self, ws: ServerConnection) -> None:
        assert self._smart_turn is not None, "load_models() must run before serve()"

        conn_id = uuid.uuid4().hex[:12]
        remote = _format_remote(ws)
        conn_log = JsonlLogger(LOG_DIR / f"conn_{conn_id}.jsonl", echo_stdout=False)

        self._service_log.log("conn.open", conn_id=conn_id, remote=remote)
        conn_log.log("conn.open", conn_id=conn_id, remote=remote)

        pipeline = TurnPipeline(
            connection_id=conn_id,
            smart_turn=self._smart_turn,
            recording_dir=RECORDING_DIR,
            logger=conn_log,
        )

        try:
            await ws.send(
                json.dumps(
                    {
                        "type": "ready",
                        "connId": conn_id,
                        "sampleRate": 16000,
                        "sileroChunkSamples": 512,
                        "pcmFormat": "int16_le_mono",
                    }
                )
            )
            await self._receive_loop(ws, pipeline, conn_log)
        except ConnectionClosed as exc:
            conn_log.log(
                "conn.closed",
                code=exc.code,
                reason=exc.reason or "",
            )
        except Exception as exc:  # noqa: BLE001 — surface every error
            log.exception("connection handler crashed: %s", exc)
            conn_log.log("conn.error", error=repr(exc))
        finally:
            pipeline.close()
            self._service_log.log("conn.close", conn_id=conn_id)
            conn_log.log("conn.close", conn_id=conn_id)
            conn_log.close()

    async def _receive_loop(
        self,
        ws: ServerConnection,
        pipeline: TurnPipeline,
        conn_log: JsonlLogger,
    ) -> None:
        bytes_received = 0
        frames_received = 0

        async for message in ws:
            if isinstance(message, bytes):
                bytes_received += len(message)
                frames_received += 1
                conn_log.log(
                    "audio.frame_recv",
                    bytes=len(message),
                    total_bytes=bytes_received,
                    total_frames=frames_received,
                )
                events = pipeline.process(message)
                for event in events:
                    await self._send_event(ws, event, conn_log)
                continue

            # Text messages: lightweight control plane.
            try:
                parsed = json.loads(message)
            except json.JSONDecodeError:
                conn_log.log("control.recv_invalid_json", raw=str(message)[:200])
                continue

            kind = parsed.get("type")
            conn_log.log("control.recv", kind=kind, payload=parsed)

            if kind == "hello":
                sample_rate = parsed.get("sampleRate")
                if sample_rate and sample_rate != 16000:
                    warning = (
                        f"client advertised sampleRate={sample_rate}, "
                        "server expects 16000 — audio may be mis-decoded"
                    )
                    conn_log.log("control.hello_mismatch", sampleRate=sample_rate)
                    await ws.send(json.dumps({"type": "warning", "message": warning}))
            elif kind == "ping":
                await ws.send(json.dumps({"type": "pong"}))

    async def _send_event(
        self,
        ws: ServerConnection,
        event: PipelineEvent,
        conn_log: JsonlLogger,
    ) -> None:
        json_payload, binary_payload = event_to_wire(event)
        text = json.dumps(json_payload)
        await ws.send(text)
        conn_log.log("ws.send_text", payload=json_payload)
        if binary_payload is not None:
            await ws.send(binary_payload)
            conn_log.log("ws.send_binary", bytes=len(binary_payload))


def _format_remote(ws: ServerConnection) -> str:
    try:
        host, port = ws.remote_address[:2]
        return f"{host}:{port}"
    except Exception:
        return "unknown"


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


async def _main() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    RECORDING_DIR.mkdir(parents=True, exist_ok=True)

    server = Server()
    server.load_models()
    server.start_background()

    stop_event = asyncio.Event()

    def _handle_signal() -> None:
        log.info("signal received; shutting down")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:  # pragma: no cover — non-POSIX
            pass

    log.info("listening on ws://%s:%d", HOST, PORT)
    # max_size=24 MiB is plenty for any single binary frame at audio rates.
    async with serve(server.handle, HOST, PORT, max_size=2**24):
        await stop_event.wait()

    await server.stop()
    log.info("shutdown complete")


def main() -> None:
    asyncio.run(_main())


if __name__ == "__main__":
    main()
