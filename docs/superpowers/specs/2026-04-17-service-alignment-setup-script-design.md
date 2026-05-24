# Service Alignment & Setup Script

**Date:** 2026-04-17
**Status:** Design approved, pending implementation plan

## Why

The repo's services (`gateway`, `stt-service`, `sentient-auth`, `webui`) drifted on versions, config formats, mount paths, and bootstrap scripts. Local-docker and Pi deployments each carry their own `setup.sh` with slightly different semantics. Adding/migrating a config field today means editing the host file by hand — every deploy is a chance to desync.

Goal: one normalized layout, one bootstrap script that is safe to re-run on every upgrade, never clobbers user values, and walks the operator through missing `.env` keys and new YAML fields with a readable TUI.

## Non-goals

- No changes to in-container application logic except for path constants.
- No rewrite of `sentient-auth` — the setup script only *invokes* its existing `init` command.
- No backwards-compat shim for the old host layout. This is a one-shot migration; users redeploy after applying.

## Scope

Three workstreams, all in one change:

1. **Version alignment.**
2. **Config + mount layout normalization.**
3. **`deploy/setup.py` — the unified bootstrap/migration script.**

---

## 1. Version alignment

| Unit | File | Current | Target |
|---|---|---|---|
| Root workspace meta | `package.json` | 1.6.0 | 0.1.0 |
| Gateway | `gateway/package.json` | 0.1.0 | 0.1.0 (unchanged) |
| Webui | `gateway/webui/package.json` | (absent) | 0.1.0 |
| sentient-auth | `sentient-auth/package.json` | 0.0.1 | 0.1.0 |
| STT service (app) | `capabilityServices/STTService/pyproject.toml` | 1.0.0 | **1.0.0 (unchanged — feature-complete)** |

App version and config-schema version are intentionally separate. STT's app version stays at 1.0.0 while its config file still carries the unified `schema_version: "0.1.0"` header.

### YAML schema header

Every runtime-loaded config YAML gains a top line:

```yaml
schema_version: "0.1.0"
```

Files that get the header:
- `gateway/config.yaml`
- `gateway/salience_map.yaml`
- `capabilityServices/STTService/config/config.example.yaml`

Files that do NOT get it (already versioned via their own scheme or not runtime config):
- `sentient-auth/manifests/*.yaml` (use their existing `version: 1` field)
- auth-manifest.yaml files
- `.env`, `.env.example`
- `docker-compose.yml`

The setup script reads `schema_version` to decide migration behavior. Forward-compat: a mismatch (script knows `0.2.0`, file is `0.1.0`) triggers the migration path; reverse-mismatch (file newer than script) prints a warning and exits.

---

## 2. Layout normalization

### Host layout (canonical)

```
~/.sentient/
├── gateway/
│   ├── config/
│   │   ├── config.yaml
│   │   └── salience_map.yaml
│   └── logs/
├── stt-service/
│   ├── config/
│   │   └── config.yaml
│   ├── logs/
│   └── data/
│       └── recordings/
├── auth/
│   ├── manifests/          # copied from repo for local reference
│   └── tokens/             # chmod 700; managed by sentient-auth
└── certs/                  # shared TLS, gateway-owned
```

### Container-side changes

Gateway Dockerfile / source path constants:
- `/app/config.yaml` → `/app/config/config.yaml`
- `/app/salience_map.yaml` → `/app/config/salience_map.yaml`
- `cerebrum.salience_map_path` default → `/app/config/salience_map.yaml`

STT: `/app/recordings/` → `/app/data/recordings/`.

Both `deploy/docker/docker-compose.yml` and `deploy/pi/docker-compose.yml` update their `volumes:` blocks to match. The `target:` paths change in lockstep with the source code constants.

### Breaking-migration acknowledgement

This is a one-shot break for existing deployments. Mitigation: `deploy/setup.py` moves existing host files into the new tree (see §3 migration logic). Operators redeploy containers after running the script.

