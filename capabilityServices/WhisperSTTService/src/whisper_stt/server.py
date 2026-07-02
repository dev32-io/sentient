"""WebSocket entry point for the STT service.

This file is the "main loop" of the service. It owns:
- Model loading (Silero, Smart-Turn, SenseVoice) — done once at startup.
- Metrics sampling — background task that logs CPU/RSS every second.
- WebSocket server — accepts connections, routes messages to pipelines.

Wire protocol (server <-> gateway):

  Client -> Server
    - Binary frame: raw PCM16 LE mono @ 16 kHz
    - Text JSON ``{"type": "hello", ...}``  (optional)
    - Text JSON ``{"type": "ping"}``        (server replies ``{"type": "pong"}``)

  Server -> Client
    - Text JSON events (see CONTRACT.md for the full list).
    - Binary WAV frames (one per ``turn_complete``).

Python note — ``asyncio`` event loop:
  Python's ``asyncio`` is a single-threaded cooperative scheduler, like
  Kotlin's ``Dispatchers.Main`` or Android's main-thread Looper. Only
  one coroutine runs at a time; ``await`` is where they voluntarily
  yield. This works well for I/O-bound servers (WebSocket reads/writes)
  but means CPU-bound work (model inference) blocks the loop. That's
  acceptable here because inference takes 50-800 ms and we serve 1-4
  concurrent connections — the brief blocking is tolerable.

Python note — ``async for message in ws:``:
  The ``websockets`` library provides an async iterator over incoming
  messages. ``async for`` is the async equivalent of ``for`` — it
  ``await``s each item. In Kotlin terms, think of it as
  ``ws.incoming.collect { message -> ... }``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import __version__ as STT_SERVICE_VERSION
from .config import Config
from .event_logger import JsonlLogger, RotatingJsonlLogger, prune_old_logs
from .metrics import MetricsSampler
from .opus_decoder import OpusStreamDecoder
from .pipeline_events import PipelineEvent
from .whisper_mlx import VALID_LANGUAGES, WhisperMlx
from .smart_turn import SmartTurn
from .turn_pipeline import TurnPipeline, get_silero_model
from .wire_protocol import event_to_wire

log = logging.getLogger("stt-service")

# Default SenseVoice language when a connection omits the ``?language=``
# query param. ``auto`` preserves pre-language-param behaviour: the model
# classifies language per utterance.
DEFAULT_LANGUAGE = "auto"

# Supported wire audio formats negotiated per-connection via the
# ``?audioFormat=`` URL query param. ``pcm16`` is the historical default
# (raw PCM16 LE mono @ 16 kHz). ``opus`` accepts raw opus packets per WS
# binary frame which the server decodes to PCM16 before feeding the
# TurnPipeline (xiaozhi-style cube clients use this).
AUDIO_FORMAT_PCM16 = "pcm16"
AUDIO_FORMAT_OPUS = "opus"
VALID_AUDIO_FORMATS = (AUDIO_FORMAT_PCM16, AUDIO_FORMAT_OPUS)
DEFAULT_AUDIO_FORMAT = AUDIO_FORMAT_PCM16


# ---------------------------------------------------------------------------
# Server — owns shared models + per-connection pipelines
# ---------------------------------------------------------------------------


class Server:
    """Owns shared models + metrics sampler; creates per-connection pipelines.

    Python note — ``assert ... is not None``:
      The assertions in ``handle()`` are developer-facing safety checks,
      not user-facing error handling. They verify that ``load_models()``
      was called before ``serve()`` — a programmer mistake, not a
      runtime condition. In production Python these are never compiled
      out (unlike Java's ``assert`` keyword which is off by default).
    """

    def __init__(self, config: Config) -> None:
        self._config = config
        self._service_log = RotatingJsonlLogger(
            "service", config.log_dir, echo_stdout=True,
        )
        self._metrics = MetricsSampler(
            config.log_dir,
            interval_ms=config.logging.metrics_interval_ms,
        )
        self._smart_turn: SmartTurn | None = None
        # One decode-language view is built per connection (cheap — all views
        # share the lru-cached MLX model for the same repo). No per-language
        # weight reload, so no cache/lock needed.
        self._whisper_default: WhisperMlx | None = None

    # -- lifecycle -----------------------------------------------------------

    def load_models(self) -> None:
        """Load all ML models. Called once at startup, before serving."""
        log.info("loading Silero VAD (torch JIT)...")
        get_silero_model()
        log.info("Silero VAD ready")

        smart_turn_dir = self._config.model_dir / "smart-turn"
        log.info("loading Smart-Turn v3 ONNX from %s", smart_turn_dir)
        self._smart_turn = SmartTurn(
            smart_turn_dir, config=self._config.smart_turn,
        )
        log.info("Smart-Turn ready: %s", self._smart_turn.model_path)

        log.info(
            "loading MLX Whisper (%s, language=%s)...",
            self._config.whisper.model,
            DEFAULT_LANGUAGE,
        )
        self._whisper_default = WhisperMlx(
            config=self._config.whisper,
            language=DEFAULT_LANGUAGE,
        )
        self._whisper_default.warm()
        log.info("Whisper ready: %s", self._whisper_default.model_repo)

        self._service_log.log(
            "models.loaded",
            silero_backend="torch_jit",
            smart_turn_path=str(self._smart_turn.model_path),
            whisper_model=self._whisper_default.model_repo,
            whisper_default_language=DEFAULT_LANGUAGE,
        )

    def _get_whisper(self, language: str) -> WhisperMlx:
        """Fresh per-connection Whisper view. Cheap — the model stays warm in
        ModelHolder (loaded once by ``_whisper_default`` at startup), so only
        per-connection state (the auto-detect sticky-language prior) is new.
        Per-connection isolation keeps one speaker's detected language from
        leaking into another's session."""
        return WhisperMlx(config=self._config.whisper, language=language)

    def start_background(self) -> None:
        """Start metrics sampler and log service readiness."""
        self._metrics.start()
        cfg = self._config
        self._service_log.log(
            "service.ready",
            host=cfg.server.host,
            port=cfg.server.port,
            model_dir=str(cfg.model_dir),
            log_dir=str(cfg.log_dir),
            recording_dir=str(cfg.recording_dir),
            metrics_interval_ms=cfg.logging.metrics_interval_ms,
            recordings_enabled=cfg.recordings.enabled,
        )

    async def stop(self) -> None:
        """Graceful shutdown — stop metrics and close logs."""
        await self._metrics.stop()
        self._service_log.log("service.stopping")
        self._service_log.close()

    # -- per-connection handler ----------------------------------------------

    async def handle(self, ws: ServerConnection) -> None:
        """Handle one WebSocket connection from open to close."""
        assert self._smart_turn is not None, "load_models() must run before serve()"
        assert self._whisper_default is not None, (
            "load_models() must run before serve()"
        )

        conn_id = uuid.uuid4().hex[:12]
        remote = _format_remote(ws)
        conn_log = JsonlLogger(
            self._config.log_dir / f"conn_{conn_id}.jsonl",
            echo_stdout=False,
        )

        language, language_source = _parse_language(ws)
        audio_format, audio_format_source = _parse_audio_format(ws)
        log.info(
            "conn.language conn_id=%s language=%s source=%s",
            conn_id, language, language_source,
        )
        log.info(
            "conn.audio_format conn_id=%s audio_format=%s source=%s",
            conn_id, audio_format, audio_format_source,
        )
        stt = self._get_whisper(language)

        self._service_log.log(
            "conn.open",
            conn_id=conn_id,
            remote=remote,
            language=language,
            language_source=language_source,
            audio_format=audio_format,
            audio_format_source=audio_format_source,
        )
        conn_log.log(
            "conn.open",
            conn_id=conn_id,
            remote=remote,
            language=language,
            language_source=language_source,
            audio_format=audio_format,
            audio_format_source=audio_format_source,
        )

        pipeline = TurnPipeline(
            conn_id,
            config=self._config,
            smart_turn=self._smart_turn,
            stt=stt,
            recording_dir=self._config.recording_dir,
            logger=conn_log,
        )

        # One opus decoder per connection — libopus is stateful across
        # packets within a stream (predictor / codebook context). ``None``
        # when the wire format is PCM16 (no decode needed).
        opus_decoder: OpusStreamDecoder | None = (
            OpusStreamDecoder() if audio_format == AUDIO_FORMAT_OPUS else None
        )

        try:
            # Send the ``ready`` handshake — gateway must wait for this
            # before sending audio (per CONTRACT.md section 3). ``audioFormat``
            # echoes the negotiated wire format; ``pcmFormat`` still describes
            # the downstream pipeline input (always PCM16 LE mono).
            await ws.send(
                json.dumps({
                    "type": "ready",
                    "connId": conn_id,
                    "sampleRate": 16000,
                    "sileroChunkSamples": 512,
                    "pcmFormat": "int16_le_mono",
                    "audioFormat": audio_format,
                    "stt": "whisper-large-v3-turbo-8bit",
                    "language": language,
                })
            )
            await self._receive_loop(ws, pipeline, conn_log, opus_decoder)
        except ConnectionClosed as exc:
            conn_log.log("conn.closed", code=exc.code, reason=exc.reason or "")
        except Exception as exc:
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
        opus_decoder: OpusStreamDecoder | None,
    ) -> None:
        """Main message loop for a single connection.

        When ``opus_decoder`` is non-None, each binary frame is treated as a
        single opus packet and decoded to PCM16 LE mono before being fed to
        the (codec-agnostic) TurnPipeline. When None, the binary frame is
        already PCM16 and is forwarded as-is — preserving the historical
        wire-format default for back-compat with gateways that don't pass
        ``?audioFormat=``.
        """
        bytes_received = 0
        frames_received = 0

        async for message in ws:
            # Binary frame → raw PCM16 audio, OR an opus packet to decode.
            if isinstance(message, bytes):
                bytes_received += len(message)
                frames_received += 1
                conn_log.log(
                    "audio.frame_recv",
                    bytes=len(message),
                    total_bytes=bytes_received,
                    total_frames=frames_received,
                )
                pcm = message
                if opus_decoder is not None:
                    try:
                        pcm = opus_decoder.decode_packet(message)
                    except Exception as exc:
                        # Drop the packet, keep the connection. Opus decode
                        # failures are most often per-packet (corrupt frame,
                        # network truncation) — they should NOT take the
                        # session down. Pipeline is codec-agnostic and will
                        # happily resume on the next valid packet.
                        conn_log.log(
                            "audio.opus_decode_failed",
                            error=repr(exc),
                            bytes=len(message),
                        )
                        continue
                events = pipeline.process(pcm)
                for event in events:
                    await self._send_event(ws, event, conn_log)
                continue

            # Text frame → JSON control message.
            try:
                parsed = json.loads(message)
            except json.JSONDecodeError:
                conn_log.log(
                    "control.recv_invalid_json",
                    raw=str(message)[:200],
                )
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
                    conn_log.log(
                        "control.hello_mismatch", sampleRate=sample_rate,
                    )
                    await ws.send(
                        json.dumps({"type": "warning", "message": warning}),
                    )
            elif kind == "ping":
                await ws.send(json.dumps({"type": "pong"}))

    async def _send_event(
        self,
        ws: ServerConnection,
        event: PipelineEvent,
        conn_log: JsonlLogger,
    ) -> None:
        """Serialize and send a pipeline event over the WebSocket."""
        json_payload, binary_payload = event_to_wire(event)
        text = json.dumps(json_payload, ensure_ascii=False)
        await ws.send(text)
        conn_log.log("ws.send_text", payload=json_payload)
        if binary_payload is not None:
            await ws.send(binary_payload)
            conn_log.log("ws.send_binary", bytes=len(binary_payload))


