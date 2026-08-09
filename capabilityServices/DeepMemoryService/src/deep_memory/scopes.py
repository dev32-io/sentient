"""Scope registry + in-memory index stub — the per-scope state layer.

Two collaborators, both keyed by ``scopeId`` and both part of "what the service
knows about a scope", so they live together here:

* :class:`ScopeRegistry` — the durable list of registered scopes and where each
  one's index lives on disk. Persisted to ``<data_root>/scope-registry.json``.
  A scope must be registered before any data op touches it; the path a scope
  registers MUST resolve inside ``data_root`` (the traversal boundary).

* :class:`InMemoryIndex` — a STUB standing in for the real engine (SQLite +
  FTS5 + sqlite-vec + MLX embeddings, next task). It stores entries verbatim,
  keyed by scope then entry id, and answers upsert / search / set-status /
  purge / rebuild with trivial deterministic semantics. Search returns stored
  entries (filtered by ``kinds`` / ``statuses``) with a placeholder
  ``similarity`` of 1.0 and sequential ranks — enough to pin the wire shape the
  gateway client codes against; real scoring lands with the real engine.

Entries are opaque ``dict`` payloads (schema in spec §5.4). This layer never
inspects entry *text* — only ids, kinds, statuses, and the refs used by purge.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .logging import get_logger

log = get_logger("scopes")

_REGISTRY_FILENAME = "scope-registry.json"

# Placeholder relevance for stub search hits. The real engine returns a cosine
# similarity in [0, 1]; the stub returns a constant so the shape is exact.
_STUB_SIMILARITY = 1.0


class ScopePathError(ValueError):
    """Raised when a register-scope index path escapes ``data_root``."""


@dataclass(frozen=True)
class ScopeRecord:
    """A registered scope and the on-disk path of its index."""

    scope_id: str
    index_path: Path


class ScopeRegistry:
    """Durable registry of scope ids -> index paths, JSON-persisted."""

    def __init__(self, data_root: Path) -> None:
        self._data_root = data_root.resolve()
        self._registry_path = self._data_root / _REGISTRY_FILENAME
        self._records: dict[str, ScopeRecord] = {}
        self._load()

    def _load(self) -> None:
        if not self._registry_path.is_file():
            return
        try:
            raw = json.loads(self._registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            log.warning("scope registry unreadable; starting empty")
            return
        for scope_id, index_path in raw.items():
            self._records[scope_id] = ScopeRecord(
                scope_id=scope_id, index_path=Path(index_path)
            )
        log.info("scope registry loaded scope_count=%d", len(self._records))

    def _persist(self) -> None:
        self._data_root.mkdir(parents=True, exist_ok=True)
        payload = {r.scope_id: str(r.index_path) for r in self._records.values()}
        tmp = self._registry_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self._registry_path)

    def register(self, scope_id: str, index_path: str) -> ScopeRecord:
        """Register (or re-point) ``scope_id`` at ``index_path``.

        The path is resolved and MUST live inside ``data_root``; otherwise
        :class:`ScopePathError` is raised (the caller maps this to HTTP 400).
        Idempotent re-registration of the same path is fine.
        """
        resolved = self._resolve_within_root(index_path)
        record = ScopeRecord(scope_id=scope_id, index_path=resolved)
        self._records[scope_id] = record
        self._persist()
        log.info("scope registered scope_id=%s", scope_id)
        return record

    def _resolve_within_root(self, index_path: str) -> Path:
        # An absolute path resolves as-is; a relative one resolves under the
        # data root. Either way the result must be contained by data_root.
        candidate = Path(index_path).expanduser()
        if not candidate.is_absolute():
            candidate = self._data_root / candidate
        resolved = candidate.resolve()
        if resolved != self._data_root and self._data_root not in resolved.parents:
            # Never echo the offending path — it can leak on-disk layout.
            raise ScopePathError("index path escapes data_root")
        return resolved

    def has(self, scope_id: str) -> bool:
        return scope_id in self._records

    def get(self, scope_id: str) -> ScopeRecord | None:
        return self._records.get(scope_id)

    def all(self) -> list[ScopeRecord]:
        return list(self._records.values())


class InMemoryIndex:
    """Stub index engine. Real SQLite/vec/FTS engine replaces this next task."""

    def __init__(self) -> None:
        self._by_scope: dict[str, dict[str, dict[str, Any]]] = {}

    def _scope(self, scope_id: str) -> dict[str, dict[str, Any]]:
        return self._by_scope.setdefault(scope_id, {})

    def upsert(self, scope_id: str, entries: list[dict[str, Any]]) -> int:
        """Store each entry verbatim, keyed by its ``id``. Idempotent by id."""
        scope = self._scope(scope_id)
        for entry in entries:
            scope[entry["id"]] = entry
        return len(entries)

    def search(
        self,
        scope_ids: list[str],
        k: int,
        kinds: list[str] | None,
        statuses: list[str] | None,
    ) -> list[dict[str, Any]]:
        """Return up to ``k`` stored entries across scopes as ranked hits.

        Stub semantics: no vector/FTS scoring. Filter by ``kinds`` / ``statuses``
        when given, then return matches with a constant ``similarity`` and
        sequential ``rank``. ``query`` and ``timeRange`` are accepted upstream
        but not applied here (the real engine implements them).
        """
        hits: list[dict[str, Any]] = []
        rank = 1
        for scope_id in scope_ids:
            for entry in self._scope(scope_id).values():
                if kinds is not None and entry.get("kind") not in kinds:
                    continue
                if statuses is not None and entry.get("status") not in statuses:
                    continue
                hits.append(
                    {"entry": entry, "similarity": _STUB_SIMILARITY, "rank": rank}
                )
                rank += 1
                if len(hits) >= k:
                    return hits
        return hits

    def set_status(
        self, scope_id: str, ids: list[str], status: str, reason: str
    ) -> int:
        """Set ``status`` (+ ``statusReason``) on each known id. Returns count."""
        scope = self._scope(scope_id)
        updated = 0
        for entry_id in ids:
            entry = scope.get(entry_id)
            if entry is None:
                continue
            entry["status"] = status
            entry["statusReason"] = reason
            updated += 1
        return updated

    def purge(self, scope_id: str, entry_filter: dict[str, Any]) -> int:
        """Hard-remove entries matching every provided filter key. Returns count."""
        scope = self._scope(scope_id)
        doomed = [
            entry_id
            for entry_id, entry in scope.items()
            if _entry_matches_filter(entry, entry_filter)
        ]
        for entry_id in doomed:
            del scope[entry_id]
        return len(doomed)

    def rebuild(self, scope_id: str) -> int:
        """Drop every entry in the scope (gateway re-feeds). Returns dropped count."""
        scope = self._scope(scope_id)
        dropped = len(scope)
        scope.clear()
        return dropped


def _entry_matches_filter(entry: dict[str, Any], entry_filter: dict[str, Any]) -> bool:
    """True when the entry matches every provided purge-filter key.

    Supported keys (spec §3.8): ``sessionId`` (matches ``sessionRef.sessionId``),
    ``sourceRef`` (exact match on the entry's ``sourceRef``), ``provenance``
    (exact match). An empty filter matches nothing — purge is never a
    scope-wipe by omission; that is what ``rebuild`` is for.
    """
    if not entry_filter:
        return False
    session_id = entry_filter.get("sessionId")
    if session_id is not None:
        ref = entry.get("sessionRef") or {}
        if ref.get("sessionId") != session_id:
            return False
    if "sourceRef" in entry_filter:
        if entry.get("sourceRef") != entry_filter["sourceRef"]:
            return False
    if "provenance" in entry_filter:
        if entry.get("provenance") != entry_filter["provenance"]:
            return False
    return True