---

## 3. Unified log policy

All runtime configs declare logging under the same shape:

```yaml
logging:
  level: info              # debug | info | warning | error
  retention_days: 7        # 0 disables pruning
  rotation: daily          # UTC midnight rollover
```

Gateway already matches. STT config reorganized to present the same keys in the same order — behaviorally no change; the `retention_days` and `level` fields already exist and do the right thing. STT's `metrics_interval_ms` stays under `logging:` as a service-specific extension.

---

## 4. `deploy/setup.py`

Single script, lives at `deploy/setup.py`. Replaces `deploy/docker/setup.sh` and `deploy/pi/setup.sh` (both deleted, replaced with nothing — users run `python3 deploy/setup.py` from repo root).

### CLI surface

```
python3 deploy/setup.py [--mode local-dev-docker|prod] [--yes] [--custom]
```

- `--mode` — omitted → auto-detect if run from `deploy/docker/` or `deploy/pi/`; else prompt with `prod` preselected.
- `--yes` — non-interactive; accept all defaults, no prompts. For CI / scripted Pi redeploys.
- `--custom` — prompt per missing field instead of bulk-accept.

Mutually exclusive: `--yes` + `--custom` → error at arg-parse time.

### Operational phases

1. **Preflight.** Check `docker` and `docker compose` are on PATH. Sanity-check the cwd looks like the sentient repo (presence of `gateway/`, `capabilityServices/`, `deploy/`).
2. **Directory tree.** `mkdir -p` the full layout above. `chmod 700` the auth dirs. Idempotent; re-runs are safe.
3. **Host-layout migration** (runs before phases 4–6 if old-layout files detected):
   - `~/.sentient/gateway/config.yaml` → `~/.sentient/gateway/config/config.yaml`
   - `~/.sentient/gateway/salience_map.yaml` → `~/.sentient/gateway/config/salience_map.yaml`
   - `~/.sentient/stt-service/recordings/` → `~/.sentient/stt-service/data/recordings/`
   - Each move is reported in the TUI. If the destination already exists (partial previous run), the script errors loudly — user fixes manually.
4. **`.env` bootstrap.** For `deploy/<mode>/.env`:
   - If missing, copy from `.env.example` and flag as required-edit.
   - If present, diff keys. List new or empty required keys. Offer: `[f]` open $EDITOR / `[c]` prompt each / `[s]` skip.
5. **YAML bootstrap + migrate.** For each of `gateway/config.yaml`, `gateway/salience_map.yaml`, `stt-service/config.yaml`:
   - If absent on host → copy canonical from repo.
   - If present → smart-merge (see §4.1). Back up to `<name>.bak.<ISO-8601-timestamp>` before writing.
6. **Auth init prompt.** Scan `~/.sentient/auth/tokens/`:
   - No tokens → offer to run `sentient-auth/run.sh init`.
   - Tokens present → show their mtimes, offer `[r] rotate | [s] skip`.
   - Never auto-rotates without explicit approval.
7. **Summary.** Counts: created / updated / unchanged / backups. Next-step commands tailored to `--mode`.

### 4.1 Smart-merge semantics

Canonical files (in repo) are the schema. Host files are runtime state. Rules:

- Parse both with `ruamel.yaml` round-trip loader (preserves comments, key order, quoting).
- Recursive walk of canonical:
  - Key missing in host → add with canonical value + canonical comment.
  - Key present → keep host value and host comment. Never overwrite.
  - Nested mapping → recurse.
  - List → host wins whole-list. No element-level merge.
- Keys in host but not in canonical → kept untouched (forward-compat for user-added knobs).
- `schema_version` is the one exception: always written as the repo's value, even if the host has a different one. That IS the migration.
- Write atomically: write to `config.yaml.new`, rename over `config.yaml`. Backup preceded this.

### 4.2 Flow modes