def _format_remote(ws: ServerConnection) -> str:
    """Extract the remote address from a WebSocket connection."""
    try:
        host, port = ws.remote_address[:2]
        return f"{host}:{port}"
    except Exception:
        return "unknown"


def _parse_language(ws: ServerConnection) -> tuple[str, str]:
    """Extract the SenseVoice ``language`` from the WS URL.

    Returns ``(language, source)``. ``source`` is ``"query"`` if the
    client sent ``?language=...``, ``"default"`` if no param was present,
    or ``"invalid-fallback"`` if the param was present but unrecognized
    (in which case we fall back to DEFAULT_LANGUAGE rather than rejecting
    — an unknown language shouldn't block the session entirely).

    ``ws.request.path`` contains the raw HTTP path + query from the
    upgrade request (websockets 13.x). Clients connect to
    ``ws://host:port/?language=en``.
    """
    try:
        raw_path = ws.request.path or "/"
    except AttributeError:
        return DEFAULT_LANGUAGE, "default"

    parsed = urlsplit(raw_path)
    query = parse_qs(parsed.query)
    values = query.get("language")
    if not values:
        return DEFAULT_LANGUAGE, "default"

    candidate = values[0].strip().lower()
    if candidate in VALID_LANGUAGES:
        return candidate, "query"

    log.warning(
        "conn.language_invalid candidate=%r — falling back to %s",
        candidate,
        DEFAULT_LANGUAGE,
    )
    return DEFAULT_LANGUAGE, "invalid-fallback"


