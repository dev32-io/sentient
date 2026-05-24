# Logging Rotation & Retention Design

**Date:** 2026-04-14
**Status:** Approved (brainstorming) — pending implementation plan

## Problem

Sentient runs on a Raspberry Pi 5 with constrained storage. Today, none of the long-lived services have effective log retention:

- **Gateway** (Bun/TS) writes daily-rotated files (`YYYY-MM-DD.log`) via `@logtape/logtape` but never deletes old ones — files accumulate indefinitely.
- **STT service** (Python) writes three JSONL streams (`service.jsonl`, `metrics.jsonl`, `conn_<id>.jsonl`) with no rotation at all — they grow forever.
- **Docker containers** use the default `json-file` driver with no size or file-count limits — `docker logs` history is also unbounded.
- **`config.yaml`** has no `logging` section in either service that exposes retention controls.

Rough estimate: gateway + STT metrics together emit ~8 KB/sec sustained; spiky per-connection traces add more. A 16 GB Pi fills in roughly three weeks of continuous use without intervention.

## Requirements

1. Daily file rotation for all persistent app log files.
2. Configurable retention policy in each service's `config.yaml` under a `logging.retention_days` key.
3. Default retention: **7 days**.
4. Container stdout (`docker logs`) capped via Docker's logging driver.
5. Works identically on a developer laptop and on the Pi — no host-side cron required.

## Out of Scope

- Migrating gateway's `LOG_LEVEL` / `LOG_DIR` env vars into `config.yaml`.
- Size-based rotation (daily-only for now).
- Per-file-type retention overrides — one knob per service, not three.
- Compressing rotated log files.
- Shipping logs to a remote sink.
- Backfilling rotation for pre-change un-dated files (`service.jsonl`, `metrics.jsonl`) — they will be pruned by mtime once aged past the retention window.

## Architecture

Three coordinated, independent changes — no new shared library across the TS/Python boundary. Each service owns its own logging concerns; Docker compose adds an orthogonal cap on container stdout.

```
┌─────────────────────────────────────────────────────────────────┐
│  Gateway (Bun/TS)                                                │
│  - logtape daily file sink (existing)                           │
│  + pruneOldLogs(dir, retention_days)                            │
│      called at startup AND on each rollover                     │
│  + logging.retention_days in gateway/config.yaml (default 7)    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  STT service (Python)                                            │
│  - JsonlLogger (existing) → kept for conn_<id>.jsonl            │
│  + RotatingJsonlLogger(basename, dir) → service & metrics       │
│      filename: YYYY-MM-DD-<basename>.jsonl                      │
│      rolls over lazily on each write when date string changes   │
│  + prune_old_logs(dir, retention_days)                          │
│      called at startup + via daily asyncio task                 │
│  + logging.retention_days in STT config.yaml (default 7)        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Docker compose (deploy/docker + deploy/pi)                      │
│  + logging: { driver: json-file,                                │
│      options: { max-size: "10m", max-file: "7" } }              │
│      added to every long-lived service                          │
└─────────────────────────────────────────────────────────────────┘
```

App-side daily rotation manages **app-written files**. Docker driver caps manage **container stdout**. The two limits are independent and complementary.

## Configuration Schema

Both services use the same shape under their existing `logging:` section.

### `gateway/config.yaml` (new section)

```yaml
logging:
  # Log retention. Files older than this are deleted at startup
  # and at each midnight rollover. Set to 0 to disable pruning.
  # Valid range: 0-365 days.
  retention_days: 7
```

The existing `LOG_LEVEL` and `LOG_DIR` env vars continue to work as overrides; out of scope to migrate.

### `capabilityServices/STTService/config/config.example.yaml` (extends existing section)

```yaml
logging:
  level: info                # existing
  metrics_interval_ms: 1000  # existing
  # Log retention. Files older than this are deleted at startup
  # and at each midnight rollover. Set to 0 to disable pruning.
  # Valid range: 0-365 days.
  retention_days: 7
```

### Validation

- Missing key → defaults to 7. Sensible default keeps the Pi safe even if a user hand-edits config.
- Negative or non-integer or > 365 → fail loud at startup with `"logging.retention_days must be an integer between 0 and 365, got: <value>"`.
- `0` → pruning disabled. Escape hatch for debugging long-running issues.

## Component Design

### Gateway: `gateway/src/logging/logger.ts`

Existing file is ~60 lines. Current responsibilities: configure logtape sinks (console + daily file).

**Add:** `pruneOldLogs(dir: string, retentionDays: number): Promise<void>` (~25 lines).

```ts
async function pruneOldLogs(dir: string, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  // List dir, filter to *.log files, stat each, unlink if mtime < cutoff.
  // Per-file try/catch — one bad file must not abort the whole prune.
}
```

**Wired in two places:**

1. **Startup** — called once from `gateway/src/main.ts` after logger init, awaited (completes in tens of ms).
2. **Daily rollover** — `createDailyFileSink()` already opens a new file at midnight UTC. Add a hook there to fire `pruneOldLogs()` non-blocking; errors are logged but never propagated.

**Config wiring** — the existing config loader gains a `logging.retention_days` field. Defaults to 7 if absent. Throws on invalid. Passed into `initLogger()`.

### STT: `capabilityServices/STTService/src/stt_service/event_logger.py`

Currently 132 lines. Two log file shapes coexist after the change:

**Case A — `service.jsonl` and `metrics.jsonl` (daily rotation)**

New class `RotatingJsonlLogger(basename: str, dir: Path, *, clock=lambda: datetime.now(timezone.utc))`:

- Computes the active path lazily on each `log()` call: `dir / f"{today_utc}-{basename}.jsonl"`.
- Caches the open file handle keyed by date string. If the date string has changed since the last write, close the old handle and open the new one (under the existing `_lock`).
- Same `buffering=1` for live `tail -f`.
- Same `close()` semantics.
- `clock` is a callable seam injected for testing — no time monkey-patching in tests.

Why lazy/per-write rollover instead of a midnight timer? STT writes 10s–100s of events/sec; the date string check is one comparison. Cost is negligible. A timer adds a thread we don't need.

**Case B — `conn_<id>.jsonl` (no rotation, just mtime prune)**

Keep the existing `JsonlLogger` for these. Each connection opens its own file, closes it when the WebSocket closes. The connection id IS the rotation key.

**Prune function** (~20 lines, sibling to the loggers):

```python
def prune_old_logs(dir: Path, retention_days: int) -> None:
    if retention_days <= 0:
        return
    cutoff = time.time() - retention_days * 86400
    for f in dir.glob("*.jsonl"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass  # don't let one bad file abort the prune
```

**Wired in:**

- **Startup** — called once from the service entry point.
- **Daily** — a tiny `asyncio` task that sleeps until the next UTC midnight, runs the prune in a thread executor, then reschedules itself.

**File-size note:** `event_logger.py` is currently 132 lines. Adding `RotatingJsonlLogger` (~40 lines) + `prune_old_logs` (~20 lines) brings it to ~200 lines — under the 250-line split threshold. If subsequent work pushes it over, split rotation into its own module per `architecture.md`.

### Docker compose: `deploy/docker/compose.yml` and `deploy/pi/compose.yml`

Add identical `logging:` block to every long-lived service (gateway, stt-service, sentient-auth, future capability services):

```yaml
services:
  gateway:
    # ...existing keys...
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

Numbers chosen so worst-case container stdout is ~70 MB per service, roughly aligning with the app-side 7-day retention.

These values stay hardcoded in compose files (NOT in `config.yaml`) per the config rule: "Internal implementation details… are NOT config — keep those as code constants." Container limits apply before the app starts and must hold regardless of app config state.

## Error Handling

| Failure | Handling |
|---|---|
| Bad `retention_days` (negative, non-int, > 365) | Fail loud at startup with actionable message; app does not start. |
| Prune I/O error (perm denied, file vanished mid-stat) | Caught per-file, logged at `warn`, never aborts the prune or propagates. |
| Logger I/O error (disk full mid-write) | Existing behavior — Python `_fp.write` raises and propagates. Out of scope to change. |
| Rollover collision (concurrent writes at midnight UTC) | Existing `_lock` (Python) and TS event-loop semantics handle this. No new locking. |

## Testing

### Gateway

`gateway/tests/unit/logging/logger.test.ts` (new or extend):

- `pruneOldLogs` unit tests with a tmpdir of synthesized files at varied mtimes:
  - Empty directory → no-op.
  - All files within retention → no deletions.
  - All files older than retention → all deleted.
  - Mixed → only stale files deleted.
  - `retention_days = 0` → no-op even with stale files.
  - Per-file unlink failure → other files still pruned.
- Config loader: bad `retention_days` values throw with actionable error.

### STT

`capabilityServices/STTService/tests/unit/test_event_logger.py` (extend):

- `RotatingJsonlLogger`:
  - Writes go to date-stamped file (`YYYY-MM-DD-<basename>.jsonl`).
  - Advancing the injected `clock` past midnight rolls over to a new file on next write.
  - Closing the logger flushes the active handle.
- `prune_old_logs` — same five scenarios as gateway.
- Config validation: bad `retention_days` raises with actionable message.

### No integration tests

Pure file-system logic. Unit coverage is sufficient. Verification on the Pi happens at deploy time (see below).

## Deploy / Verification

Per the project's "verify against real containers before done" rule:

1. Build via `deploy/docker`, run `compose up -d`.
2. `docker inspect <container>` confirms `LogConfig.Type=json-file` and the `max-size`/`max-file` options are applied.
3. Exercise gateway with a few sessions; confirm app-side files appear under `~/.sentient/{gateway,stt-service}/logs/` with date-prefixed names.
4. After a 2-day soak on the Pi: `du -sh ~/.sentient/{gateway,stt-service}/logs/` to confirm size stays within the retention budget.

## Risks

- If `LOG_DIR` is ever pointed outside `~/.sentient/`, the prune will still delete `*.log`/`*.jsonl` files there. Acceptable — it is a logs dir by configuration; the user owns that consequence.
- Docker `max-file: 7` does NOT compose with app-side daily rotation — they are independent limits on independent streams (container stdout vs. app-written files). Documented here so future-us doesn't get confused.

## Acceptance Criteria

- `gateway/config.yaml` exposes `logging.retention_days` with a documented default of 7.
- STT `config.example.yaml` exposes `logging.retention_days` with a documented default of 7.
- Gateway log files older than the configured retention are deleted at startup and at each daily rollover.
- STT `service.jsonl` and `metrics.jsonl` are written with date-prefixed filenames; STT `conn_*.jsonl` retains its per-connection naming. All three are pruned by mtime against the configured retention.
- Docker compose files cap container stdout via `json-file` driver options.
- Unit tests cover all five prune scenarios in both languages.
- Bad config values fail loud at startup with actionable error messages.
- A 2-day soak on the Pi shows logs directory size stays within the retention budget.