- **Default (interactive fast flow)** — once per file, show a table of new/missing fields with their canonical defaults; one `[Y/c/n]` prompt. `Y` = bulk accept, `c` = switch to per-field custom prompts for this file only, `n` = skip this file.
- **`--yes`** — no prompts. Every `[Y/c/n]` decision auto-resolves to `Y`. Missing `.env` values stay empty — script exits non-zero at summary time if any required env var is blank.
- **`--custom`** — every missing field prompted individually with the canonical default prefilled. Empty input = accept default; typed = override.

### 4.3 TUI

Uses `rich` for panels, tables, and live status. Installable via `pip install rich ruamel.yaml` — script checks both at startup and prints the install command if missing.

Mockup (approved):

```
╭────────────────────── Sentient Setup ──────────────────────╮
│  Target mode:  (•) prod    ( ) local-dev-docker            │
│  Repo root:    /Users/kevin/Development/sentient           │
│  Host root:    ~/.sentient                                 │
╰────────────────────────────────────────────────────────────╯

 Preflight
  ✓ docker 27.2.0
  ✓ docker compose v2.29.1
  ✓ repo root looks valid

 Directory tree
  ✓ ~/.sentient/gateway/{config,logs}
  ✓ ~/.sentient/stt-service/{config,logs,data/recordings}
  ✓ ~/.sentient/auth/{manifests,tokens}    (tokens 700)
  ✓ ~/.sentient/certs

 Host-layout migration
  → moved  ~/.sentient/gateway/config.yaml → gateway/config/config.yaml
  → moved  ~/.sentient/stt-service/recordings → stt-service/data/recordings

 .env — deploy/pi/.env
  ╭──────────────────────────────────────────────────────╮
  │ Required variables missing or empty:                 │
  │   OPENROUTER_API_KEY      (empty)                    │
  │   FISH_AUDIO_API_KEY      (empty)                    │
  │ [f] Open in $EDITOR   [c] Prompt each   [s] Skip     │
  ╰──────────────────────────────────────────────────────╯

 gateway/config.yaml                           schema 0.1.0 → 0.1.0
  ╭──────────────────────────────────────────────────────╮
  │ 2 new fields will be added with defaults:            │
  │   tts.model_id                          "s2"         │
  │   cerebrum.cycle.max_iterations         10           │
  │ Existing values preserved. Backup → config.yaml.bak  │
  │ [Y] Apply defaults   [c] Customize each   [n] Skip   │
  ╰──────────────────────────────────────────────────────╯

 stt-service/config.yaml                       schema 0.1.0 → 0.1.0
  ✓ up to date — no changes

 Auth tokens
  ╭──────────────────────────────────────────────────────╮
  │ Found: (none) in ~/.sentient/auth/tokens/            │
  │ gateway ↔ stt-service needs a shared bearer token.   │
  │ Run `sentient-auth init` now?                        │
  │ [Y] Yes, run it       [n] Skip, I'll run it myself   │
  ╰──────────────────────────────────────────────────────╯
  → executing: sentient-auth/run.sh init
  ✓ wrote ~/.sentient/auth/tokens/gateway.yaml
  ✓ wrote ~/.sentient/auth/tokens/stt-service.yaml

╭──────────────────────── Summary ───────────────────────────╮
│ Created:   1  (deploy/pi/.env)                             │
│ Updated:   1  (gateway/config.yaml: +2 fields)             │
│ Unchanged: 1  (stt-service/config.yaml)                    │
│ Backups:   1  (~/.sentient/gateway/config/config.yaml.bak) │
│                                                            │
│ Next steps:                                                │
│   docker compose -f deploy/pi/docker-compose.yml pull      │
│   docker compose -f deploy/pi/docker-compose.yml up -d     │
╰────────────────────────────────────────────────────────────╯
```

### 4.4 File module layout

`deploy/setup.py` stays under 300 lines by splitting into a small package:

