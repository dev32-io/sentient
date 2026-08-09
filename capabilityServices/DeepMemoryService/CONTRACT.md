# Deep-memory — Service Contract

A loopback HTTP service that indexes scoped text and answers ranked search. It
is a **dumb index engine**: scope ids + text in, ranked hits out. It knows
nothing about users or sessions — the gateway owns all of that and reaches this
service through a named `DeepMemoryClient` interface. Design: `docs/superpowers/
specs/2026-08-08-memory-system-design.md` §5.

> **Engine status.** Fully live. Index operations run on the real engine —
> per-scope SQLite with FTS5 + sqlite-vec, MLX multilingual embeddings, and the
> pinned §5.3 pipeline (vector top-40 cosine + BM25 top-40 → RRF k=60 → dedupe →
> `{entry, similarity, rank}`). `GET /health` reports the loaded `embeddingModel`
> id. A scope whose stored model id differs from the configured one refuses
> `/search` with `409 rebuild_required` (see §4). The in-memory stub survives
> only as a zero-cost test double for the wire-contract tests.

## 1. Connection

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Protocol        | HTTP/1.1, JSON request + response bodies                  |
| Default endpoint| `http://127.0.0.1:8772` (loopback ONLY — never bind LAN)  |
| Authentication  | Bearer token, two planes (see §2)                         |

Port 8772 sits after the sibling native addons' WS/health pairs — whisper-stt
8768/8769, local-tts 8770/8771. deep-memory is plain HTTP (aiohttp), so one
port serves every endpoint below, `/health` included.

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
| 409    | `rebuild_required`      | search on a scope whose stored embedding model != configured; gateway must `rebuild` |

## 5. Managed-service posture

Declared as `managed_services.deep-memory` in `gateway/config.yaml`
(`launch: native`, mirroring whisper-stt/local-tts). The gateway is the sole
supervisor — no standalone launchd unit, no `deep-memory.sh` launcher.

| Property     | Value                                                            |
| ------------ | ----------------------------------------------------------------- |
| Launch       | `native` — `${SENTIENT_CODE}/deep-memory/venv/bin/python -m deep_memory` |
| Interpreter  | Python 3.14 (pinned; verified end-to-end in T9b)                 |
| Health probe | `GET /health` — the gateway polls this at boot and on the post-boot watchdog, same as every other HTTP-checked addon |
| Optional     | `true` — the memory system degrades **non-fatally** when this addon is absent or unhealthy: `memory_recall`/memory tools go unavailable, boot and voice traffic proceed unaffected (spec §11 degradation model). Contrast whisper-stt/local-tts, which are `optional: false` (voice-path critical) |

Environment variables the gateway injects into the spawned process:

| Var                       | Purpose                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| `PYTHONPATH`               | `${SENTIENT_CODE}/deep-memory/src` — REQUIRED. The service's own package is never pip-installed into the venv (only its dependencies are, from vendored wheels), so `-m deep_memory` resolves the package via this, not site-packages. Missing it is a `ModuleNotFoundError` at every launch. Mirrors whisper-stt/local-tts's own `PYTHONPATH` entries; cross-process contract pinned by `deploy/mac-prod/setup-prod.py`'s `SERVICE_SOURCES` comment and guarded by `test_setup_prod.py::test_release_layout_matches_the_native_exec_contract` |
| `DEEP_MEMORY_CONFIG_PATH`  | Path to this service's own `config.yaml` (defaults to `~/.sentient/deep-memory/config/config.yaml` if unset) |
| `DEEP_MEMORY_LOG_DIR`      | Log output directory (defaults to `~/.sentient/deep-memory/logs` if unset) |
| `DEEP_MEMORY_ADMIN_TOKEN`  | Admin-plane bearer token (§2). Startup fails loud if empty — the service never comes up accepting an empty bearer |
| `DEEP_MEMORY_DATA_TOKEN`   | Data-plane bearer token (§2). Same fail-loud rule                |

None of the four app-level vars (everything but `PYTHONPATH`) are read from
`config.yaml` on disk — see §2 above.

`storage.data_root`, `embedding.model` and every other tunable live in the
service's own `config.yaml` on disk (§ config/config.example.yaml), never as
env vars — only the two secrets and the two paths above cross the
gateway→service boundary as environment.
