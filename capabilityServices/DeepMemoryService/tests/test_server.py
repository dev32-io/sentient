"""Wire-contract + auth-plane tests for the deep-memory HTTP service.

These pin a process-boundary contract (gateway <-> deep-memory) and a security
boundary (split-credential auth), which is exactly what the testing rules say a
test is for. Zero cost: no network, no model, no keys — an in-process aiohttp
TestServer over the in-memory stub.

The per-endpoint fixtures under ``tests/fixtures/`` are authoritative: the
happy-path tests assert the live response equals the fixture's ``response``
(after substituting the env-specific ``<DATA_ROOT>`` token). The gateway client
task (T10) codes against the same fixtures.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any

from aiohttp.test_utils import TestClient, TestServer

from deep_memory import __version__
from deep_memory.auth import Tokens
from deep_memory.config import (
    Config,
    EmbeddingConfig,
    IndexConfig,
    LoggingConfig,
    ServerConfig,
    StorageConfig,
)
from deep_memory.scopes import InMemoryIndex, ScopeRegistry
from deep_memory.server import build_app

ADMIN_TOKEN = "admin-token-CONSTANT-TIME"
DATA_TOKEN = "data-token-CONSTANT-TIME"
SCOPE = "user:alice"

_FIXTURE_DIR = Path(__file__).parent / "fixtures"
_DATA_ROOT_TOKEN = "<DATA_ROOT>"


# ---------------------------------------------------------------------------
# Fixtures + harness
# ---------------------------------------------------------------------------


def _load_fixture(name: str) -> dict[str, Any]:
    return json.loads((_FIXTURE_DIR / name).read_text(encoding="utf-8"))


def _substitute(value: Any, data_root: str) -> Any:
    """Recursively replace the <DATA_ROOT> token with the live data root."""
    if isinstance(value, str):
        return value.replace(_DATA_ROOT_TOKEN, data_root)
    if isinstance(value, list):
        return [_substitute(v, data_root) for v in value]
    if isinstance(value, dict):
        return {k: _substitute(v, data_root) for k, v in value.items()}
    return value


class _Harness:
    """A fresh app + isolated on-disk state root for one test scenario."""

    def __init__(self, tmp_path: Path) -> None:
        self.data_root = (tmp_path / "scopes").resolve()
        self.data_root.mkdir(parents=True, exist_ok=True)
        self.config = Config(
            server=ServerConfig(host="127.0.0.1", port=0),
            storage=StorageConfig(data_root=self.data_root),
            embedding=EmbeddingConfig(model="test-embedding-model"),
            index=IndexConfig(schema_version=1),
            logging=LoggingConfig(level="warning", retention_days=7),
        )
        self.registry = ScopeRegistry(self.data_root)
        self.index = InMemoryIndex()
        self.tokens = Tokens(admin=ADMIN_TOKEN, data=DATA_TOKEN)
        self.app = build_app(self.config, self.registry, self.index, self.tokens)

    def sub(self, value: Any) -> Any:
        return _substitute(value, str(self.data_root))


@contextlib.asynccontextmanager
async def _running(harness: _Harness):
    async with TestClient(TestServer(harness.app)) as client:
        yield client


async def _call(
    client: TestClient,
    method: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    raw: str | None = None,
) -> tuple[int, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    kwargs: dict[str, Any] = {"headers": headers}
    if raw is not None:
        kwargs["data"] = raw
    elif body is not None:
        kwargs["json"] = body
    resp = await client.request(method, path, **kwargs)
    try:
        payload = await resp.json()
    except Exception:  # noqa: BLE001
        payload = None
    return resp.status, payload


def _run(coro) -> None:
    asyncio.run(coro)


async def _register(client: TestClient, harness: _Harness, index_path: str | None = None) -> None:
    path = index_path or str(harness.data_root / "user-alice" / "index.db")
    status, _ = await _call(
        client, "POST", "/register-scope",
        token=ADMIN_TOKEN, body={"scopeId": SCOPE, "indexPath": path},
    )
    assert status == 200


async def _seed_entries(client: TestClient, harness: _Harness) -> None:
    """Register the scope and upsert the two canonical fixture entries."""
    await _register(client, harness)
    upsert = _load_fixture("upsert.json")
    status, payload = await _call(client, "POST", "/upsert", token=DATA_TOKEN, body=upsert["request"])
    assert status == 200
    assert payload == upsert["response"]


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_health_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("health.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "GET", "/health")
            assert status == 200
            assert payload == fixture["response"]
            assert payload["version"] == __version__

    _run(scenario())


# ---------------------------------------------------------------------------
# register-scope (admin)
# ---------------------------------------------------------------------------


def test_register_scope_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("register-scope.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(
                client, "POST", "/register-scope",
                token=ADMIN_TOKEN, body=harness.sub(fixture["request"]),
            )
            assert status == 200
            assert payload == harness.sub(fixture["response"])

    _run(scenario())


def test_register_scope_path_outside_data_root_400(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            escaping = str(harness.data_root / ".." / "escape" / "index.db")
            status, payload = await _call(
                client, "POST", "/register-scope",
                token=ADMIN_TOKEN, body={"scopeId": SCOPE, "indexPath": escaping},
            )
            assert status == 400
            assert payload == {"error": "path_outside_data_root"}

    _run(scenario())


def test_register_scope_data_token_forbidden_403(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(
                client, "POST", "/register-scope",
                token=DATA_TOKEN,
                body={"scopeId": SCOPE, "indexPath": str(harness.data_root / "x" / "index.db")},
            )
            assert status == 403
            assert payload == {"error": "forbidden"}

    _run(scenario())


def test_register_scope_malformed_body_400(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(
                client, "POST", "/register-scope",
                token=ADMIN_TOKEN, body={"scopeId": SCOPE},  # missing indexPath
            )
            assert status == 400
            assert payload == {"error": "bad_request"}

    _run(scenario())


# ---------------------------------------------------------------------------
# upsert (data)
# ---------------------------------------------------------------------------


def test_upsert_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("upsert.json")

    async def scenario():
        async with _running(harness) as client:
            await _register(client, harness)
            status, payload = await _call(client, "POST", "/upsert", token=DATA_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_upsert_unknown_scope_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("upsert.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "POST", "/upsert", token=DATA_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "unknown_scope"}

    _run(scenario())


def test_upsert_admin_token_also_valid(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("upsert.json")

    async def scenario():
        async with _running(harness) as client:
            await _register(client, harness)
            # Admin token is a superset — it must be accepted on data endpoints.
            status, payload = await _call(client, "POST", "/upsert", token=ADMIN_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_upsert_malformed_body_400(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            await _register(client, harness)
            status, payload = await _call(client, "POST", "/upsert", token=DATA_TOKEN, raw="this is not json")
            assert status == 400
            assert payload == {"error": "bad_request"}

    _run(scenario())


# ---------------------------------------------------------------------------
# search (data)
# ---------------------------------------------------------------------------


def test_search_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("search.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/search", token=DATA_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_search_unknown_scope_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("search.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "POST", "/search", token=DATA_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "unknown_scope"}

    _run(scenario())


# ---------------------------------------------------------------------------
# set-status (data)
# ---------------------------------------------------------------------------


def test_set_status_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("set-status.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/set-status", token=DATA_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_set_status_unknown_scope_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("set-status.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "POST", "/set-status", token=DATA_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "unknown_scope"}

    _run(scenario())


# ---------------------------------------------------------------------------
# purge (admin)
# ---------------------------------------------------------------------------


def test_purge_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("purge.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/purge", token=ADMIN_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_purge_data_token_forbidden_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("purge.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/purge", token=DATA_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "forbidden"}

    _run(scenario())


def test_purge_unknown_scope_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("purge.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "POST", "/purge", token=ADMIN_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "unknown_scope"}

    _run(scenario())


# ---------------------------------------------------------------------------
# rebuild (admin)
# ---------------------------------------------------------------------------


def test_rebuild_happy_shape(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("rebuild.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/rebuild", token=ADMIN_TOKEN, body=fixture["request"])
            assert status == 200
            assert payload == fixture["response"]

    _run(scenario())


def test_rebuild_data_token_forbidden_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("rebuild.json")

    async def scenario():
        async with _running(harness) as client:
            await _seed_entries(client, harness)
            status, payload = await _call(client, "POST", "/rebuild", token=DATA_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "forbidden"}

    _run(scenario())


def test_rebuild_unknown_scope_403(tmp_path):
    harness = _Harness(tmp_path)
    fixture = _load_fixture("rebuild.json")

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(client, "POST", "/rebuild", token=ADMIN_TOKEN, body=fixture["request"])
            assert status == 403
            assert payload == {"error": "unknown_scope"}

    _run(scenario())


# ---------------------------------------------------------------------------
# Auth plane — missing / invalid bearer
# ---------------------------------------------------------------------------


def test_missing_token_unauthorized_401(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            # data endpoint, no Authorization header
            status, payload = await _call(client, "POST", "/search", body={"scopeIds": [SCOPE], "query": "x"})
            assert status == 401
            assert payload == {"error": "unauthorized"}
            # admin endpoint, no header
            status2, payload2 = await _call(client, "POST", "/rebuild", body={"scopeId": SCOPE})
            assert status2 == 401
            assert payload2 == {"error": "unauthorized"}

    _run(scenario())


def test_invalid_token_unauthorized_401(tmp_path):
    harness = _Harness(tmp_path)

    async def scenario():
        async with _running(harness) as client:
            status, payload = await _call(
                client, "POST", "/upsert", token="not-a-real-token", body={"scopeId": SCOPE, "entries": []}
            )
            assert status == 401
            assert payload == {"error": "unauthorized"}

    _run(scenario())
