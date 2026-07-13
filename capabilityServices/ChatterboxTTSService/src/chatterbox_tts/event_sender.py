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
import logging
from typing import Any, Protocol

from websockets.exceptions import ConnectionClosed

from .pipeline_events import ErrorEvent, ServerEvent
from .wire_protocol import encode_server_event

log = logging.getLogger("chatterbox_tts.event_sender")


class _SendsFrames(Protocol):
    """Structural stand-in for ``websockets.asyncio.server.ServerConnection``.

    Kept as a local ``Protocol`` (like ``encoders/base.py``'s
    ``AudioEncoder``) so this module never has to import the
    ``websockets`` package just for a type hint.
    """

    async def send(self, data: str | bytes) -> None: ...


def _safe_log(logger: Any, event: str, **fields: Any) -> None:
    """Best-effort log call — an I/O failure here must never propagate and
    kill the caller (``error-handling.md``); a missing/failing ``logger``
    degrades to a module-level warning instead of raising. Shared by
    ``send_server_event`` (below) and ``synthesis.py``'s request-lifecycle
    logging so both sides guard the same way instead of duplicating it.
    """
    if logger is None:
        return
    try:
        logger.log(event, **fields)
    except Exception:
        log.warning("event_sender.log_failed event=%s", event, exc_info=True)


async def send_server_event(ws: _SendsFrames, evt: ServerEvent, conn_log: Any = None) -> None:
    """Encode ``evt`` and send it over ``ws`` (text frame, + binary follow-up if any)."""
    payload, binary = encode_server_event(evt)
    await ws.send(json.dumps(payload, ensure_ascii=False))
    _safe_log(conn_log, "ws.send_text", payload=payload)
    if binary is not None:
        await ws.send(binary)
        _safe_log(conn_log, "ws.send_binary", bytes=len(binary))


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
