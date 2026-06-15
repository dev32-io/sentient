"""ACP-over-WebSocket bridge for sentient gateway.

Spawns ``hermes -p <profile> acp`` as a child process and bridges its
JSON-RPC stdio to a WebSocket endpoint. Bun gateway dials in over WS;
each connection gets a fresh Hermes ACP child so per-profile model
config, .env files, and provider credentials load via Hermes' canonical
CLI entry point — exactly what production already runs for ``gateway run``.

Why child-process and not in-process ``acp.run_agent(HermesACPAgent())``:
the in-process path skips Hermes' CLI-level profile bootstrap (model
resolution from ``config.yaml``, .env loading, runtime credentials),
which leaves AIAgent with an empty ``model`` field at request time.
The child-process path inherits that bootstrap for free and matches
production's per-profile process model.

Spawn is via ``asyncio.create_subprocess_exec`` (execv-style, no shell);
arguments are passed as a list, so there is no command-injection surface.

Replaces ``sentient_gateway.py`` after Phase 7 cleanup. Sentient is no
longer a Hermes platform — it's an ACP client. Per-profile process model
preserved (one supervisord program per user; this server runs the WS
endpoint and spawns the ACP child on each connection).

Module contents: WS server, WS<->child-stdio bridge.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import sys
from typing import List

import aiohttp
from aiohttp import web

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8650
AUTH_HEADER = "Authorization"
AUTH_PREFIX = "Bearer "
TASK_SHUTDOWN_TIMEOUT_S = 2.0
CHILD_GRACEFUL_SHUTDOWN_TIMEOUT_S = 5.0
HERMES_BIN = os.environ.get("HERMES_BIN", "/opt/hermes/.venv/bin/hermes")


def _setup_logging() -> None:
    """Route logging to stderr. Stdout is reserved for any future stdio
    fallback; today's WS path doesn't use it but keeping the convention
    means we can swap transports later without re-plumbing."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def _validate_bearer(request: web.Request, expected_token: str) -> bool:
    header = request.headers.get(AUTH_HEADER, "")
    if not header.startswith(AUTH_PREFIX):
        return False
    return header[len(AUTH_PREFIX) :] == expected_token


