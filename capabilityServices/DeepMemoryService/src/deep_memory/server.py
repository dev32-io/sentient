"""HTTP server — routes, auth gating, body validation, stub dispatch.

The aiohttp application exposes the §5.2 endpoints. Each endpoint is wrapped by
:func:`_endpoint`, which enforces the credential plane, parses+validates the
JSON body, and only then calls the handler with a ready :class:`ServiceContext`.
Index work is delegated to the in-memory stub in :mod:`deep_memory.scopes`.

Error contract (JSON body ``{"error": <code>}``):
  * ``401 unauthorized``          — missing / unrecognized bearer
  * ``403 forbidden``             — data token on an admin endpoint
  * ``403 unknown_scope``         — data op names an unregistered scope
  * ``400 bad_request``           — malformed / missing-field body
  * ``400 path_outside_data_root``— register-scope path escapes data_root
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from aiohttp import web

from . import __version__
from .auth import Plane, Tokens, authenticate, plane_satisfies
from .config import Config
from .index import RebuildRequiredError
from .logging import get_logger
from .scopes import IndexEngine, ScopePathError, ScopeRegistry

log = get_logger("server")

# Default result cap for search when the client omits/!k. Kept in code (not
# YAML) — it is a protocol default of the API, not an operator tuning knob.
_DEFAULT_SEARCH_K = 10


@dataclass(frozen=True)
class ServiceContext:
    """Everything a handler needs, assembled once at startup."""

    config: Config
    registry: ScopeRegistry
    index: IndexEngine
    tokens: Tokens


# Typed application key (aiohttp's recommended, warning-free way to stash state).
_CTX_KEY: web.AppKey[ServiceContext] = web.AppKey("deep_memory_ctx", ServiceContext)


Handler = Callable[[web.Request, dict[str, Any], ServiceContext], Awaitable[web.StreamResponse]]


def _error(status: int, code: str) -> web.Response:
    return web.json_response({"error": code}, status=status)


def _endpoint(required_plane: Plane, handler: Handler) -> Callable[[web.Request], Awaitable[web.StreamResponse]]:
    """Wrap a handler with plane auth + JSON body parsing."""

    async def wrapped(request: web.Request) -> web.StreamResponse:
        ctx: ServiceContext = request.app[_CTX_KEY]
        plane = authenticate(request.headers.get("Authorization"), ctx.tokens)
        if plane is None:
            return _error(401, "unauthorized")
        if not plane_satisfies(plane, required_plane):
            return _error(403, "forbidden")
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 — any parse failure is a bad body
            return _error(400, "bad_request")
        if not isinstance(body, dict):
            return _error(400, "bad_request")
        return await handler(request, body, ctx)

    return wrapped


# ---------------------------------------------------------------------------
# Body field helpers — return None to signal "malformed" (caller -> 400).
# ---------------------------------------------------------------------------


def _str_field(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value else None


def _str_list_field(body: dict[str, Any], key: str) -> list[str] | None:
    value = body.get(key)
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(v, str) and v for v in value):
        return None
    return value


def _opt_str_list(filters: dict[str, Any], key: str) -> list[str] | None:
    value = filters.get(key)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        return None
    return value


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------


async def _handle_register_scope(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_id = _str_field(body, "scopeId")
    index_path = _str_field(body, "indexPath")
    if scope_id is None or index_path is None:
        return _error(400, "bad_request")
    try:
        record = ctx.registry.register(scope_id, index_path)
    except ScopePathError:
        return _error(400, "path_outside_data_root")
    return web.json_response(
        {"scopeId": record.scope_id, "indexPath": str(record.index_path), "registered": True}
    )


async def _handle_upsert(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_id = _str_field(body, "scopeId")
    entries = body.get("entries")
    if scope_id is None or not isinstance(entries, list):
        return _error(400, "bad_request")
    if not all(isinstance(e, dict) and isinstance(e.get("id"), str) and e.get("id") for e in entries):
        return _error(400, "bad_request")
    if not ctx.registry.has(scope_id):
        return _error(403, "unknown_scope")
    upserted = ctx.index.upsert(scope_id, entries)
    log.info("upsert scope_id=%s count=%d", scope_id, upserted)
    return web.json_response({"scopeId": scope_id, "upserted": upserted})


async def _handle_search(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_ids = _str_list_field(body, "scopeIds")
    query = body.get("query")
    if scope_ids is None or not isinstance(query, str):
        return _error(400, "bad_request")
    k = body.get("k", _DEFAULT_SEARCH_K)
    if not isinstance(k, int) or isinstance(k, bool) or k <= 0:
        return _error(400, "bad_request")
    filters = body.get("filters") or {}
    if not isinstance(filters, dict):
        return _error(400, "bad_request")
    for scope_id in scope_ids:
        if not ctx.registry.has(scope_id):
            return _error(403, "unknown_scope")
    kinds = _opt_str_list(filters, "kinds")
    statuses = _opt_str_list(filters, "statuses")
    time_range = filters.get("timeRange")
    if time_range is not None and not isinstance(time_range, dict):
        return _error(400, "bad_request")
    try:
        hits = ctx.index.search(scope_ids, query, k, kinds, statuses, time_range)
    except RebuildRequiredError:
        # Stored vectors were produced by a different embedding model; the gateway
        # must rebuild (re-feed) the scope before search can compare them.
        log.warning("search refused reason=rebuild_required scope_count=%d", len(scope_ids))
        return _error(409, "rebuild_required")
    log.info("search scope_count=%d hit_count=%d", len(scope_ids), len(hits))
    return web.json_response({"hits": hits, "count": len(hits)})


async def _handle_set_status(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_id = _str_field(body, "scopeId")
    ids = _str_list_field(body, "ids")
    status = _str_field(body, "status")
    reason = body.get("reason", "")
    if scope_id is None or ids is None or status is None or not isinstance(reason, str):
        return _error(400, "bad_request")
    if not ctx.registry.has(scope_id):
        return _error(403, "unknown_scope")
    updated = ctx.index.set_status(scope_id, ids, status, reason)
    log.info("set_status scope_id=%s status=%s count=%d", scope_id, status, updated)
    return web.json_response({"scopeId": scope_id, "updated": updated})


async def _handle_purge(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_id = _str_field(body, "scopeId")
    entry_filter = body.get("filter")
    if scope_id is None or not isinstance(entry_filter, dict):
        return _error(400, "bad_request")
    if not ctx.registry.has(scope_id):
        return _error(403, "unknown_scope")
    purged = ctx.index.purge(scope_id, entry_filter)
    log.info("purge scope_id=%s count=%d", scope_id, purged)
    return web.json_response({"scopeId": scope_id, "purged": purged})


async def _handle_rebuild(
    _request: web.Request, body: dict[str, Any], ctx: ServiceContext
) -> web.StreamResponse:
    scope_id = _str_field(body, "scopeId")
    if scope_id is None:
        return _error(400, "bad_request")
    if not ctx.registry.has(scope_id):
        return _error(403, "unknown_scope")
    dropped = ctx.index.rebuild(scope_id)
    log.info("rebuild scope_id=%s dropped=%d", scope_id, dropped)
    return web.json_response({"scopeId": scope_id, "dropped": dropped, "status": "dropped"})


async def _handle_health(request: web.Request) -> web.StreamResponse:
    ctx: ServiceContext = request.app[_CTX_KEY]
    # The real engine reports its loaded model id; the stub (wire tests) has no
    # model and reports null. The contract field is a nullable string either way.
    return web.json_response(
        {
            "status": "ok",
            "version": __version__,
            "embeddingModel": ctx.index.embedding_model_id,
            "indexSchemaVersion": ctx.config.index.schema_version,
        }
    )


def build_app(config: Config, registry: ScopeRegistry, index: IndexEngine, tokens: Tokens) -> web.Application:
    """Assemble the aiohttp application with its context and routes."""
    app = web.Application()
    app[_CTX_KEY] = ServiceContext(config=config, registry=registry, index=index, tokens=tokens)
    app.add_routes(
        [
            web.post("/register-scope", _endpoint(Plane.ADMIN, _handle_register_scope)),
            web.post("/upsert", _endpoint(Plane.DATA, _handle_upsert)),
            web.post("/search", _endpoint(Plane.DATA, _handle_search)),
            web.post("/set-status", _endpoint(Plane.DATA, _handle_set_status)),
            web.post("/purge", _endpoint(Plane.ADMIN, _handle_purge)),
            web.post("/rebuild", _endpoint(Plane.ADMIN, _handle_rebuild)),
            web.get("/health", _handle_health),
        ]
    )
    return app


def run_server(config: Config, tokens: Tokens) -> None:
    """Blocking entry point — build the app and serve on the configured loopback.

    Production wiring: the real SQLite/FTS5/sqlite-vec engine backed by the MLX
    embedder. The model loads eagerly here so ``/health`` reports it and the
    first query isn't cold; startup then WARNs on any scope whose stored model id
    no longer matches (those scopes refuse search until rebuilt).
    """
    from .embedder import MlxEmbedder
    from .index import SqliteIndexEngine

    registry = ScopeRegistry(config.storage.data_root)
    embedder = MlxEmbedder(config.embedding.model)
    embedder.load()
    engine = SqliteIndexEngine(registry, embedder, config.index.schema_version)
    engine.check_scopes_on_startup()
    app = build_app(config, registry, engine, tokens)
    log.info("deep-memory listening host=%s port=%d", config.server.host, config.server.port)
    web.run_app(app, host=config.server.host, port=config.server.port, print=None)
