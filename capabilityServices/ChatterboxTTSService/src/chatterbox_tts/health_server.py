"""Sibling plain-HTTP ``/health`` responder — a second port next to the WS server.

Split out of ``server.py`` purely for file-size hygiene. Mirrors the STT
service's ``_run_health_server``/``_handle_health_connection`` verbatim
(minimal HTTP/1.1, no routing, no keep-alive, closes after one response),
generalized to take the port as a parameter instead of a hardcoded
constant — this service's health port is already a required YAML key
(``config.health.port``, see ``config.py``).
"""

from __future__ import annotations

import asyncio
import json
import logging

log = logging.getLogger("chatterbox_tts.health_server")


_READ_TIMEOUT_S = 3.0  # health probes are tiny; a slow/stuck client just gets dropped


async def _read_request_method(reader: asyncio.StreamReader) -> str:
    """Read the request line + discard headers; return the HTTP method."""
    request_line = await asyncio.wait_for(reader.readline(), timeout=_READ_TIMEOUT_S)
    parts = request_line.decode(errors="replace").split()
    method = parts[0] if parts else "GET"
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout=_READ_TIMEOUT_S)
        if not line or line in (b"\r\n", b"\n"):
            break
    return method


def _ok_response(version: str) -> bytes:
    body = json.dumps({"status": "ok", "version": version}, ensure_ascii=False).encode()
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n"
        + f"Content-Length: {len(body)}\r\n\r\n".encode()
        + body
    )


_METHOD_NOT_ALLOWED = b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


async def handle_health_connection(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, version: str,
) -> None:
    """Handle a single HTTP connection for the /health endpoint.

    Any GET path returns ``{"status":"ok","version":...}``; anything else
    returns 405. Reads and discards headers to avoid stalling the writer,
    then closes — no keep-alive, health probes are one-shot.
    """
    try:
        method = await _read_request_method(reader)
        writer.write(_ok_response(version) if method == "GET" else _METHOD_NOT_ALLOWED)
        await writer.drain()
    except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def run_health_server(host: str, port: int, version: str) -> None:
    """Start the HTTP health server and run until cancelled."""
    server = await asyncio.start_server(
        lambda r, w: handle_health_connection(r, w, version), host, port,
    )
    log.info("health endpoint listening on http://%s:%d/health", host, port)
    try:
        await server.serve_forever()
    except asyncio.CancelledError:
        pass
    finally:
        server.close()
        await server.wait_closed()
