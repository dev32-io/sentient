"""The real index engine — per-scope SQLite + FTS5 + sqlite-vec.

This replaces the in-memory stub (:class:`deep_memory.scopes.InMemoryIndex`) with
the real thing. It exposes the SAME method surface the HTTP server calls
(``upsert`` / ``search`` / ``set_status`` / ``purge`` / ``rebuild``) so the server
is engine-agnostic; the stub survives only as a zero-cost test double for the
wire-contract tests.

**Per scope, one SQLite database** at the path the gateway registered
(:class:`deep_memory.scopes.ScopeRegistry` resolves scopeId → indexPath). Each
database holds:

* ``meta`` — ``schema_version`` and ``embedding_model_id`` rows. If the stored
  model id ever differs from the configured embedder, search refuses with
  ``rebuild_required`` (the vectors are incomparable across models) and startup
  logs a WARN.
* ``entries`` — one row per index entry: filter columns (``kind`` / ``status`` /
  ``provenance`` / ``ts_epoch`` / ``session_id`` / ``source_ref``) plus the full
  entry JSON, returned verbatim in search hits.
* ``entries_fts`` — an FTS5 table over entry text (BM25 signal).
* ``entries_vec`` — a sqlite-vec ``vec0`` table of embeddings (cosine signal).

**Idempotent upsert by id:** each entry is delete-then-insert across all three
tables, so re-feeding the same id replaces it (new text wins) with no dupes —
which is what makes the dreamer's deterministic ids and `rebuild` converge.

**Content discipline:** never logs entry text or queries — ids, kinds, counts,
scope ids only.
"""

from __future__ import annotations

import json
import sqlite3
import struct
from datetime import datetime, timezone
from typing import Any

import sqlite_vec

from .embedder import Embedder
from .logging import get_logger
from .scopes import ScopeRegistry
from .search import build_fts_match, search_scopes

log = get_logger("index")

_META_SCHEMA_VERSION = "schema_version"
_META_EMBEDDING_MODEL = "embedding_model_id"


class RebuildRequiredError(RuntimeError):
    """Raised by search when a scope's stored embedding model != the configured one.

    The server maps this to HTTP 409 ``{"error": "rebuild_required"}``: the stored
    vectors were produced by a different model and cannot be compared to fresh
    query vectors, so the gateway must ``rebuild`` (re-feed) the scope.
    """


def _serialize(vector: list[float]) -> bytes:
    """Pack a float vector into sqlite-vec's little-endian float32 blob layout."""
    return struct.pack(f"{len(vector)}f", *vector)


def _to_epoch(iso: Any) -> int | None:
    """Parse an ISO-8601 timestamp to a UTC epoch second, or ``None`` if unparseable."""
    if not isinstance(iso, str) or not iso:
        return None
    try:
        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