def _parse_audio_format(ws: ServerConnection) -> tuple[str, str]:
    """Extract the wire audio format from the WS URL.

    Returns ``(audio_format, source)`` mirroring ``_parse_language``:
    - ``source`` is ``"query"`` if ``?audioFormat=...`` was present and
      recognized, ``"default"`` if absent, or ``"invalid-fallback"`` if
      present but unrecognized.
    - Unknown / malformed values do not reject the handshake — they fall
      back to PCM16 with a warning log (consistent with how language
      handles bogus values).

    Clients connect to ``ws://host:port/?audioFormat=opus`` (or pcm16).
    Defaults to pcm16 to preserve back-compat for callers (today's
    gateway STT adapter) that don't pass the param.
    """
    try:
        raw_path = ws.request.path or "/"
    except AttributeError:
        return DEFAULT_AUDIO_FORMAT, "default"

    parsed = urlsplit(raw_path)
    query = parse_qs(parsed.query)
    values = query.get("audioFormat")
    if not values:
        return DEFAULT_AUDIO_FORMAT, "default"

    candidate = values[0].strip().lower()
    if candidate in VALID_AUDIO_FORMATS:
        return candidate, "query"

    log.warning(
        "conn.audio_format_invalid candidate=%r — falling back to %s",
        candidate,
        DEFAULT_AUDIO_FORMAT,
    )
    return DEFAULT_AUDIO_FORMAT, "invalid-fallback"


