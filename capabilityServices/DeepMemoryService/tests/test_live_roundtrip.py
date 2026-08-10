"""End-to-end HTTP round-trip against the REAL engine — the whole wire stack
(aiohttp server, split-credential auth, the real SQLite/FTS5/sqlite-vec index,
the real MLX embedding model), not just the engine class directly.

Gated on ``DEEP_MEMORY_LIVE=1`` (free/local — MLX runs on-host, no network
cost beyond the one-time model download to the HuggingFace cache). This is
the deployment-wiring proof for task 11: the same server assembly
(``build_app`` + ``SqliteIndexEngine`` + ``MlxEmbedder``) the packaged
``python -m deep_memory`` entry point (``__main__.py`` / ``server.run_server``)
boots in production, driven purely over HTTP with temp dirs and test tokens —
proving the managed-service wiring (env-injected tokens, loopback HTTP,
health/auth/index all cooperating) works end-to-end, not just each piece in
isolation.

Distinct from the existing ``@live`` test in ``test_search.py``
(``test_live_real_model_round_trip``), which drives ``SqliteIndexEngine``
directly and never exercises the HTTP/auth layer or purge.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

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
from deep_memory.index import SqliteIndexEngine
from deep_memory.scopes import ScopeRegistry
from deep_memory.server import build_app

ADMIN_TOKEN = "live-test-admin-token"
DATA_TOKEN = "live-test-data-token"
SCOPE = "user:live-roundtrip"

# Same pinned model the shipped config.example.yaml + T9b's @live test use —
# a mismatch here would exercise a different (and untested) model entirely.
_LIVE_MODEL = "mlx-community/multilingual-e5-small-mlx"


def _entry(entry_id: str, text: str, source_ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry_id,
        "kind": "episode-summary",
        "text": text,
        "timestamp": "2026-08-08T18:00:00Z",
        "scope": SCOPE,
        "provenance": "user-speech",
        "status": "active",
        "sourceRef": source_ref,
    }


async def _call(
    client: TestClient, method: str, path: str, *, token: str, body: Any
) -> tuple[int, Any]:
    resp = await client.request(
        method, path, headers={"Authorization": f"Bearer {token}"}, json=body
    )
    return resp.status, await resp.json()


@pytest.mark.live
def test_live_http_round_trip_register_upsert_search_purge(tmp_path: Path) -> None:
    """register-scope -> upsert 2 entries -> search hit -> purge -> search empty.

    Every step is a real HTTP call through the real aiohttp app, authenticated
    with the two bearer tokens exactly as the gateway's DeepMemoryClient does
    (CONTRACT.md §2/§3) — this is the managed-service contract, end to end.
    """
    if os.environ.get("DEEP_MEMORY_LIVE") != "1":
        pytest.skip("DEEP_MEMORY_LIVE != 1")

    from deep_memory.embedder import MlxEmbedder

    data_root = (tmp_path / "scopes").resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    index_path = data_root / "live-roundtrip" / "index.db"

    config = Config(
        server=ServerConfig(host="127.0.0.1", port=0),  # port 0 = ephemeral loopback
        storage=StorageConfig(data_root=data_root),
        embedding=EmbeddingConfig(model=_LIVE_MODEL),
        index=IndexConfig(schema_version=1),
        logging=LoggingConfig(level="warning", retention_days=7),
    )
    registry = ScopeRegistry(data_root)
    engine = SqliteIndexEngine(registry, MlxEmbedder(_LIVE_MODEL), schema_version=1)
    tokens = Tokens(admin=ADMIN_TOKEN, data=DATA_TOKEN)
    app = build_app(config, registry, engine, tokens)

    source_ref = {"kind": "test-fixture", "id": "task-11-live-roundtrip"}

    async def scenario() -> None:
        async with TestClient(TestServer(app)) as client:
            # 1. health — real model id reported, proving MLX actually loaded.
            status, health = await _call(client, "GET", "/health", token=ADMIN_TOKEN, body=None)
            assert status == 200
            assert health["embeddingModel"] == _LIVE_MODEL

            # 2. register-scope (admin plane)
            status, payload = await _call(
                client,
                "POST",
                "/register-scope",
                token=ADMIN_TOKEN,
                body={"scopeId": SCOPE, "indexPath": str(index_path)},
            )
            assert status == 200
            assert payload["registered"] is True

            # 3. upsert 2 entries (data plane)
            status, payload = await _call(
                client,
                "POST",
                "/upsert",
                token=DATA_TOKEN,
                body={
                    "scopeId": SCOPE,
                    "entries": [
                        _entry("ski", "We planned a weekend ski trip to Lake Tahoe.", source_ref),
                        _entry("cook", "Discussed a recipe for braised short ribs.", source_ref),
                    ],
                },
            )
            assert status == 200
            assert payload == {"scopeId": SCOPE, "upserted": 2}

            # 4. search returns a ranked hit — the ski entry should out-rank the
            #    unrelated recipe entry for a skiing-themed query.
            status, payload = await _call(
                client,
                "POST",
                "/search",
                token=DATA_TOKEN,
                body={"scopeIds": [SCOPE], "query": "skiing vacation in the mountains", "k": 3},
            )
            assert status == 200
            assert payload["count"] >= 1
            hits = payload["hits"]
            assert all(0.0 <= h["similarity"] <= 1.0 for h in hits)
            assert hits[0]["entry"]["id"] == "ski"

            # 5. purge by sourceRef (admin plane) removes both entries
            status, payload = await _call(
                client,
                "POST",
                "/purge",
                token=ADMIN_TOKEN,
                body={"scopeId": SCOPE, "filter": {"sourceRef": source_ref}},
            )
            assert status == 200
            assert payload == {"scopeId": SCOPE, "purged": 2}

            # 6. search now returns nothing — the round trip closes clean.
            status, payload = await _call(
                client,
                "POST",
                "/search",
                token=DATA_TOKEN,
                body={"scopeIds": [SCOPE], "query": "skiing vacation in the mountains", "k": 3},
            )
            assert status == 200
            assert payload == {"hits": [], "count": 0}

    try:
        asyncio.run(scenario())
    finally:
        engine.close()