class SqliteIndexEngine:
    """Per-scope SQLite/FTS5/sqlite-vec index. Real replacement for the stub."""

    def __init__(
        self, registry: ScopeRegistry, embedder: Embedder, schema_version: int
    ) -> None:
        self._registry = registry
        self._embedder = embedder
        self._schema_version = schema_version
        self._conns: dict[str, sqlite3.Connection] = {}
        self._mismatched: set[str] = set()

    @property
    def embedding_model_id(self) -> str:
        """The loaded model id — recorded per scope and reported by /health."""
        return self._embedder.model_id

    # -- connection + schema ------------------------------------------------

    def _connect(self, scope_id: str) -> sqlite3.Connection:
        cached = self._conns.get(scope_id)
        if cached is not None:
            return cached
        record = self._registry.get(scope_id)
        if record is None:
            # The server checks registration before dispatch; this is a guard.
            raise KeyError(scope_id)
        path = record.index_path
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path))
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        self._ensure_schema(conn, scope_id)
        self._conns[scope_id] = conn
        return conn

    def _ensure_schema(self, conn: sqlite3.Connection, scope_id: str) -> None:
        dim = self._embedder.dim
        conn.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS entries("
            "id TEXT PRIMARY KEY, kind TEXT, status TEXT, provenance TEXT, "
            "audience TEXT, ts_epoch INTEGER, session_id TEXT, source_ref TEXT, "
            "entry_json TEXT NOT NULL)"
        )
        conn.execute("CREATE INDEX IF NOT EXISTS entries_status ON entries(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind)")
        conn.execute("CREATE INDEX IF NOT EXISTS entries_ts ON entries(ts_epoch)")
        conn.execute("CREATE INDEX IF NOT EXISTS entries_session ON entries(session_id)")
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, text)"
        )
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec "
            f"USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[{dim}])"
        )
        self._reconcile_meta(conn, scope_id)
        conn.commit()

    def _reconcile_meta(self, conn: sqlite3.Connection, scope_id: str) -> None:
        stored_model = self._read_meta(conn, _META_EMBEDDING_MODEL)
        if stored_model is None:
            # Fresh database — stamp the current schema + model.
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                (_META_SCHEMA_VERSION, str(self._schema_version)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                (_META_EMBEDDING_MODEL, self._embedder.model_id),
            )
            return
        if stored_model != self._embedder.model_id:
            self._mismatched.add(scope_id)
            log.warning(
                "embedding model mismatch scope_id=%s rebuild_required (stored != configured)",
                scope_id,
            )

    @staticmethod
    def _read_meta(conn: sqlite3.Connection, key: str) -> str | None:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row is not None else None

    def check_scopes_on_startup(self) -> None:
        """Open every registered scope whose DB exists, to WARN on model mismatch early."""
        for record in self._registry.all():
            if record.index_path.exists():
                try:
                    self._connect(record.scope_id)
                except (sqlite3.Error, KeyError) as exc:  # noqa: PERF203
                    log.warning("scope open failed scope_id=%s err=%s", record.scope_id, type(exc).__name__)

    # -- write ops ----------------------------------------------------------

    def upsert(self, scope_id: str, entries: list[dict[str, Any]]) -> int:
        conn = self._connect(scope_id)
        texts = [str(entry.get("text", "")) for entry in entries]
        embeddings = self._embedder.embed_documents(texts)
        for entry, embedding in zip(entries, embeddings, strict=True):
            self._write_entry(conn, entry, embedding)
        conn.commit()
        return len(entries)

    def _write_entry(
        self, conn: sqlite3.Connection, entry: dict[str, Any], embedding: list[float]
    ) -> None:
        entry_id = entry["id"]
        session_ref = entry.get("sessionRef") or {}
        session_id = session_ref.get("sessionId") if isinstance(session_ref, dict) else None
        source_ref = entry.get("sourceRef")
        source_ref_json = (
            json.dumps(source_ref, sort_keys=True) if source_ref is not None else None
        )
        # Delete-then-insert across all three tables = idempotent upsert by id.
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        conn.execute("DELETE FROM entries_fts WHERE id = ?", (entry_id,))
        conn.execute("DELETE FROM entries_vec WHERE id = ?", (entry_id,))
        conn.execute(
            "INSERT INTO entries("
            "id, kind, status, provenance, audience, ts_epoch, session_id, source_ref, entry_json"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                entry_id,
                entry.get("kind"),
                entry.get("status"),
                entry.get("provenance"),
                entry.get("audience"),
                _to_epoch(entry.get("timestamp")),
                session_id,
                source_ref_json,
                json.dumps(entry),
            ),
        )
        conn.execute(
            "INSERT INTO entries_fts(id, text) VALUES (?, ?)",
            (entry_id, str(entry.get("text", ""))),
        )
        conn.execute(
            "INSERT INTO entries_vec(id, embedding) VALUES (?, ?)",
            (entry_id, _serialize(embedding)),
        )

    def set_status(
        self, scope_id: str, ids: list[str], status: str, reason: str
    ) -> int:
        conn = self._connect(scope_id)
        now = datetime.now(timezone.utc).isoformat()
        updated = 0
        for entry_id in ids:
            row = conn.execute(
                "SELECT entry_json FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
            if row is None:
                continue
            entry = json.loads(row[0])
            entry["status"] = status
            entry["statusReason"] = reason
            entry["statusChangedAt"] = now
            conn.execute(
                "UPDATE entries SET status = ?, entry_json = ? WHERE id = ?",
                (status, json.dumps(entry), entry_id),
            )
            updated += 1
        conn.commit()
        return updated

    def purge(self, scope_id: str, entry_filter: dict[str, Any]) -> int:
        conn = self._connect(scope_id)
        where_sql, params = self._build_purge_where(entry_filter)
        if where_sql is None:
            return 0  # empty filter never matches — use rebuild to drop a scope
        doomed = [
            row[0]
            for row in conn.execute(
                f"SELECT id FROM entries WHERE {where_sql}", params
            ).fetchall()
        ]
        for entry_id in doomed:
            conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            conn.execute("DELETE FROM entries_fts WHERE id = ?", (entry_id,))
            conn.execute("DELETE FROM entries_vec WHERE id = ?", (entry_id,))
        conn.commit()
        return len(doomed)

    def rebuild(self, scope_id: str) -> int:
        conn = self._connect(scope_id)
        dropped = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        conn.execute("DELETE FROM entries")
        conn.execute("DELETE FROM entries_fts")
        conn.execute("DELETE FROM entries_vec")
        conn.commit()
        # A dropped scope is no longer mismatched — the re-feed uses the current model.
        self._mismatched.discard(scope_id)
        return int(dropped)

    # -- search -------------------------------------------------------------

    def search(
        self,
        scope_ids: list[str],
        query: str,
        k: int,
        kinds: list[str] | None,
        statuses: list[str] | None,
        time_range: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        conns: dict[str, sqlite3.Connection] = {}
        for scope_id in scope_ids:
            if scope_id in self._mismatched:
                raise RebuildRequiredError(scope_id)
            conn = self._connect(scope_id)
            if scope_id in self._mismatched:  # set during connect for a re-opened DB
                raise RebuildRequiredError(scope_id)
            conns[scope_id] = conn
        qvec_blob = _serialize(self._embedder.embed_query(query))
        fts_match = build_fts_match(query)
        where_sql, where_params = self._build_search_where(kinds, statuses, time_range)
        return search_scopes(conns, qvec_blob, fts_match, where_sql, where_params, k)

    # -- filter builders ----------------------------------------------------

    @staticmethod
    def _build_search_where(
        kinds: list[str] | None,
        statuses: list[str] | None,
        time_range: dict[str, Any] | None,
    ) -> tuple[str, list[Any]]:
        clauses = ["1 = 1"]
        params: list[Any] = []
        if kinds:
            clauses.append(f"e.kind IN ({','.join('?' * len(kinds))})")
            params.extend(kinds)
        if statuses:
            clauses.append(f"e.status IN ({','.join('?' * len(statuses))})")
            params.extend(statuses)
        SqliteIndexEngine._append_time_range(clauses, params, time_range, alias="e.")
        return " AND ".join(clauses), params

    @staticmethod
    def _build_purge_where(
        entry_filter: dict[str, Any],
    ) -> tuple[str | None, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        session_id = entry_filter.get("sessionId")
        if session_id is not None:
            clauses.append("session_id = ?")
            params.append(session_id)
        if "sourceRef" in entry_filter:
            clauses.append("source_ref = ?")
            params.append(json.dumps(entry_filter["sourceRef"], sort_keys=True))
        if "provenance" in entry_filter:
            clauses.append("provenance = ?")
            params.append(entry_filter["provenance"])
        SqliteIndexEngine._append_time_range(
            clauses, params, entry_filter.get("timeRange"), alias=""
        )
        if not clauses:
            return None, []
        return " AND ".join(clauses), params

    @staticmethod
    def _append_time_range(
        clauses: list[str], params: list[Any], time_range: Any, alias: str
    ) -> None:
        if not isinstance(time_range, dict):
            return
        start = _to_epoch(time_range.get("start"))
        end = _to_epoch(time_range.get("end"))
        if start is not None:
            clauses.append(f"{alias}ts_epoch >= ?")
            params.append(start)
        if end is not None:
            clauses.append(f"{alias}ts_epoch <= ?")
            params.append(end)

    def close(self) -> None:
        for conn in self._conns.values():
            conn.close()
        self._conns.clear()