async def _daily_prune_loop(log_dir: Path, retention_days: int) -> None:
    """Sleep until the next UTC midnight, prune, repeat.

    Runs in the asyncio event loop. The actual filesystem work happens
    inside ``prune_old_logs`` which is fast enough to call inline (a
    handful of stat+unlink calls per day) — no executor needed.
    """
    while True:
        now = datetime.now(timezone.utc)
        next_midnight = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        sleep_seconds = (next_midnight - now).total_seconds()
        try:
            await asyncio.sleep(sleep_seconds)
        except asyncio.CancelledError:
            return
        try:
            prune_old_logs(log_dir, retention_days)
        except Exception:
            # Pruning failure must never break the service. Swallow and
            # try again at the next rollover.
            log.exception("daily prune failed")


# ---------------------------------------------------------------------------
# HTTP health server — GET /health returns {"status":"ok","version":"..."}
# ---------------------------------------------------------------------------

# HTTP health port — separate from the WebSocket port (8768) so the gateway
# can query it with a plain HTTP GET without any WS upgrade handshake.
HEALTH_HTTP_PORT = 8769

_HEALTH_RESPONSE_HEADERS = (
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: application/json\r\n"
    "Connection: close\r\n"
)


async def _handle_health_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    version: str,
) -> None:
    """Handle a single HTTP connection for the /health endpoint.

    This is a minimal HTTP/1.1 responder — no routing, no keep-alive,
    no request body parsing beyond reading the first line to avoid
    stalling the writer. Any GET path returns the health JSON; anything
    else returns 405. Connections are closed after one response.
    """
    try:
        # Read enough of the request to determine method. Cap at 4 KB to
        # guard against slow-loris attacks — health probes are tiny.
        request_line = await asyncio.wait_for(reader.readline(), timeout=3.0)
        parts = request_line.decode(errors="replace").split()
        method = parts[0] if parts else "GET"
        # Drain remaining headers to unblock the writer; ignore their content.
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=3.0)
            if not line or line in (b"\r\n", b"\n"):
                break

        if method != "GET":
            writer.write(
                b"HTTP/1.1 405 Method Not Allowed\r\n"
                b"Content-Length: 0\r\n"
                b"Connection: close\r\n\r\n"
            )
            await writer.drain()
            return

        body = json.dumps({"status": "ok", "version": version}, ensure_ascii=False)
        body_bytes = body.encode()
        response = (
            _HEALTH_RESPONSE_HEADERS
            + f"Content-Length: {len(body_bytes)}\r\n\r\n"
        ).encode() + body_bytes
        writer.write(response)
        await writer.drain()
    except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def _run_health_server(host: str, version: str) -> None:
    """Start the HTTP health server and run until cancelled.

    Binds on ``HEALTH_HTTP_PORT`` (8769). The gateway fetches
    ``http://sentient-stt-service:8769/health`` at boot to discover the
    STT service version without needing a full WebSocket upgrade.
    """
    server = await asyncio.start_server(
        lambda r, w: _handle_health_connection(r, w, version),
        host,
        HEALTH_HTTP_PORT,
    )
    log.info("health endpoint listening on http://%s:%d/health", host, HEALTH_HTTP_PORT)
    try:
        await server.serve_forever()
    except asyncio.CancelledError:
        pass
    finally:
        server.close()
        await server.wait_closed()