class HermesACPBridge:
    """Bridges a WebSocket to a ``hermes -p <profile> acp`` child process.

    Each WS connection spawns a fresh Hermes ACP child. We pump WS frames
    in (each one followed by ``\\n``) to the child's stdin, and each
    newline-delimited line from the child's stdout out as a WS text frame.

    Lifecycle: setup() spawns the child and starts both pump tasks;
    wait_until_done() blocks until either pump exits (WS close OR child
    exit). shutdown() terminates the child and cancels pumps.
    """

    def __init__(self, ws: web.WebSocketResponse, profile: str) -> None:
        self._ws = ws
        self._profile = profile
        self._proc: asyncio.subprocess.Process | None = None
        self._tasks: List[asyncio.Task] = []
        self._closed = False

    async def setup(self) -> None:
        """Spawn the hermes ACP child and start the pump tasks."""
        self._proc = await asyncio.create_subprocess_exec(
            HERMES_BIN,
            "-p",
            self._profile,
            "acp",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info(
            "spawned hermes acp child profile=%s pid=%s",
            self._profile,
            self._proc.pid,
        )
        self._tasks.append(asyncio.create_task(self._ws_to_child(), name="ws->child"))
        self._tasks.append(asyncio.create_task(self._child_to_ws(), name="child->ws"))
        self._tasks.append(asyncio.create_task(self._stderr_drain(), name="stderr"))

    async def _ws_to_child(self) -> None:
        """Read WS text frames; write each + '\\n' to child stdin.

        WS EOF or peer-close -> close stdin so the child sees EOF and
        terminates its receive loop cleanly.
        """
        assert self._proc is not None
        try:
            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    if self._proc.stdin is None or self._proc.stdin.is_closing():
                        break
                    self._proc.stdin.write(msg.data.encode("utf-8") + b"\n")
                    await self._proc.stdin.drain()
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.warning("ws error: %s", self._ws.exception())
                    break
        except (ConnectionResetError, BrokenPipeError):
            # Peer or child went away mid-write — normal disconnect path.
            pass
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ws->child pump crashed")
        finally:
            if self._proc.stdin is not None and not self._proc.stdin.is_closing():
                with contextlib.suppress(Exception):
                    self._proc.stdin.close()

    async def _child_to_ws(self) -> None:
        """Read newline-delimited frames from child stdout; send to WS."""
        assert self._proc is not None
        try:
            assert self._proc.stdout is not None
            while True:
                line = await self._proc.stdout.readline()
                if not line:
                    break
                # Strip trailing newline before WS frame; client parsers
                # expect bare JSON per text frame.
                text = line.rstrip(b"\n").decode("utf-8")
                if not text:
                    continue
                try:
                    await self._ws.send_str(text)
                except Exception:
                    logger.exception("ws-send-failed")
                    break
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("child->ws pump crashed")

    async def _stderr_drain(self) -> None:
        """Forward child stderr to our logger so debug output is visible.

        Hermes ACP's `_setup_logging` emits to stderr with structured prefix
        — re-emit each line at INFO so docker logs still show the trail.
        """
        assert self._proc is not None
        try:
            assert self._proc.stderr is not None
            while True:
                line = await self._proc.stderr.readline()
                if not line:
                    break
                logger.info(
                    "hermes-acp[%s]: %s",
                    self._profile,
                    line.rstrip(b"\n").decode("utf-8", errors="replace"),
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("stderr drain crashed")

    async def wait_until_done(self) -> None:
        """Wait for either data-flow pump to exit (WS close or child exit).

        Stderr drain isn't part of the wait set — it keeps draining until
        the child closes stderr, which lets late-arriving log lines surface
        in docker logs even after the data path has shut down.
        """
        if not self._tasks:
            return
        data_tasks = self._tasks[:2]
        done, _pending = await asyncio.wait(data_tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            exc = t.exception() if not t.cancelled() else None
            if exc is not None:
                logger.warning("pump task %s exited with %r", t.get_name(), exc)

    async def shutdown(self) -> None:
        """Terminate the child and cancel pumps. Idempotent."""
        if self._closed:
            return
        self._closed = True

        # Try graceful shutdown first: close stdin so the child's receive
        # loop hits EOF and exits its main_loop. Then wait briefly for
        # process exit before escalating to terminate/kill.
        if self._proc is not None:
            if self._proc.stdin is not None and not self._proc.stdin.is_closing():
                with contextlib.suppress(Exception):
                    self._proc.stdin.close()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=CHILD_GRACEFUL_SHUTDOWN_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.warning("hermes acp child did not exit; terminating pid=%s", self._proc.pid)
                with contextlib.suppress(ProcessLookupError):
                    self._proc.terminate()
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    logger.error("child unresponsive to terminate; killing pid=%s", self._proc.pid)
                    with contextlib.suppress(ProcessLookupError):
                        self._proc.kill()
                    with contextlib.suppress(Exception):
                        await self._proc.wait()

        # Cancel pump tasks.
        for task in self._tasks:
            if not task.done():
                task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError, Exception):
                await asyncio.wait_for(task, timeout=TASK_SHUTDOWN_TIMEOUT_S)


async def health_handler(request: web.Request) -> web.Response:
    return web.Response(text="ok\n")


async def acp_ws_handler(request: web.Request) -> web.WebSocketResponse:
    expected_token = request.app["expected_token"]
    if not _validate_bearer(request, expected_token):
        logger.warning("auth-failed remote=%s", request.remote)
        return web.Response(status=401, text="Unauthorized")

    profile = request.app["profile"]

    # Overlay is a dumb per-connection transport: every WS gets its own hermes
    # acp child. The gateway owns all pooling + single-flight gating (the
    # surfaceId-keyed AcpWireRegistry), so concurrent connections per profile —
    # one per surface wire plus the rest-list session-query wire — are expected
    # and coexist. We never close a "prior" connection; doing so kicked a
    # surface wire mid-session/new and stuck the client at "sending". The shared
    # profile store (state.db) is WAL-mode, so concurrent children are safe.
    ws = web.WebSocketResponse(heartbeat=30.0)
    await ws.prepare(request)
    logger.info("ws-connected profile=%s remote=%s", profile, request.remote)

    bridge = HermesACPBridge(ws, profile)
    try:
        await bridge.setup()
        await bridge.wait_until_done()
    except Exception:
        logger.exception("acp bridge crashed for profile=%s", profile)
    finally:
        await bridge.shutdown()
        if not ws.closed:
            await ws.close()
        logger.info("ws-disconnected profile=%s remote=%s", profile, request.remote)

    return ws


def build_app(profile: str, expected_token: str) -> web.Application:
    app = web.Application()
    app["profile"] = profile
    app["expected_token"] = expected_token
    app.router.add_get("/healthz", health_handler)
    app.router.add_get("/acp", acp_ws_handler)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="ACP-over-WS bridge")
    parser.add_argument("--profile", required=True, help="Hermes profile name")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--hermes-home",
        required=True,
        help=(
            "Path passed to the hermes ACP child as HERMES_HOME (the parent "
            "dir; the CLI's -p <profile> resolves the actual profile dir "
            "under <hermes-home>/profiles/<profile>/)."
        ),
    )
    args = parser.parse_args()

    _setup_logging()
    os.environ["HERMES_HOME"] = args.hermes_home

    expected_token = os.environ.get("SENTIENT_HERMES_BEARER", "")
    if not expected_token:
        logger.error("SENTIENT_HERMES_BEARER env var missing; refusing to start")
        sys.exit(1)

    app = build_app(args.profile, expected_token)
    logger.info("Starting acp_ws_server profile=%s port=%d", args.profile, args.port)
    web.run_app(app, port=args.port, print=None)


if __name__ == "__main__":
    main()
