"""Sentient plugin — backend API routes.

Mounted at /api/plugins/sentient-plugin/ by the Hermes dashboard plugin
system. Provides the past-sessions REST surface (search / get session /
get messages / delete) that ACP doesn't cover, so the Bun gateway can call
into Hermes' SessionDB directly without re-implementing storage.

Auth: Bearer token via env var ``SENTIENT_HERMES_BEARER``. The Hermes
dashboard's built-in ``_SESSION_TOKEN`` is per-startup random and bound to
the dashboard cookie session, so external services can't use it. Plugins
mount BEFORE dashboard auth, so we layer our own bearer to keep the
endpoints from being unauthenticated on the docker network.

SessionDB API surface used (verified against /opt/hermes/hermes_state.py
inside the running container):

  - SessionDB.search_messages(query, limit, ...) -> List[Dict]
      FTS5 full-text search, returns message-level hits with snippet.
      We de-duplicate by session_id to return a session-level result set.
  - SessionDB._get_session_rich_row(session_id) -> Optional[Dict]
      Single session with the same enriched columns as list_sessions_rich
      (preview + last_active). Used after resolve_session_id() so callers
      can pass a short prefix.
  - SessionDB.get_messages(session_id) -> List[Dict]
      All messages for a session, ordered by timestamp. tool_calls
      pre-deserialised. Matches what the legacy custom-WS gateway path
      returned.
  - SessionDB.delete_session(session_id) -> bool
      True if found+deleted, False if missing.

NOTE: SessionDB also exposes ``search_sessions(source, limit, offset)``
but that is a paginated list filtered by source — NOT a query search,
despite the name. We use ``search_messages`` for the /search route.
"""

from __future__ import annotations

import hmac
import os
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

router = APIRouter()


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def _verify_bearer(authorization: str | None = Header(None)) -> None:
    """Reject request unless Authorization: Bearer <SENTIENT_HERMES_BEARER>."""

    expected = os.environ.get("SENTIENT_HERMES_BEARER", "")
    if not expected:
        # Fail closed — never serve unauthenticated traffic.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SENTIENT_HERMES_BEARER not configured",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bearer required",
        )
    token = authorization[len("Bearer ") :]
    if not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bad bearer",
        )


# ---------------------------------------------------------------------------
# SessionDB factory (lazy + override-friendly for tests)
# ---------------------------------------------------------------------------


def _session_db():
    """Return a SessionDB instance, lazy-importing Hermes internals.

    Lazy because:
      - Importing ``hermes_state`` requires HERMES_HOME to be set (the
        dashboard sets it before plugin discovery; tests don't need it).
      - Keeps this module importable in pytest without a real profile.

    Tests monkeypatch this function to return a fake.
    """

    from hermes_state import SessionDB  # noqa: PLC0415 — lazy by design

    return SessionDB()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_prefix_query(q: str) -> str:
    """Translate raw user input into an FTS5 prefix query.

    Mirrors the legacy gateway behaviour: each unquoted whitespace token
    gets a trailing ``*`` so partial words match (e.g. ``stor`` -> ``stor*``).
    Quoted phrases and tokens that already end with ``*`` are kept verbatim.
    """

    terms: list[str] = []
    for token in re.findall(r'"[^"]*"|\S+', q):
        if token.startswith('"') or token.endswith("*"):
            terms.append(token)
        else:
            terms.append(token + "*")
    return " ".join(terms)


def _dedupe_by_session(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse message-level FTS hits down to one row per session_id."""

    seen: dict[str, dict[str, Any]] = {}
    for m in matches:
        sid = m.get("session_id")
        if not sid or sid in seen:
            continue
        seen[sid] = {
            "sessionId": sid,
            "snippet": m.get("snippet", ""),
            "role": m.get("role"),
            "source": m.get("source"),
            "model": m.get("model"),
            "sessionStarted": m.get("session_started"),
        }
    return list(seen.values())


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/search", dependencies=[Depends(_verify_bearer)])
async def search(q: str = "", limit: int = 20) -> dict[str, Any]:
    """Full-text search across session messages, de-duped by session.

    Returns ``{sessions: [...], nextCursor: null}``. Empty query returns
    an empty list rather than 400 to mirror the legacy contract.
    """

    q = (q or "").strip()
    if not q:
        return {"sessions": [], "nextCursor": None}

    db = _session_db()
    prefix_query = _build_prefix_query(q)
    matches = db.search_messages(query=prefix_query, limit=limit)
    return {"sessions": _dedupe_by_session(matches), "nextCursor": None}


@router.get("/sessions/{session_id}", dependencies=[Depends(_verify_bearer)])
async def get_session(session_id: str) -> dict[str, Any]:
    """Fetch a single session row (rich: preview + last_active)."""

    db = _session_db()
    sid = db.resolve_session_id(session_id)
    row = db._get_session_rich_row(sid) if sid else None
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="session not found",
        )
    return row


@router.get(
    "/sessions/{session_id}/messages",
    dependencies=[Depends(_verify_bearer)],
)
async def get_messages(session_id: str) -> dict[str, Any]:
    """Fetch full message history for a session."""

    db = _session_db()
    sid = db.resolve_session_id(session_id)
    if not sid:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="session not found",
        )
    return {"sessionId": sid, "messages": db.get_messages(sid)}


@router.delete("/sessions/{session_id}", dependencies=[Depends(_verify_bearer)])
async def delete_session(session_id: str) -> dict[str, Any]:
    """Delete a session and its messages. 404 if not found."""

    db = _session_db()
    if not db.delete_session(session_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="session not found",
        )
    return {"ok": True, "sessionId": session_id}
