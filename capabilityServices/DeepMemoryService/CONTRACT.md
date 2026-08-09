# Deep-memory — Service Contract

A loopback HTTP service that indexes scoped text and answers ranked search. It
is a **dumb index engine**: scope ids + text in, ranked hits out. It knows
nothing about users or sessions — the gateway owns all of that and reaches this
service through a named `DeepMemoryClient` interface. Design: `docs/superpowers/
specs/2026-08-08-memory-system-design.md` §5.

> **Scaffold status.** The HTTP surface, the split-credential auth plane, and
> the persisted scope registry are real. The index operations run against an
> **in-memory stub** (constant `similarity`, insertion-order ranks); the real
> engine (SQLite + FTS5 + sqlite-vec + MLX embeddings) lands in the next task.
> `GET /health` reports `embeddingModel: null` until that engine loads a model.

## 1. Connection

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Protocol        | HTTP/1.1, JSON request + response bodies                  |
| Default endpoint| `http://127.0.0.1:8770` (loopback ONLY — never bind LAN)  |
| Authentication  | Bearer token, two planes (see §2)                         |

## 2. Auth — two planes

Two bearer tokens, injected as env vars (`DEEP_MEMORY_ADMIN_TOKEN`,
`DEEP_MEMORY_DATA_TOKEN`), never on disk in config. Send as
`Authorization: Bearer <token>`.

- **admin** — `register-scope`, `purge`, `rebuild` (mutate scope topology / wipe data).
- **data** — `upsert`, `search`, `set-status` (hot-path data ops).

The admin token is a **superset**: accepted on data endpoints too. The data
token is **rejected** on admin endpoints. Token comparison is constant-time.

## 3. Endpoints

| Method | Path              | Plane | Body → Response                                                                 |
| ------ | ----------------- | ----- | ------------------------------------------------------------------------------- |
| POST   | `/register-scope` | admin | `{scopeId, indexPath}` → `{scopeId, indexPath, registered:true}`                 |
| POST   | `/upsert`         | data  | `{scopeId, entries[]}` → `{scopeId, upserted}`                                   |
| POST   | `/search`         | data  | `{scopeIds[], query, k?, filters?}` → `{hits:[{entry, similarity, rank}], count}`|
| POST   | `/set-status`     | data  | `{scopeId, ids[], status, reason?}` → `{scopeId, updated}`                       |
| POST   | `/purge`          | admin | `{scopeId, filter}` → `{scopeId, purged}`                                        |
| POST   | `/rebuild`        | admin | `{scopeId}` → `{scopeId, dropped, status:"dropped"}`                             |
| GET    | `/health`         | none  | → `{status:"ok", version, embeddingModel, indexSchemaVersion}`                   |

`filters` (search): `{timeRange?, kinds?, statuses?}`. `filter` (purge):
`{sessionId? | sourceRef? | provenance? | timeRange?}` — all provided keys must
match; an empty filter matches nothing (use `rebuild` to drop a scope). Entry
schema: spec §5.4. Canonical request/response bodies per endpoint live in
`tests/fixtures/*.json` (authoritative — the gateway client codes against them).

## 4. Errors — `{"error": <code>}`

| Status | Code                    | When                                             |
| ------ | ----------------------- | ------------------------------------------------ |
| 401    | `unauthorized`          | missing or unrecognized bearer                   |
| 403    | `forbidden`             | data token on an admin endpoint                  |
| 403    | `unknown_scope`         | a data/admin op names an unregistered scope      |
| 400    | `bad_request`           | malformed JSON / missing / wrong-typed field     |
| 400    | `path_outside_data_root`| register-scope indexPath escapes `data_root`     |