# ---------------------------------------------------------------------------
# Entrypoint — called from __main__.py
# ---------------------------------------------------------------------------


async def run_server(config: Config) -> None:
    """Load models, start the WebSocket server, wait for shutdown signal.

    Python note — ``signal.SIGINT`` / ``signal.SIGTERM``:
      These are Unix signals that tell a process to shut down. Docker
      sends ``SIGTERM`` when you do ``docker stop``; ``SIGINT`` is what
      you get when you press Ctrl+C. We install handlers for both so
      the service shuts down cleanly in all cases. In Kotlin/Android
      you'd use ``Runtime.getRuntime().addShutdownHook(...)`` for the
      same purpose.
    """
    config.log_dir.mkdir(parents=True, exist_ok=True)
    config.recording_dir.mkdir(parents=True, exist_ok=True)

    server = Server(config)
    server.load_models()
    server.start_background()
    prune_task = asyncio.create_task(
        _daily_prune_loop(config.log_dir, config.logging.retention_days),
        name="daily-log-prune",
    )

    stop_event = asyncio.Event()

    def _handle_signal() -> None:
        log.info("signal received; shutting down")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass  # Windows doesn't support add_signal_handler

    host = config.server.host
    port = config.server.port
    max_size = config.server.max_frame_bytes
    # Health server runs alongside the WebSocket server. It binds on
    # HEALTH_HTTP_PORT (8769) and answers GET /health with the version
    # imported directly from stt_service.__init__:__version__ — single
    # source of truth, no Dockerfile ARG drift.
    health_task = asyncio.create_task(
        _run_health_server(host, STT_SERVICE_VERSION),
        name="http-health-server",
    )

    log.info("listening on ws://%s:%d", host, port)
    async with serve(
        server.handle,
        host,
        port,
        max_size=max_size,
    ):
        await stop_event.wait()

    health_task.cancel()
    prune_task.cancel()
    for task in (health_task, prune_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    await server.stop()
    log.info("shutdown complete")
