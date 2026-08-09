"""FSM/invariant tests for the real SQLite index engine (write side).

Zero-cost: a deterministic :class:`FakeEmbedder` stands in for the MLX model, so
these exercise the real SQLite + FTS5 + sqlite-vec storage without a download.
The engine's own on-disk file is opened directly where a test needs to assert
table-level invariants (idempotency, no dupes) — legitimate white-box for an
invariant test.

Pinned invariants: idempotent upsert by id (§5.3); purge-by-sessionId removes
episode + fact entries carrying the ref (§3.8); set-status transition with
reason; rebuild drops everything.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import sqlite_vec

from deep_memory.index import SqliteIndexEngine
from deep_memory.scopes import ScopeRegistry

from .fake_embedder import FakeEmbedder

SCOPE = "user:alice"


def _make_engine(
    tmp_path: Path, *, model_id: str = "fake-embedder-v1", vectors=None
) -> tuple[SqliteIndexEngine, ScopeRegistry, Path]:
    data_root = (tmp_path / "scopes").resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    registry = ScopeRegistry(data_root)
    index_path = data_root / "user-alice" / "index.db"
    registry.register(SCOPE, str(index_path))
    embedder = FakeEmbedder(model_id=model_id, vectors=vectors)
    engine = SqliteIndexEngine(registry, embedder, schema_version=1)
    return engine, registry, index_path


def _entry(entry_id: str, text: str, **overrides) -> dict:
    base = {
        "id": entry_id,
        "kind": "episode-summary",
        "text": text,
        "timestamp": "2026-08-08T18:00:00Z",
        "scope": SCOPE,
        "provenance": "user-speech",
        "status": "active",
        "createdAt": "2026-08-08T18:00:01Z",
        "statusChangedAt": "2026-08-08T18:00:01Z",
    }
    base.update(overrides)
    return base


def _table_count(index_path: Path, table: str) -> int:
    conn = sqlite3.connect(str(index_path))
    try:
        # entries_vec is a vec0 virtual table — the extension must be loaded to
        # query it, even for a plain COUNT(*).
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        conn.close()


def test_upsert_idempotent_by_id(tmp_path):
    engine, _registry, index_path = _make_engine(tmp_path)

    assert engine.upsert(SCOPE, [_entry("x", "the first version")]) == 1
    assert engine.upsert(SCOPE, [_entry("x", "the second version wins")]) == 1

    # Same id → exactly one row in every table, no dupes.
    assert _table_count(index_path, "entries") == 1
    assert _table_count(index_path, "entries_fts") == 1
    assert _table_count(index_path, "entries_vec") == 1

    # New text wins.
    hits = engine.search([SCOPE], "second version", k=5, kinds=None, statuses=None, time_range=None)
    assert len(hits) == 1
    assert hits[0]["entry"]["text"] == "the second version wins"


def test_purge_by_session_id_removes_episode_and_fact(tmp_path):
    engine, _registry, index_path = _make_engine(tmp_path)
    session_ref = {"sessionId": "sess-42", "entrySpan": [10, 24]}
    engine.upsert(
        SCOPE,
        [
            _entry("ep", "episode about hiking", kind="episode-summary", sessionRef=session_ref),
            _entry("fact", "fact distilled from that session", kind="file-section", sessionRef=session_ref),
            _entry("other", "unrelated journal note", kind="journal"),
        ],
    )
    assert _table_count(index_path, "entries") == 3

    # Both the episode summary AND the fact carry sessionRef.sessionId — both go.
    purged = engine.purge(SCOPE, {"sessionId": "sess-42"})
    assert purged == 2
    assert _table_count(index_path, "entries") == 1
    assert _table_count(index_path, "entries_fts") == 1
    assert _table_count(index_path, "entries_vec") == 1

    remaining = engine.search([SCOPE], "note", k=5, kinds=None, statuses=None, time_range=None)
    assert {h["entry"]["id"] for h in remaining} == {"other"}


def test_purge_empty_filter_is_noop(tmp_path):
    engine, _registry, index_path = _make_engine(tmp_path)
    engine.upsert(SCOPE, [_entry("a", "alpha"), _entry("b", "beta")])
    assert engine.purge(SCOPE, {}) == 0
    assert _table_count(index_path, "entries") == 2


def test_set_status_transition_with_reason(tmp_path):
    engine, _registry, _index_path = _make_engine(tmp_path)
    engine.upsert(SCOPE, [_entry("x", "a durable fact")])

    updated = engine.set_status(SCOPE, ["x"], "superseded", "dreamer-merge")
    assert updated == 1

    # No longer surfaces under an active-only filter; does under superseded.
    active = engine.search([SCOPE], "durable", k=5, kinds=None, statuses=["active"], time_range=None)
    assert active == []
    superseded = engine.search([SCOPE], "durable", k=5, kinds=None, statuses=["superseded"], time_range=None)
    assert len(superseded) == 1
    entry = superseded[0]["entry"]
    assert entry["status"] == "superseded"
    assert entry["statusReason"] == "dreamer-merge"


def test_set_status_unknown_id_not_counted(tmp_path):
    engine, _registry, _index_path = _make_engine(tmp_path)
    engine.upsert(SCOPE, [_entry("x", "present")])
    assert engine.set_status(SCOPE, ["x", "ghost"], "stale", "cleanup") == 1


def test_rebuild_drops_all(tmp_path):
    engine, _registry, index_path = _make_engine(tmp_path)
    engine.upsert(SCOPE, [_entry("a", "alpha"), _entry("b", "beta")])
    dropped = engine.rebuild(SCOPE)
    assert dropped == 2
    assert _table_count(index_path, "entries") == 0
    assert _table_count(index_path, "entries_fts") == 0
    assert _table_count(index_path, "entries_vec") == 0
