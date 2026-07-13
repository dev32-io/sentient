"""The one place that actually sends a server event over a WebSocket.

Split out of ``wire_protocol.py`` (which stays pure encode/decode, no
I/O) so both ``connection_session.py`` and ``synthesis.py`` share the
same "encode -> ``ws.send`` -> log" shape instead of duplicating it.
Not independently unit-tested — it's a thin wrapper around the already
-tested ``encode_server_event``, covered end-to-end by ``test_server_ws.py``
(see ``testing.md``: thin I/O wrappers around a pure, tested function
don't need their own test).
"""

from __future__ import annotations

import json
from typing import Any, Protocol

from websockets.exceptions import ConnectionClosed

from .pipeline_events import ErrorEvent, ServerEvent
from .wire_protocol import encode_server_event


class _SendsFrames(Protocol):
    """Structural stand-in for ``websockets.asyncio.server.ServerConnection``.

    Kept as a local ``Protocol`` (like ``encoders/base.py``'s
    ``AudioEncoder``) so this module never has to import the
    ``websockets`` package just for a type hint.
    """

    async def send(self, data: str | bytes) -> None: ...


async def send_server_event(ws: _SendsFrames, evt: ServerEvent, conn_log: Any = None) -> None:
    """Encode ``evt`` and send it over ``ws`` (text frame, + binary follow-up if any)."""
    payload, binary = encode_server_event(evt)
    await ws.send(json.dumps(payload, ensure_ascii=False))
    if conn_log is not None:
        conn_log.log("ws.send_text", payload=payload)
    if binary is not None:
        await ws.send(binary)
        if conn_log is not None:
            conn_log.log("ws.send_binary", bytes=len(binary))


async def send_server_event_safe(ws: _SendsFrames, evt: ServerEvent, conn_log: Any = None) -> None:
    """Best-effort ``send_server_event`` — swallows a closed-connection failure
    (nothing to tell the client if the connection it went out on is gone).
    """
    try:
        await send_server_event(ws, evt, conn_log)
    except ConnectionClosed:
        pass


async def send_error_event(ws: _SendsFrames, exc: BaseException, conn_log: Any = None) -> None:
    """Best-effort ``ErrorEvent`` send describing a failed request."""
    await send_server_event_safe(ws, ErrorEvent(reason=str(exc) or type(exc).__name__), conn_log)