```
deploy/
├── setup.py                    # thin entrypoint — arg parse + orchestration
└── setup_lib/
    ├── __init__.py
    ├── preflight.py            # docker checks, repo-root sniff
    ├── layout.py               # directory tree + host-layout migration
    ├── env_merge.py            # .env key diff + prompt flows
    ├── yaml_merge.py           # ruamel-based smart-merge + backup
    ├── auth_prompt.py          # token scan + sentient-auth invocation
    ├── tui.py                  # rich panels, prompts, summary widgets
    └── schema_versions.py      # hardcoded {"gateway/config.yaml": "0.1.0", …}
```

Each module is independently testable. `tui.py` is the only module that imports `rich`; the rest take a small `Reporter` protocol so unit tests can stub it.

### 4.5 Testing

- **`yaml_merge`**: golden-file tests. Fixture pairs of (canonical, user, expected-merged). Covers: missing key, preserved user value, preserved comment, unknown user key kept, nested dict, list whole-replace.
- **`env_merge`**: same shape. Fixtures of (example, user, expected-missing-keys-list).
- **`layout`**: tmp-dir `HOME` fixture. Creates old layout, asserts post-run tree, asserts duplicate-dest error path.
- **`preflight`**: mock `subprocess.run`; test docker-missing, compose-missing, wrong-cwd paths.
- **`auth_prompt`**: scan logic over tmp dirs.
- **Integration**: one end-to-end test that runs the whole script against a synthetic repo + empty `$HOME` and asserts the final tree.

No real `rich` rendering in unit tests; `Reporter` is stubbed.

### 4.6 Error handling

- Every failable step returns a `Result[OK, Error]`-shape tuple or raises a typed `SetupError` caught at the script entry.
- TUI surfaces each error inline (red panel) and the script exits non-zero with a one-line summary.
- Non-destructive by construction: any write is preceded by a backup; any move fails loudly if the destination is already populated.
- `--yes` with required `.env` values still empty → exit 2 with "Missing required: OPENROUTER_API_KEY, FISH_AUDIO_API_KEY".

---

## 5. Files changed

**New:**
- `deploy/setup.py`
- `deploy/setup_lib/*.py`
- `deploy/setup_lib/tests/` fixtures + tests

**Modified:**
- `package.json` — version `0.1.0`
- `gateway/webui/package.json` — add `"version": "0.1.0"`
- `sentient-auth/package.json` — version `0.1.0`
- `gateway/config.yaml` — `schema_version: "0.1.0"` header; logging block aligned
- `gateway/salience_map.yaml` — `schema_version: "0.1.0"` header
- `capabilityServices/STTService/config/config.example.yaml` — `schema_version: "0.1.0"` header; logging block aligned to gateway's shape
- `gateway/src/**` — path constants updated (`/app/config.yaml` → `/app/config/config.yaml`, salience_map path)
- `gateway/Dockerfile` — COPY targets updated
- `deploy/docker/docker-compose.yml` — volume targets updated
- `deploy/pi/docker-compose.yml` — volume targets updated
- `gateway/.claude/rules/logging.md` — log path reference updated (`gateway/logs/` → `/app/logs`, still correct)

**Deleted:**
- `deploy/docker/setup.sh`
- `deploy/pi/setup.sh`

Host-path constant lookups: grep `~/.sentient/`, `/app/config.yaml`, `/app/salience_map.yaml`, `/app/recordings` across the repo and update each hit.

## 6. Definition of done

- `python3 deploy/setup.py --mode prod` on a clean `$HOME` produces the full canonical layout and prompts for `.env` values.
- Re-running after hand-editing `config.yaml` preserves every hand-edit (verified by golden-file test + manual spot-check).
- Re-running after a schema bump (simulated by editing repo's `config.yaml`) merges the new field in and preserves user values.
- `--yes` succeeds on a clean `$HOME` when `.env` is pre-populated; exits 2 when required env vars are blank.
- `docker compose up -d` on both `deploy/docker/` and `deploy/pi/` starts healthy with the new layout.
- All unit tests pass. `bun run ci` green.
