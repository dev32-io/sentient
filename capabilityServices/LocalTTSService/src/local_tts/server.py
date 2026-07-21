"""WebSocket entry point for the local-tts service.

This file owns connection *lifecycle* — accept, negotiate, tear down —
plus the process-level ``run_server`` entrypoint. Per-connection message
*routing* lives in ``connection_session.py``; the synthesis concurrency
model lives in ``synthesis.py`` + ``synth_worker.py``; the sibling
``/health`` HTTP responder lives in ``health_server.py``. See
``CONTRACT.md`` for the full wire protocol this module implements.

Wire protocol summary (see ``CONTRACT.md`` for the complete spec):

  Connect: ``ws://host:port/?format=opus|pcm&sample_rate=48000&voice=<id>``
    (all optional; unset falls back to ``config.default_format`` /
    ``config.default_sample_rate`` / the model's built-in default voice).

  Server -> Client
    - Text JSON events (see ``pipeline_events.py`` / ``wire_protocol.py``).
    - Binary frames: encoded audio chunks, streamed between ``started``
      and ``done`` for one request.

Python note — mirrors the sibling STT service's ``server.py`` shape
almost exactly (``websockets.asyncio.serve``, URL query-param
negotiation echoed on ``ready``, a second plain-HTTP port for
``/health``, graceful SIGINT/SIGTERM) — see that file for the fuller
Python/asyncio walkthrough comments.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from . import __version__ as TTS_SERVICE_VERSION
from .config import Config
from .connection_session import ConnectionSession
from .event_logger import JsonlLogger, RotatingJsonlLogger, prune_old_logs
from .health_server import run_health_server
from .metrics import MetricsSampler
from .text_frontend import build_frontend

if TYPE_CHECKING:  # pragma: no cover - import-time-only, avoids the MLX/mlx_audio
    from .synth_executor import SynthExecutor
    from .voice_store import VoiceStore

log = logging.getLogger("local-tts-service")

# ``?format=`` values accepted at connect time; anything else falls back
# to ``config.default_format`` (mirrors STT's ``VALID_AUDIO_FORMATS``
# invalid-fallback pattern).
VALID_FORMATS = ("opus", "pcm")


class _PassthroughFrontend:
    """No-op stand-in for ``TextFrontend`` when ``config.text_frontend.enabled``
    is false — duck-types ``TextFrontend.process`` so ``SynthesisRunner.flush()``
    doesn't need an enabled/disabled branch of its own.
    """

    def process(self, doc: str, lang: str) -> str:
        return doc


class Server:
    """Owns the shared engine/voice-store/lock; creates per-connection sessions."""

    def __init__(self, config: Config, executor: "SynthExecutor", voice_store: "VoiceStore") -> None:
        self._config = config
        self._executor = executor
        self._voice_store = voice_store
        # The one lock synthesis.py's module docstring requires: held for
        # the full duration of each synth request AND each voice.create,
        # across every connection this process serves.
        self._synth_lock = asyncio.Lock()
        # Built once per process, shared read-only across every connection
        # (`TextFrontend`/`_PassthroughFrontend` hold no per-connection state).
        self._frontend = (
            build_frontend(normalize_enabled=config.text_frontend.normalize)
            if config.text_frontend.enabled
            else _PassthroughFrontend()
        )
        log_dir = Path(config.log_dir)
        self._service_log = RotatingJsonlLogger("service", log_dir, echo_stdout=True)
        self._metrics_log = RotatingJsonlLogger("synth-metrics", log_dir, echo_stdout=False)
        self._metrics_sampler = MetricsSampler(log_dir, interval_ms=config.metrics_interval_ms)

    def start_background(self) -> None:
        self._metrics_sampler.start()
        cfg = self._config
        self._service_log.log(
            "service.ready", host=cfg.server.host, port=cfg.server.port,
            health_port=cfg.health.port, model=cfg.model, log_dir=cfg.log_dir,
            voice_dir=cfg.voice_dir,
        )

    async def stop(self) -> None:
        await self._metrics_sampler.stop()
        self._executor.shutdown()
        self._service_log.log("service.stopping")
        self._service_log.close()
        self._metrics_log.close()

    async def handle(self, ws: ServerConnection) -> None:
        """Handle one WebSocket connection from open to close."""
        conn_id = uuid.uuid4().hex[:12]
        fmt, sample_rate, voice = _parse_query_params(ws, self._config)
        conn_log = JsonlLogger(Path(self._config.log_dir) / f"conn_{conn_id}.jsonl", echo_stdout=False)
        self._service_log.log(
            "conn.open", conn_id=conn_id, format=fmt, sample_rate=sample_rate, voice=voice,
        )
        conn_log.log("conn.open", conn_id=conn_id, format=fmt, sample_rate=sample_rate, voice=voice)

        session = ConnectionSession(
            ws=ws, conn_id=conn_id, executor=self._executor, voice_store=self._voice_store,
            synth_lock=self._synth_lock, format_=fmt, sample_rate=sample_rate, voice=voice,
            streaming_interval=self._config.streaming_interval, default_lang=self._config.default_lang,
            conn_log=conn_log, metrics_log=self._metrics_log, frontend=self._frontend,
        )
        try:
            await session.send_ready()
            async for message in ws:
                await session.handle_message(message)
        except ConnectionClosed as exc:
            conn_log.log("conn.closed", code=exc.code, reason=exc.reason or "")
        except Exception as exc:
            log.exception("connection handler crashed: %s", exc)
            conn_log.log("conn.error", error=repr(exc))
        finally:
            await session.close()
            self._service_log.log("conn.close", conn_id=conn_id)
            conn_log.log("conn.close", conn_id=conn_id)
            conn_log.close()


def _parse_query_params(ws: ServerConnection, config: Config) -> tuple[str, int, str | None]:
    """Extract ``?format=&sample_rate=&voice=`` from the WS connect URL.

    Unknown/malformed ``format``/``sample_rate`` fall back to the
    configured default with a warning log (STT's established
    invalid-fallback pattern); a missing/unknown ``voice`` is passed
    through as-is — ``VoiceStore.get`` already resolves that to the
    default voice, so there's nothing extra to validate here.
    """
    try:
        raw_path = ws.request.path or "/"
    except AttributeError:
        raw_path = "/"
    query = parse_qs(urlsplit(raw_path).query)

    fmt = _first(query, "format")
    if fmt is None:
        fmt = config.default_format
    elif fmt not in VALID_FORMATS:
        log.warning("conn.format_invalid candidate=%r falling back to %s", fmt, config.default_format)
        fmt = config.default_format

    sample_rate = _parse_sample_rate(_first(query, "sample_rate"), config.default_sample_rate)
    voice = _first(query, "voice")
    return fmt, sample_rate, voice


def _parse_sample_rate(candidate: str | None, default: int) -> int:
    if candidate is None:
        return default
    try:
        parsed = int(candidate)
    except ValueError:
        log.warning("conn.sample_rate_invalid candidate=%r falling back to %d", candidate, default)
        return default
    if parsed <= 0:
        log.warning("conn.sample_rate_invalid candidate=%r falling back to %d", candidate, default)
        return default
    return parsed


def _first(query: dict[str, list[str]], key: str) -> str | None:
    values = query.get(key)
    return values[0].strip() if values else None


async def _daily_prune_loop(log_dir: Path, retention_days: int) -> None:
    """Sleep until the next UTC midnight, prune rotated logs, repeat."""
    while True:
        now = datetime.now(timezone.utc)
        next_midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        try:
            await asyncio.sleep((next_midnight - now).total_seconds())
        except asyncio.CancelledError:
            return
        try:
            prune_old_logs(log_dir, retention_days)
        except Exception:
            log.exception("daily prune failed")


# ---------------------------------------------------------------------------
# Entrypoint — called from __main__.py
# ---------------------------------------------------------------------------


def _install_signal_handlers(stop_event: asyncio.Event) -> None:
    """Wire SIGINT/SIGTERM to set ``stop_event``, triggering graceful shutdown."""

    def _handle_signal() -> None:
        log.info("signal received; shutting down")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass  # not supported on this platform (e.g. Windows)


async def _cancel_and_wait(*tasks: "asyncio.Task[None]") -> None:
    for task in tasks:
        task.cancel()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass


async def run_server(config: Config, executor: "SynthExecutor", voice_store: "VoiceStore") -> None:
    """Start the WebSocket + health servers, wait for a shutdown signal."""
    Path(config.log_dir).mkdir(parents=True, exist_ok=True)

    server = Server(config, executor, voice_store)
    server.start_background()
    prune_task = asyncio.create_task(
        _daily_prune_loop(Path(config.log_dir), config.retention_days), name="daily-log-prune",
    )
    health_task = asyncio.create_task(
        run_health_server(config.server.host, config.health.port, TTS_SERVICE_VERSION),
        name="http-health-server",
    )

    stop_event = asyncio.Event()
    _install_signal_handlers(stop_event)

    log.info("listening on ws://%s:%d", config.server.host, config.server.port)
    async with serve(
        server.handle, config.server.host, config.server.port, max_size=config.server.max_message_bytes,
    ):
        await stop_event.wait()

    await _cancel_and_wait(health_task, prune_task)
    await server.stop()
    log.info("shutdown complete")
