"""Scoring-pipeline tests for the real index engine (§5.3).

Zero-cost by default (injected :class:`FakeEmbedder` with controlled vectors);
one env-gated ``@live`` test runs the real MLX model end-to-end.

Pinned: RRF fusion ordering (a mid-vector-rank entry can still out-rank a
closer one via the BM25 signal); similarity always in [0, 1] (cosine clamp);
timeRange filter narrows pre-fusion; embedding-model mismatch → 409
``rebuild_required`` at both the engine and the wire.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from deep_memory.auth import Tokens
from deep_memory.config import (
    Config,
    EmbeddingConfig,
    IndexConfig,
    LoggingConfig,
    ServerConfig,
    StorageConfig,
)
from deep_memory.index import RebuildRequiredError, SqliteIndexEngine
from deep_memory.scopes import ScopeRegistry
from deep_memory.server import build_app

from .fake_embedder import FakeEmbedder

SCOPE = "user:alice"


def _registry(tmp_path: Path) -> tuple[ScopeRegistry, Path, Path]:
    data_root = (tmp_path / "scopes").resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    registry = ScopeRegistry(data_root)
    index_path = data_root / "user-alice" / "index.db"
    registry.register(SCOPE, str(index_path))
    return registry, data_root, index_path


def _entry(entry_id: str, text: str, **overrides) -> dict:
    base = {
        "id": entry_id,
        "kind": "episode-summary",
        "text": text,
        "timestamp": "2026-08-08T18:00:00Z",
        "scope": SCOPE,
        "provenance": "user-speech",
        "status": "active",
    }
    base.update(overrides)
    return base


def test_rrf_fusion_ordering(tmp_path):
    # dim-3 control vectors + controlled text so BOTH signals are predictable.
    query = "tahoe skiing"
    vectors = {
        query: [1.0, 0.0, 0.0],
        "tahoe skiing trip": [1.0, 0.0, 0.0],  # nearest vector AND best BM25
        "grocery milk eggs": [0.9, 0.1, 0.0],  # 2nd vector, no BM25 match
        "tahoe hiking": [0.0, 1.0, 0.0],       # worst vector, but a BM25 match
    }
    registry, _root, _path = _registry(tmp_path)
    engine = SqliteIndexEngine(registry, FakeEmbedder(dim=3, vectors=vectors), schema_version=1)
    engine.upsert(
        SCOPE,
        [
            _entry("A", "tahoe skiing trip"),
            _entry("C", "grocery milk eggs"),
            _entry("B", "tahoe hiking"),
        ],
    )

    hits = engine.search([SCOPE], query, k=10, kinds=None, statuses=None, time_range=None)
    order = [h["entry"]["id"] for h in hits]
    # A wins both signals. B (weak vector, rank 3) still beats C (rank-2 vector,
    # no BM25) because the BM25 signal fuses in — the point of RRF.
    assert order == ["A", "B", "C"]
    # rank is 1-based and dense.
    assert [h["rank"] for h in hits] == [1, 2, 3]


def test_similarity_in_unit_interval(tmp_path):
    query = "identical"
    vectors = {
        query: [1.0, 0.0, 0.0],
        "doc same": [1.0, 0.0, 0.0],   # cosine 1 → similarity 1
        "doc orthogonal": [0.0, 1.0, 0.0],  # cosine 0 → similarity 0
        "doc opposite": [-1.0, 0.0, 0.0],   # cosine -1 → clamps to 0
    }
    registry, _root, _path = _registry(tmp_path)
    engine = SqliteIndexEngine(registry, FakeEmbedder(dim=3, vectors=vectors), schema_version=1)
    engine.upsert(
        SCOPE,
        [
            _entry("same", "doc same"),
            _entry("orth", "doc orthogonal"),
            _entry("opp", "doc opposite"),
        ],
    )

    hits = engine.search([SCOPE], query, k=10, kinds=None, statuses=None, time_range=None)
    by_id = {h["entry"]["id"]: h["similarity"] for h in hits}
    assert all(0.0 <= sim <= 1.0 for sim in by_id.values())
    assert by_id["same"] == pytest.approx(1.0)
    assert by_id["opp"] == pytest.approx(0.0)      # negative cosine clamped
    assert by_id["orth"] == pytest.approx(0.0)


def test_time_range_filter_actually_filters(tmp_path):
    registry, _root, _path = _registry(tmp_path)
    engine = SqliteIndexEngine(registry, FakeEmbedder(dim=8), schema_version=1)
    engine.upsert(
        SCOPE,
        [
            _entry("old", "winter note", timestamp="2026-01-01T00:00:00Z"),
            _entry("mid", "summer note", timestamp="2026-06-15T12:00:00Z"),
            _entry("new", "yearend note", timestamp="2026-12-31T23:00:00Z"),
        ],
    )

    hits = engine.search(
        [SCOPE],
        "note",
        k=10,
        kinds=None,
        statuses=None,
        time_range={"from": "2026-06-01T00:00:00Z", "to": "2026-07-01T00:00:00Z"},
    )
    assert {h["entry"]["id"] for h in hits} == {"mid"}


def test_search_rebuild_required_on_model_mismatch_engine(tmp_path):
    registry, _root, _path = _registry(tmp_path)
    # Write under model-A, then open the same on-disk index under model-B.
    SqliteIndexEngine(registry, FakeEmbedder(model_id="model-A", dim=8), schema_version=1).upsert(
        SCOPE, [_entry("x", "a fact")]
    )
    engine_b = SqliteIndexEngine(registry, FakeEmbedder(model_id="model-B", dim=8), schema_version=1)
    with pytest.raises(RebuildRequiredError):
        engine_b.search([SCOPE], "fact", k=5, kinds=None, statuses=None, time_range=None)


def test_rebuild_clears_model_mismatch(tmp_path):
    registry, _root, _path = _registry(tmp_path)
    SqliteIndexEngine(registry, FakeEmbedder(model_id="model-A", dim=8), schema_version=1).upsert(
        SCOPE, [_entry("x", "a fact")]
    )
    engine_b = SqliteIndexEngine(registry, FakeEmbedder(model_id="model-B", dim=8), schema_version=1)
    engine_b.rebuild(SCOPE)  # gateway re-feeds under the new model
    engine_b.upsert(SCOPE, [_entry("x", "a fact")])
    # After rebuild the scope is comparable again — no 409.
    hits = engine_b.search([SCOPE], "fact", k=5, kinds=None, statuses=None, time_range=None)
    assert len(hits) == 1


# --- wire-level 409 (HTTP contract) ---------------------------------------

_ADMIN, _DATA = "admin-tok", "data-tok"


def _config(data_root: Path, model_id: str) -> Config:
    return Config(
        server=ServerConfig(host="127.0.0.1", port=0),
        storage=StorageConfig(data_root=data_root),
        embedding=EmbeddingConfig(model=model_id),
        index=IndexConfig(schema_version=1),
        logging=LoggingConfig(level="warning", retention_days=7),
    )


def test_search_rebuild_required_409_wire(tmp_path):
    registry, data_root, _path = _registry(tmp_path)
    SqliteIndexEngine(registry, FakeEmbedder(model_id="model-A", dim=8), schema_version=1).upsert(
        SCOPE, [_entry("x", "a fact")]
    )
    engine_b = SqliteIndexEngine(registry, FakeEmbedder(model_id="model-B", dim=8), schema_version=1)
    app = build_app(_config(data_root, "model-B"), registry, engine_b, Tokens(admin=_ADMIN, data=_DATA))

    async def scenario():
        async with TestClient(TestServer(app)) as client:
            resp = await client.request(
                "POST", "/search",
                headers={"Authorization": f"Bearer {_DATA}"},
                json={"scopeIds": [SCOPE], "query": "fact", "k": 5},
            )
            assert resp.status == 409
            assert await resp.json() == {"error": "rebuild_required"}

    asyncio.run(scenario())


def test_health_reports_engine_model_id_wire(tmp_path):
    registry, data_root, _path = _registry(tmp_path)
    engine = SqliteIndexEngine(registry, FakeEmbedder(model_id="model-A", dim=8), schema_version=1)
    app = build_app(_config(data_root, "model-A"), registry, engine, Tokens(admin=_ADMIN, data=_DATA))

    async def scenario():
        async with TestClient(TestServer(app)) as client:
            resp = await client.request("GET", "/health")
            payload = await resp.json()
            assert payload["embeddingModel"] == "model-A"

    asyncio.run(scenario())


# --- @live: real MLX model end-to-end (env-gated, free/local) --------------

_LIVE_MODEL = "mlx-community/multilingual-e5-small-mlx"


@pytest.mark.live
def test_live_real_model_round_trip(tmp_path):
    """upsert (en + zh) → ranked hit with a real embedding. Gated on DEEP_MEMORY_LIVE=1."""
    if os.environ.get("DEEP_MEMORY_LIVE") != "1":
        pytest.skip("DEEP_MEMORY_LIVE != 1")
    from deep_memory.embedder import MlxEmbedder

    registry, _root, _path = _registry(tmp_path)
    engine = SqliteIndexEngine(registry, MlxEmbedder(_LIVE_MODEL), schema_version=1)
    engine.upsert(
        SCOPE,
        [
            _entry("ski", "We planned a weekend ski trip to Lake Tahoe."),
            _entry("cook", "Discussed a recipe for braised short ribs."),
            _entry("zh", "我们计划去太浩湖滑雪度周末。"),
        ],
    )

    hits = engine.search([SCOPE], "skiing vacation in the mountains", k=3, kinds=None, statuses=None, time_range=None)
    assert hits, "expected at least one hit"
    assert all(0.0 <= h["similarity"] <= 1.0 for h in hits)
    # The Tahoe ski entry (en or its zh paraphrase) should out-rank the recipe.
    top_id = hits[0]["entry"]["id"]
    assert top_id in {"ski", "zh"}
    assert hits[0]["entry"]["id"] != "cook"
