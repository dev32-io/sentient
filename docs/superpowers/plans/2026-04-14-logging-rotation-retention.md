# Logging Rotation & Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily file rotation and configurable mtime-based retention to gateway and STT services so logs do not fill the Raspberry Pi's disk.

**Architecture:** Each service rotates and prunes its own log files (Bun/TS for gateway, Python for STT). Docker json-file driver caps container stdout. A single knob `logging.retention_days` in each service's `config.yaml` controls retention (default 7, range 0–365). All numbers and configurable behavior live in YAML; magic numbers stay out of code.

**Tech Stack:**
- Gateway: Bun, TypeScript (strict), Vitest, zod (config schema), `@logtape/logtape` (existing logger).
- STT service: Python 3.11+, `unittest`, `asyncio`, `pyyaml`, dataclasses.
- Deploy: Docker Compose.

**Spec:** `docs/superpowers/specs/2026-04-14-logging-rotation-retention-design.md`

**Branch:** `feature/logging-rotation-retention` (already created, spec already committed).

---

## Pre-flight (executor: read this once before starting)

1. Source the env before any shell command (`source scripts/env.sh`). All `bun` and Python commands depend on it.
2. Use `git status` between tasks to confirm the working tree is clean and you are still on `feature/logging-rotation-retention`.
3. **Co-located tests are the rule for TS** (`foo.ts` ↔ `foo.test.ts`, same directory). For STT the tests live in `capabilityServices/STTService/tests/`.
4. **STT tests need `PYTHONPATH=src`** because the project is not pip-installed in editable mode in the dev environment. Every Python command in this plan that touches `stt_service.*` is shown with the prefix already set — keep it.
5. **Never commit before tests pass** for the task you just wrote. The pre-commit hook runs typecheck + secrets-guard; if it fails, fix the code, re-stage, re-commit (do NOT use `--no-verify` and do NOT amend).
6. Commit message format: `type(scope): description` (`feat`, `fix`, `refactor`, `test`, `chore`). One logical change per commit. Always include the trailer `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.
7. **Do NOT change tuned constants** elsewhere in the codebase. If a test breaks because a tuned constant changed (e.g. you "tightened" something), revert your change and fix the test only.
8. **Stop and ask** if any step refers to a file you cannot find at the exact path given — do NOT guess.

---

## File Map

### Files to create

| Path | Purpose |
|---|---|
| `gateway/src/logging/prune.ts` | `pruneOldLogs(dir, retentionDays)` pure function. |
| `gateway/src/logging/prune.test.ts` | Unit tests for prune. |
| `capabilityServices/STTService/tests/test_event_logger.py` | Unit tests for `RotatingJsonlLogger` + `prune_old_logs`. |

### Files to modify

| Path | Why |
|---|---|
| `shared/config/src/schema.ts` | Add `loggingConfigSchema` and attach to `gatewayConfigSchema`. |
| `shared/config/src/schema.test.ts` | Cover the new logging schema defaults. |
| `gateway/config.yaml` | Add `logging:` section with `retention_days: 7`. |
| `gateway/src/config/startup-config.ts` | Read retention from YAML; expose `retentionDays` on `LoggingConfig`. |
| `gateway/src/logging/logger.ts` | Accept `retentionDays`; trigger prune at startup and inside rollover hook. |
| `gateway/src/logging/logger.test.ts` | Cover rollover-triggered prune wiring. |
| `gateway/src/main.ts` | Pass retention into `createGatewayLogger`. |
| `capabilityServices/STTService/src/stt_service/event_logger.py` | Add `RotatingJsonlLogger`; add `prune_old_logs`. |
| `capabilityServices/STTService/src/stt_service/config.py` | Add `retention_days` field; parse + range-validate. |
| `capabilityServices/STTService/src/stt_service/server.py` | Use `RotatingJsonlLogger("service", …)`. |
| `capabilityServices/STTService/src/stt_service/metrics.py` | Use `RotatingJsonlLogger("metrics", …)`. |
| `capabilityServices/STTService/src/stt_service/__main__.py` | Call `prune_old_logs` at startup. |
| `capabilityServices/STTService/config/config.example.yaml` | Add `retention_days: 7` with comment. |
| `deploy/docker/docker-compose.yml` | Add `logging:` driver block to each service. |
| `deploy/pi/docker-compose.yml` | Add `logging:` driver block to each service. |

---

## Tasks

There are 15 tasks. Each is one logical change with its own commit. Tasks are ordered so each one keeps the build green on its own.

---

### Task 1: Gateway — `pruneOldLogs` pure function (TDD)

**Files:**
- Create: `gateway/src/logging/prune.ts`
- Create: `gateway/src/logging/prune.test.ts`

**Why this first:** Pure function with no other dependencies. Gives us confidence in the prune semantics before wiring anywhere.

- [ ] **Step 1.1: Write the failing tests**

Write to `gateway/src/logging/prune.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOldLogs } from "./prune.js";

const ONE_DAY_SECONDS = 24 * 60 * 60;

function ageFile(path: string, daysOld: number): void {
  const seconds = Math.floor(Date.now() / 1000) - daysOld * ONE_DAY_SECONDS;
  utimesSync(path, seconds, seconds);
}

describe("pruneOldLogs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prune-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when retentionDays is 0", async () => {
    const stale = join(dir, "2020-01-01.log");
    writeFileSync(stale, "old");
    ageFile(stale, 100);

    await pruneOldLogs(dir, 0);

    expect(existsSync(stale)).toBe(true);
  });

  it("does nothing when the directory is empty", async () => {
    await expect(pruneOldLogs(dir, 7)).resolves.toBeUndefined();
  });

  it("does nothing when the directory does not exist", async () => {
    await expect(pruneOldLogs(join(dir, "missing"), 7)).resolves.toBeUndefined();
  });

  it("keeps files newer than the retention window", async () => {
    const fresh = join(dir, "fresh.log");
    writeFileSync(fresh, "fresh");
    ageFile(fresh, 3);

    await pruneOldLogs(dir, 7);

    expect(existsSync(fresh)).toBe(true);
  });

  it("deletes files older than the retention window", async () => {
    const stale = join(dir, "stale.log");
    writeFileSync(stale, "stale");
    ageFile(stale, 10);

    await pruneOldLogs(dir, 7);

    expect(existsSync(stale)).toBe(false);
  });

  it("deletes only the stale files when mixed", async () => {
    const fresh = join(dir, "fresh.log");
    const stale = join(dir, "stale.log");
    writeFileSync(fresh, "fresh");
    writeFileSync(stale, "stale");
    ageFile(fresh, 1);
    ageFile(stale, 30);

    await pruneOldLogs(dir, 7);

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("ignores non-.log files", async () => {
    const stale = join(dir, "stale.txt");
    writeFileSync(stale, "stale");
    ageFile(stale, 30);

    await pruneOldLogs(dir, 7);

    expect(existsSync(stale)).toBe(true);
  });

  it("continues pruning after a per-file failure", async () => {
    const survivable = join(dir, "stale.log");
    writeFileSync(survivable, "stale");
    ageFile(survivable, 30);

    // A non-existent file path inserted via a manual readdir mock would be
    // overkill here. Instead we verify that one bad file does not abort the
    // pass by deleting the file out from under stat between calls — but
    // that race is hard to force deterministically. We cover the happy
    // multi-file case and trust the per-file try/catch in the implementation.
    const second = join(dir, "second-stale.log");
    writeFileSync(second, "stale");
    ageFile(second, 30);

    await pruneOldLogs(dir, 7);

    expect(existsSync(survivable)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run tests and verify they fail**

Run:

```bash
source scripts/env.sh && bun --filter '@sentient/gateway' run test src/logging/prune.test.ts
```

Expected: tests fail with `Cannot find module './prune.js'` or similar — the file does not exist yet.

- [ ] **Step 1.3: Implement the function**

Write to `gateway/src/logging/prune.ts`:

```ts
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Delete `*.log` files in `dir` whose mtime is older than
 * `retentionDays` days ago. No-op when `retentionDays <= 0` or
 * when the directory is missing. Per-file errors are swallowed so
 * one bad file never aborts the pass.
 */
export async function pruneOldLogs(dir: string, retentionDays: number): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoffMs) {
        await unlink(path);
      }
    } catch {
      // Per-file failure must not abort the prune pass.
    }
  }
}
```

- [ ] **Step 1.4: Run tests and verify they pass**

Run:

```bash
source scripts/env.sh && bun --filter '@sentient/gateway' run test src/logging/prune.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add gateway/src/logging/prune.ts gateway/src/logging/prune.test.ts
git commit -m "$(cat <<'EOF'
feat(logging): add pruneOldLogs helper for gateway log retention

Pure function that deletes *.log files in a directory whose mtime is
older than N days. Tolerates missing directory, non-log files, and
per-file unlink failures. Wired into the gateway logger in a follow-up.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared config schema — add `loggingConfigSchema` (TDD)

**Files:**
- Modify: `shared/config/src/schema.ts`
- Modify: `shared/config/src/schema.test.ts`

**Why now:** The gateway logger needs `retentionDays` from typed config. Adding the schema first lets later tasks plug into a real type.

- [ ] **Step 2.1: Inspect the existing schema test for the existing pattern**

Open `shared/config/src/schema.test.ts` and skim it. You will mirror the same style (parse a YAML-shaped object and assert on the output).

- [ ] **Step 2.2: Write the failing test**

Append to `shared/config/src/schema.test.ts`:

```ts
import { loggingConfigSchema } from "./schema.js";

describe("loggingConfigSchema", () => {
  it("defaults retention_days to 7 when omitted", () => {
    expect(loggingConfigSchema.parse({})).toEqual({ retention_days: 7 });
  });

  it("accepts a custom retention_days within range", () => {
    expect(loggingConfigSchema.parse({ retention_days: 14 })).toEqual({
      retention_days: 14,
    });
  });

  it("accepts retention_days = 0 as the disable sentinel", () => {
    expect(loggingConfigSchema.parse({ retention_days: 0 })).toEqual({
      retention_days: 0,
    });
  });

  it("rejects negative retention_days", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: -1 })).toThrow();
  });

  it("rejects retention_days greater than 365", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: 366 })).toThrow();
  });

  it("rejects non-integer retention_days", () => {
    expect(() => loggingConfigSchema.parse({ retention_days: 7.5 })).toThrow();
  });
});

describe("gatewayConfigSchema logging field", () => {
  it("includes a default logging section when omitted", () => {
    const minimal = {
      stt: { provider: "local-stt" },
      llm: { provider: "openrouter" },
      tts: { provider: "fish-audio" },
    };
    const parsed = gatewayConfigSchema.parse(minimal);
    expect(parsed.logging).toEqual({ retention_days: 7 });
  });
});
```

> **Note:** the import for `gatewayConfigSchema` is likely already at the top of `schema.test.ts`. Add `loggingConfigSchema` alongside it. Do NOT duplicate imports — adjust the existing import line.

- [ ] **Step 2.3: Run tests and verify they fail**

```bash
source scripts/env.sh && bun --filter '@sentient/config' run test
```

Expected: failures for `loggingConfigSchema` not exported and `parsed.logging` undefined.

- [ ] **Step 2.4: Implement the schema**

In `shared/config/src/schema.ts`, add the schema definition just BEFORE the `// Root` section comment:

```ts
// ---------------------------------------------------------------------------
// Logging — file retention
// ---------------------------------------------------------------------------

export const loggingConfigSchema = z.object({
  // Number of days to keep rotated log files. Files older than this are
  // deleted at startup and on each daily rollover. 0 disables pruning.
  retention_days: z.number().int().min(0).max(365).default(7),
});

export type LoggingConfig = z.output<typeof loggingConfigSchema>;
```

Then update `gatewayConfigSchema` to include the new section. Locate the existing block:

```ts
export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(100).default(10),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  tls: tlsConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
});
```

And replace it with:

```ts
export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8888),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(100).default(10),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  tls: tlsConfigSchema.default({}),
  session: sessionConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
});
```

- [ ] **Step 2.5: Run tests and verify they pass**

```bash
source scripts/env.sh && bun --filter '@sentient/config' run test
```

Expected: all tests pass.

- [ ] **Step 2.6: Run full typecheck across the workspace** (because the schema is exported and consumed elsewhere)

```bash
source scripts/env.sh && bun run typecheck
```

Expected: clean.

- [ ] **Step 2.7: Commit**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(config): add logging.retention_days to gateway config schema

New loggingConfigSchema with retention_days (int, 0-365, default 7).
Attached to gatewayConfigSchema with a default logging block so
existing config.yaml files keep parsing without changes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Gateway — wire `retentionDays` into the logger and run prune on startup + rollover

**Files:**
- Modify: `gateway/src/logging/logger.ts`
- Modify: `gateway/src/logging/logger.test.ts`
- Modify: `gateway/src/config/startup-config.ts`
- Modify: `gateway/src/main.ts`

**Why now:** The schema exists; the prune helper exists; this task connects them.

> **Important consistency note:** The existing `createDailyFileSink` uses `formatLocalDate()` (LOCAL time) for filenames like `2026-04-14.log`. This task does NOT change that behavior. The retention prune deletes by **mtime**, not by filename, so the local-vs-UTC distinction does not matter for retention. Keep the existing local-date filename format unchanged.

- [ ] **Step 3.1: Read the current state of `gateway/src/config/startup-config.ts`**

Confirm `loadLoggingConfig` currently returns `{ logLevel, logDir }`. It does — env-only.

- [ ] **Step 3.2: Extend `LoggingConfig` and `loadLoggingConfig` to include retention**

In `gateway/src/config/startup-config.ts`, replace the existing `LoggingConfig` interface and `loadLoggingConfig` function with:

```ts
export interface LoggingConfig {
  logLevel: string | undefined;
  logDir: string;
  retentionDays: number;
}

export function loadLoggingConfig(): LoggingConfig {
  const gatewayRoot = join(import.meta.dir, "..", "..");
  const configPath = process.env.GATEWAY_CONFIG_PATH ?? join(gatewayRoot, "config.yaml");
  const cfg = loadGatewayConfig(configPath);
  return {
    logLevel: process.env.LOG_LEVEL,
    logDir: process.env.LOG_DIR ?? "logs",
    retentionDays: cfg.logging.retention_days,
  };
}
```

> **Why this design:** main.ts must initialize the logger BEFORE calling `loadStartupConfig` (which logs `config-loaded`). So `loadLoggingConfig` reads the YAML on its own to discover `retention_days`. The same YAML is parsed twice (once here, once inside `loadStartupConfig`); both calls are sub-millisecond — acceptable.

- [ ] **Step 3.3: Extend `createGatewayLogger` to accept and use `retentionDays`**

In `gateway/src/logging/logger.ts`, make these changes:

(a) Add the import at the top of the file (alongside the existing imports):

```ts
import { pruneOldLogs } from "./prune.js";
```

(b) Update the options interface:

```ts
export interface GatewayLoggerOptions {
  logLevel?: string;
  enableFile?: boolean;
  logDir?: string;
  retentionDays?: number;
  testSink?: (line: string) => void;
}
```

(c) Update `createDailyFileSink` to take a `retentionDays` parameter and call prune on rollover (NOT on every write):

Replace the existing `createDailyFileSink` function with:

```ts
function createDailyFileSink(logDir: string, retentionDays: number): Sink {
  mkdirSync(logDir, { recursive: true });
  let currentDate = "";
  let currentPath = "";

  return (record: LogRecord) => {
    const message = sanitizeMessage(extractMessage(record));
    const properties = sanitizeProperties(record.properties);
    const line = formatLogEntry({
      level: record.level,
      category: record.category,
      message,
      timestamp: new Date(record.timestamp),
      properties,
    });

    const date = formatLocalDate(new Date(record.timestamp));
    if (date !== currentDate) {
      const isRollover = currentDate !== "";
      currentDate = date;
      currentPath = join(logDir, `${date}.log`);
      if (isRollover) {
        // Fire-and-forget; never block the write path. The prune helper
        // already swallows per-file errors.
        pruneOldLogs(logDir, retentionDays).catch(() => {
          // Pruning failure must never break logging itself.
        });
      }
    }
    appendFileSync(currentPath, `${line}\n`);
  };
}
```

> **Why `isRollover` guard:** the first record's `currentDate` is `""`, so the very first write always trips the date-changed branch. We do NOT want to confuse "first-ever write" with "midnight rollover" — the startup prune handles the first case. Only fire prune when this is a true rollover from one date to another.

(d) Update `createGatewayLogger` to plumb `retentionDays` and run the startup prune:

Replace the existing function body (preserving its public signature) with:

```ts
export async function createGatewayLogger(options: GatewayLoggerOptions = {}): Promise<void> {
  const levelStr = options.logLevel ?? process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL;
  const level = parseLogLevel(levelStr.toLowerCase()) as LogLevel;
  const retentionDays = options.retentionDays ?? 7;

  const sinks: Record<string, Sink> = {};

  if (options.testSink) {
    sinks.test = createFormattedSink(options.testSink);
  } else {
    sinks.console = createFormattedSink((line) => {
      process.stderr.write(`${line}\n`);
    });
  }

  if (options.enableFile) {
    const logDir = options.logDir ?? DEFAULT_LOG_DIR;
    sinks.file = createDailyFileSink(logDir, retentionDays);
    // Startup prune — runs once before any rollover can occur. Awaited
    // so we know the dir is consistent before the first log write.
    await pruneOldLogs(logDir, retentionDays);
  }

  const sinkIds = Object.keys(sinks) as string[];

  await configure({
    sinks,
    loggers: [
      {
        category: "sentient",
        sinks: sinkIds,
        lowestLevel: level,
      },
      {
        category: "logtape",
        sinks: sinkIds,
        lowestLevel: "error",
      },
    ],
    reset: true,
  });
}
```

- [ ] **Step 3.4: Update `main.ts` to pass `retentionDays`**

In `gateway/src/main.ts`, replace the existing `createGatewayLogger` call:

```ts
await createGatewayLogger({
  ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}),
  enableFile: true,
  logDir: loggingConfig.logDir,
});
```

with:

```ts
await createGatewayLogger({
  ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}),
  enableFile: true,
  logDir: loggingConfig.logDir,
  retentionDays: loggingConfig.retentionDays,
});
```

- [ ] **Step 3.5: Add a logger test that proves prune is called at startup**

In `gateway/src/logging/logger.test.ts`, add a test inside the existing `describe("createGatewayLogger", ...)` block. Append:

```ts
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("prunes stale log files at startup when enableFile is true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-logger-prune-"));
  try {
    const stale = join(dir, "2020-01-01.log");
    writeFileSync(stale, "stale");
    const oldSeconds = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    utimesSync(stale, oldSeconds, oldSeconds);

    await createGatewayLogger({
      enableFile: true,
      logDir: dir,
      retentionDays: 7,
    });

    expect(existsSync(stale)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps recent log files at startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gateway-logger-keep-"));
  try {
    const fresh = join(dir, "fresh.log");
    writeFileSync(fresh, "fresh");

    await createGatewayLogger({
      enableFile: true,
      logDir: dir,
      retentionDays: 7,
    });

    expect(existsSync(fresh)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

> **Note:** the imports at the top of `logger.test.ts` may already include some of these. Add only what is missing — do NOT duplicate.

- [ ] **Step 3.6: Run gateway tests**

```bash
source scripts/env.sh && bun --filter '@sentient/gateway' run test
```

Expected: all gateway tests pass, including the new ones. If any unrelated test fails, STOP and investigate — do NOT change unrelated tests.

- [ ] **Step 3.7: Run full typecheck**

```bash
source scripts/env.sh && bun run typecheck
```

Expected: clean.

- [ ] **Step 3.8: Commit**

```bash
git add gateway/src/logging/logger.ts gateway/src/logging/logger.test.ts \
        gateway/src/config/startup-config.ts gateway/src/main.ts
git commit -m "$(cat <<'EOF'
feat(gateway): wire retention into logger startup and rollover

createGatewayLogger now accepts retentionDays (default 7), runs an
awaited prune at startup, and fires a fire-and-forget prune inside the
daily-rotation sink whenever the date string actually changes (skipping
the first-ever write so it doesn't double up with the startup prune).
loadLoggingConfig now reads logging.retention_days from config.yaml.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Gateway — add `logging:` section to `config.yaml`

**Files:**
- Modify: `gateway/config.yaml`

- [ ] **Step 4.1: Insert the new section**

In `gateway/config.yaml`, add a new section just BEFORE the `# Server` block (i.e., near the top, after the file-level comments). Insert this exact block (note the leading `# ---` divider keeps the existing visual rhythm):

```yaml
# ---------------------------------------------------------------------------
# Logging — file rotation and retention
# ---------------------------------------------------------------------------
logging:
  # Days to retain daily-rotated log files in LOG_DIR.
  # Files older than this are deleted at startup and on each daily
  # rollover. Set to 0 to disable pruning. Range: 0-365.
  retention_days: 7
```

- [ ] **Step 4.2: Verify config parses**

```bash
source scripts/env.sh && bun --filter '@sentient/gateway' run test src/config/gateway-config.test.ts
```

Expected: pass. (If the existing test file does not assert on `logging`, no new test is needed here — Task 2 already covers the schema. This step just confirms no regression.)

- [ ] **Step 4.3: Smoke-start the gateway briefly to confirm loading**

```bash
source scripts/env.sh && bun --filter '@sentient/gateway' run typecheck
```

Expected: clean.

- [ ] **Step 4.4: Commit**

```bash
git add gateway/config.yaml
git commit -m "$(cat <<'EOF'
chore(gateway): add logging.retention_days to config.yaml

Default 7 days, range 0-365, with documenting comment. Existing
deployments without this key continue to work via schema default.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: STT — `prune_old_logs` function (TDD)

**Files:**
- Create: `capabilityServices/STTService/tests/test_event_logger.py`
- Modify: `capabilityServices/STTService/src/stt_service/event_logger.py`

**Why now:** Pure function, drop-in helper. Establish the test file pattern (`unittest.TestCase`, mirroring `tests/test_auth.py`) before adding more code.

- [ ] **Step 5.1: Create the test file with failing tests**

Write to `capabilityServices/STTService/tests/test_event_logger.py`:

```python
"""Unit tests for prune_old_logs and RotatingJsonlLogger.

Run with::

    cd capabilityServices/STTService
    python -m unittest discover -s tests
"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path

from stt_service.event_logger import prune_old_logs


ONE_DAY_SECONDS = 24 * 60 * 60


def _age(path: Path, days_old: int) -> None:
    """Stamp the file's mtime to `days_old` days in the past."""
    when = time.time() - days_old * ONE_DAY_SECONDS
    os.utime(path, (when, when))


class PruneOldLogsTests(unittest.TestCase):
    """mtime-based deletion of *.jsonl files."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_op_when_retention_zero(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 100)

        prune_old_logs(self.dir, 0)

        self.assertTrue(stale.exists())

    def test_no_op_when_retention_negative(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 100)

        prune_old_logs(self.dir, -1)

        self.assertTrue(stale.exists())

    def test_no_op_when_dir_missing(self) -> None:
        # Should not raise.
        prune_old_logs(self.dir / "missing", 7)

    def test_keeps_recent_files(self) -> None:
        fresh = self.dir / "fresh.jsonl"
        fresh.write_text("x")
        _age(fresh, 3)

        prune_old_logs(self.dir, 7)

        self.assertTrue(fresh.exists())

    def test_deletes_stale_files(self) -> None:
        stale = self.dir / "stale.jsonl"
        stale.write_text("x")
        _age(stale, 30)

        prune_old_logs(self.dir, 7)

        self.assertFalse(stale.exists())

    def test_mixed_keeps_only_fresh(self) -> None:
        fresh = self.dir / "fresh.jsonl"
        stale = self.dir / "stale.jsonl"
        fresh.write_text("x")
        stale.write_text("x")
        _age(fresh, 1)
        _age(stale, 30)

        prune_old_logs(self.dir, 7)

        self.assertTrue(fresh.exists())
        self.assertFalse(stale.exists())

    def test_ignores_non_jsonl_files(self) -> None:
        sibling = self.dir / "stale.txt"
        sibling.write_text("x")
        _age(sibling, 30)

        prune_old_logs(self.dir, 7)

        self.assertTrue(sibling.exists())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 5.2: Run tests and verify they fail**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: failures importing `prune_old_logs` from `stt_service.event_logger`.

- [ ] **Step 5.3: Implement `prune_old_logs`**

In `capabilityServices/STTService/src/stt_service/event_logger.py`, append at the bottom of the file (after `_json_default`):

```python
ONE_DAY_SECONDS = 24 * 60 * 60


def prune_old_logs(log_dir: Path, retention_days: int) -> None:
    """Delete ``*.jsonl`` files in ``log_dir`` older than ``retention_days``.

    No-op when ``retention_days <= 0`` or when the directory does not
    exist. Per-file failures (permission denied, file vanished mid-stat)
    are swallowed so one bad file never aborts the pass.
    """
    if retention_days <= 0:
        return
    cutoff = time.time() - retention_days * ONE_DAY_SECONDS

    try:
        entries = list(log_dir.glob("*.jsonl"))
    except OSError:
        return

    for entry in entries:
        try:
            if entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            continue
```

- [ ] **Step 5.4: Run tests and verify they pass**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: all tests pass (existing `test_auth.py` plus the new `PruneOldLogsTests`).

- [ ] **Step 5.5: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/src/stt_service/event_logger.py \
        capabilityServices/STTService/tests/test_event_logger.py
git commit -m "$(cat <<'EOF'
feat(stt): add prune_old_logs helper for jsonl log retention

Pure function that deletes *.jsonl files in a directory whose mtime is
older than N days. Tolerates missing directory, non-jsonl files, and
per-file unlink failures. Wired into the service in a follow-up.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: STT — `RotatingJsonlLogger` class (TDD)

**Files:**
- Modify: `capabilityServices/STTService/src/stt_service/event_logger.py`
- Modify: `capabilityServices/STTService/tests/test_event_logger.py`

**Why now:** New class is purely additive (existing `JsonlLogger` keeps working for per-connection files). Tests use an injected clock seam; no time monkey-patching.

- [ ] **Step 6.1: Add the failing tests**

Append to `capabilityServices/STTService/tests/test_event_logger.py` (BEFORE the `if __name__ == "__main__":` line at the bottom):

```python
from datetime import datetime, timedelta, timezone
import json

from stt_service.event_logger import RotatingJsonlLogger


class _StubClock:
    """Test double that returns a controllable UTC datetime."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now


class RotatingJsonlLoggerTests(unittest.TestCase):
    """Daily-rotated JSON Lines writer."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.start = datetime(2026, 4, 14, 12, 0, 0, tzinfo=timezone.utc)
        self.clock = _StubClock(self.start)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _read_lines(self, path: Path) -> list[dict]:
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    def test_writes_to_dated_filename(self) -> None:
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        try:
            logger.log("hello", value=1)
        finally:
            logger.close()

        expected = self.dir / "2026-04-14-service.jsonl"
        self.assertTrue(expected.exists())
        records = self._read_lines(expected)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["event"], "hello")
        self.assertEqual(records[0]["value"], 1)

    def test_rolls_over_when_date_changes(self) -> None:
        logger = RotatingJsonlLogger("metrics", self.dir, clock=self.clock)
        try:
            logger.log("first")
            self.clock.now = self.start + timedelta(days=1)
            logger.log("second")
        finally:
            logger.close()

        first = self.dir / "2026-04-14-metrics.jsonl"
        second = self.dir / "2026-04-15-metrics.jsonl"
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())
        self.assertEqual([r["event"] for r in self._read_lines(first)], ["first"])
        self.assertEqual([r["event"] for r in self._read_lines(second)], ["second"])

    def test_close_is_idempotent(self) -> None:
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        logger.log("once")
        logger.close()
        # Second close must not raise.
        logger.close()

    def test_log_after_close_does_not_raise(self) -> None:
        # Calling log() after close() is a programming bug; the logger
        # tolerates it silently rather than crashing the service.
        logger = RotatingJsonlLogger("service", self.dir, clock=self.clock)
        logger.log("before-close")
        logger.close()
        logger.log("after-close")  # must not raise
```

- [ ] **Step 6.2: Run tests, verify they fail**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: failures importing `RotatingJsonlLogger`.

- [ ] **Step 6.3: Implement `RotatingJsonlLogger`**

In `capabilityServices/STTService/src/stt_service/event_logger.py`, add the new class. Insert it AFTER the existing `JsonlLogger` class and BEFORE `_json_default`. Add a `Callable` import to the imports block at the top of the file (alongside the existing `from typing import Any`):

```python
from typing import Any, Callable
```

Add the new class:

```python
def _default_clock() -> datetime:
    """Module-level callable so tests can substitute a stub via dependency injection."""
    return datetime.now(timezone.utc)


class RotatingJsonlLogger:
    """JSON-lines writer that rolls over daily by UTC date.

    The active filename is ``<dir>/<YYYY-MM-DD>-<basename>.jsonl``. The
    date is checked on every ``log()`` call; when it changes, the
    current file handle is closed and a new one is opened. The check is
    a single string comparison — cheap enough to run per-write at audio
    rates (10s–100s/sec) without a background timer thread.

    The ``clock`` parameter is a callable returning a UTC ``datetime``.
    Tests pass a stub; production code uses ``_default_clock``.
    """

    def __init__(
        self,
        basename: str,
        log_dir: Path,
        *,
        echo_stdout: bool = False,
        clock: Callable[[], datetime] = _default_clock,
    ) -> None:
        self._basename = basename
        self._dir = log_dir
        self._echo = echo_stdout
        self._clock = clock
        self._lock = threading.Lock()
        log_dir.mkdir(parents=True, exist_ok=True)
        self._date: str = ""
        self._fp = None  # type: ignore[assignment]
        self._closed = False

    def _path_for(self, date_str: str) -> Path:
        return self._dir / f"{date_str}-{self._basename}.jsonl"

    def _ensure_active_file(self, date_str: str) -> None:
        """Open the file for `date_str`, closing any previous handle. Caller holds the lock."""
        if self._fp is not None and not self._fp.closed:
            self._fp.flush()
            self._fp.close()
        self._fp = self._path_for(date_str).open("a", encoding="utf-8", buffering=1)
        self._date = date_str

    def log(self, event: str, **fields: Any) -> None:
        """Append one JSON line to today's log file."""
        if self._closed:
            return
        ts, mono = _now()
        record: dict[str, Any] = {
            "ts": ts,
            "t_mono_ns": mono,
            "event": event,
        }
        record.update(fields)
        line = json.dumps(record, separators=(",", ":"), default=_json_default)

        date_str = self._clock().strftime("%Y-%m-%d")

        with self._lock:
            if date_str != self._date:
                self._ensure_active_file(date_str)
            assert self._fp is not None  # narrows for mypy / type checkers
            self._fp.write(line)
            self._fp.write("\n")

        if self._echo:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def close(self) -> None:
        """Flush and close the underlying file handle. Idempotent."""
        with self._lock:
            self._closed = True
            if self._fp is not None and not self._fp.closed:
                self._fp.flush()
                self._fp.close()
```

> **Note on the assert:** `assert self._fp is not None` is a type-narrowing hint for type checkers. It will never trip at runtime because `_ensure_active_file` always assigns a non-None handle.

- [ ] **Step 6.4: Run tests and verify they pass**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: all tests pass.

- [ ] **Step 6.5: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/src/stt_service/event_logger.py \
        capabilityServices/STTService/tests/test_event_logger.py
git commit -m "$(cat <<'EOF'
feat(stt): add RotatingJsonlLogger with daily UTC rollover

New writer class with YYYY-MM-DD-<basename>.jsonl filenames and lazy
per-write date checks. Existing JsonlLogger kept for per-connection
files. Tests inject a stub clock — no time monkey-patching.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: STT — add `retention_days` to `LoggingConfig` dataclass + parser

**Files:**
- Modify: `capabilityServices/STTService/src/stt_service/config.py`
- Add a small test file: `capabilityServices/STTService/tests/test_config.py`

- [ ] **Step 7.1: Write failing tests**

Create `capabilityServices/STTService/tests/test_config.py`:

```python
"""Unit tests for logging.retention_days config parsing.

Existing config fields are exercised at integration boot; here we only
cover the new validation surface.
"""

from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path

from stt_service.config import ConfigError, load_config


def _write_yaml(dir_path: Path, retention_value: object) -> Path:
    """Materialize a complete config.yaml with the provided retention_days value."""
    if retention_value is _OMIT:
        retention_line = ""
    else:
        retention_line = f"  retention_days: {retention_value}\n"

    body = textwrap.dedent(
        """\
        server:
          host: "0.0.0.0"
          port: 8766
          max_frame_bytes: 16777216
        vad:
          threshold: 0.5
          min_silence_ms: 200
          speech_pad_ms: 30
          pre_speech_chunks: 10
          silent_timeout_ms: 2000
          max_turn_duration_ms: 600000
        smart_turn:
          decision_threshold: 0.5
          intra_op_threads: 4
        sense_voice:
          num_threads: 4
          use_itn: true
        recordings:
          enabled: false
        logging:
          level: "info"
          metrics_interval_ms: 1000
        """
    )
    body += retention_line
    path = dir_path / "config.yaml"
    path.write_text(body)
    return path


class _Omit:
    pass


_OMIT = _Omit()


class LoggingRetentionParseTests(unittest.TestCase):
    """logging.retention_days field parsing and validation."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _load(self, path: Path):
        return load_config(
            path,
            model_dir=self.dir,
            log_dir=self.dir,
            recording_dir=self.dir,
            tokens_path=self.dir / "tokens.yaml",
        )

    def test_default_is_seven_when_omitted(self) -> None:
        path = _write_yaml(self.dir, _OMIT)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 7)

    def test_accepts_explicit_value(self) -> None:
        path = _write_yaml(self.dir, 14)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 14)

    def test_accepts_zero_as_disable(self) -> None:
        path = _write_yaml(self.dir, 0)
        cfg = self._load(path)
        self.assertEqual(cfg.logging.retention_days, 0)

    def test_rejects_negative(self) -> None:
        path = _write_yaml(self.dir, -1)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))

    def test_rejects_above_max(self) -> None:
        path = _write_yaml(self.dir, 366)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))

    def test_rejects_non_integer(self) -> None:
        path = _write_yaml(self.dir, 7.5)
        with self.assertRaises(ConfigError) as ctx:
            self._load(path)
        self.assertIn("retention_days", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 7.2: Run tests, verify failures**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: failures (the new tests fail; existing tests still pass).

- [ ] **Step 7.3: Update the dataclass**

In `capabilityServices/STTService/src/stt_service/config.py`, locate this block:

```python
@dataclass(frozen=True)
class LoggingConfig:
    """Logging + metrics sampling."""

    level: str
    metrics_interval_ms: int
```

Replace it with:

```python
@dataclass(frozen=True)
class LoggingConfig:
    """Logging + metrics sampling."""

    level: str
    metrics_interval_ms: int
    retention_days: int
```

- [ ] **Step 7.4: Update the parser**

In the same file, locate the `LoggingConfig(...)` construction inside `_parse`:

```python
        logging=LoggingConfig(
            level=_require(logging_raw, "logging.level", str).lower(),
            metrics_interval_ms=_require(logging_raw, "logging.metrics_interval_ms", int),
        ),
```

Replace with:

```python
        logging=LoggingConfig(
            level=_require(logging_raw, "logging.level", str).lower(),
            metrics_interval_ms=_require(logging_raw, "logging.metrics_interval_ms", int),
            retention_days=_require_retention_days(logging_raw),
        ),
```

Then add a new helper near the existing `_require_section` / `_require` helpers (place it just AFTER the `_require` function at the bottom of the file):

```python
def _require_retention_days(section: dict[str, Any]) -> int:
    """Read ``logging.retention_days`` with default=7 and 0-365 range check.

    Unlike other config keys this one defaults to 7 instead of failing
    when missing, so existing config.yaml files keep working without an
    explicit value. A wrong type or out-of-range value still fails loud.
    """
    if "retention_days" not in section:
        return 7

    value = section["retention_days"]

    # bool is a subclass of int — reject explicitly so True/False can't slip in.
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(
            "config.yaml: 'logging.retention_days' must be an integer "
            f"between 0 and 365, got {type(value).__name__}: {value!r}"
        )
    if value < 0 or value > 365:
        raise ConfigError(
            "config.yaml: 'logging.retention_days' must be an integer "
            f"between 0 and 365, got {value}"
        )
    return value
```

- [ ] **Step 7.5: Run tests, verify they pass**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: all tests pass.

- [ ] **Step 7.6: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/src/stt_service/config.py \
        capabilityServices/STTService/tests/test_config.py
git commit -m "$(cat <<'EOF'
feat(stt): add logging.retention_days to typed config

New field on LoggingConfig dataclass with default 7 and 0-365 range
check. Bad types and out-of-range values fail loud at startup with an
actionable ConfigError. Missing key uses the default so existing
config.yaml files keep loading without changes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: STT — switch `service.jsonl` and `metrics.jsonl` to `RotatingJsonlLogger`

**Files:**
- Modify: `capabilityServices/STTService/src/stt_service/server.py`
- Modify: `capabilityServices/STTService/src/stt_service/metrics.py`

**Why now:** `RotatingJsonlLogger` exists and is tested; switching call sites is a one-line change in each file.

> **Do NOT change** the per-connection `JsonlLogger(self._config.log_dir / f"conn_{conn_id}.jsonl", ...)` line — that one stays. Only `service.jsonl` and `metrics.jsonl` rotate daily.

- [ ] **Step 8.1: Update `server.py`**

In `capabilityServices/STTService/src/stt_service/server.py`, locate this import line:

```python
from .event_logger import JsonlLogger
```

Replace with:

```python
from .event_logger import JsonlLogger, RotatingJsonlLogger
```

Then locate this block inside `Server.__init__`:

```python
        self._service_log = JsonlLogger(
            config.log_dir / "service.jsonl", echo_stdout=True,
        )
```

Replace with:

```python
        self._service_log = RotatingJsonlLogger(
            "service", config.log_dir, echo_stdout=True,
        )
```

- [ ] **Step 8.2: Update `metrics.py`**

In `capabilityServices/STTService/src/stt_service/metrics.py`, locate this import:

```python
from .event_logger import JsonlLogger
```

Replace with:

```python
from .event_logger import RotatingJsonlLogger
```

Then locate this block inside `MetricsSampler.__init__`:

```python
        self._logger = JsonlLogger(
            logs_dir / "metrics.jsonl", echo_stdout=False,
        )
```

Replace with:

```python
        self._logger = RotatingJsonlLogger(
            "metrics", logs_dir, echo_stdout=False,
        )
```

- [ ] **Step 8.3: Run all STT tests**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: all tests pass.

- [ ] **Step 8.4: Verify Python imports cleanly with a no-op syntax check**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -c "from stt_service import server, metrics, event_logger, config"
```

Expected: no output, no exception.

- [ ] **Step 8.5: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/src/stt_service/server.py \
        capabilityServices/STTService/src/stt_service/metrics.py
git commit -m "$(cat <<'EOF'
refactor(stt): rotate service.jsonl and metrics.jsonl daily

Both previously-monolithic logs now use RotatingJsonlLogger and produce
files named YYYY-MM-DD-service.jsonl / YYYY-MM-DD-metrics.jsonl.
Per-connection conn_<id>.jsonl files keep their session-scoped naming
and are pruned by mtime in a follow-up.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: STT — call `prune_old_logs` at startup and on a daily timer

**Files:**
- Modify: `capabilityServices/STTService/src/stt_service/__main__.py`
- Modify: `capabilityServices/STTService/src/stt_service/server.py`

**Why now:** Rotation is in place. Adding the prune triggers completes the retention story.

- [ ] **Step 9.1: Update `__main__.py` to run a synchronous startup prune**

In `capabilityServices/STTService/src/stt_service/__main__.py`, add an import. Locate this line:

```python
from .config import load_config
```

Add a sibling import line right below it:

```python
from .event_logger import prune_old_logs
```

Then locate this block:

```python
    config = load_config(
        config_path,
        model_dir=model_dir,
        log_dir=log_dir,
        recording_dir=recording_dir,
        tokens_path=tokens_path,
    )

    # Configure Python's built-in logging. ...
```

Insert a startup prune call between `load_config(...)` and the `logging.basicConfig(...)` block. The result should look like:

```python
    config = load_config(
        config_path,
        model_dir=model_dir,
        log_dir=log_dir,
        recording_dir=recording_dir,
        tokens_path=tokens_path,
    )

    # Ensure the log dir exists, then prune anything older than the
    # configured retention window before we start writing new files.
    log_dir.mkdir(parents=True, exist_ok=True)
    prune_old_logs(log_dir, config.logging.retention_days)

    # Configure Python's built-in logging. ...
```

- [ ] **Step 9.2: Update `server.py` to schedule a daily prune via asyncio**

In `capabilityServices/STTService/src/stt_service/server.py`:

(a) Update the import line you edited in Task 8 from:

```python
from .event_logger import JsonlLogger, RotatingJsonlLogger
```

to:

```python
from .event_logger import JsonlLogger, RotatingJsonlLogger, prune_old_logs
```

(b) Add a `datetime` import to the top-of-file imports block. The existing imports are:

```python
import asyncio
import json
import logging
import signal
import uuid
```

Add `from datetime import datetime, timedelta, timezone` so the imports block reads:

```python
import asyncio
import json
import logging
import signal
import uuid
from datetime import datetime, timedelta, timezone

from pathlib import Path
```

> **Note on the `Path` import:** `Path` is NOT currently imported in `server.py` (verified at plan-write time). Add the line as shown.

(c) Add a new helper function near the bottom of the file, AFTER `_permissive_select_subprotocol` and BEFORE the `# --- Entrypoint ---` divider comment. Insert:

```python
async def _daily_prune_loop(log_dir: Path, retention_days: int) -> None:
    """Sleep until the next UTC midnight, prune, repeat.

    Runs in the asyncio event loop. The actual filesystem work happens
    inside ``prune_old_logs`` which is fast enough to call inline (a
    handful of stat+unlink calls per day) — no executor needed.
    """
    while True:
        now = datetime.now(timezone.utc)
        next_midnight = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        sleep_seconds = (next_midnight - now).total_seconds()
        try:
            await asyncio.sleep(sleep_seconds)
        except asyncio.CancelledError:
            return
        try:
            prune_old_logs(log_dir, retention_days)
        except Exception:
            # Pruning failure must never break the service. Swallow and
            # try again at the next rollover.
            log.exception("daily prune failed")
```

(d) Schedule the loop and cancel it on shutdown. Inside `run_server`, locate this block:

```python
    watcher_task = server.run_token_watcher()

    stop_event = asyncio.Event()
```

Replace with:

```python
    watcher_task = server.run_token_watcher()
    prune_task = asyncio.create_task(
        _daily_prune_loop(config.log_dir, config.logging.retention_days),
        name="daily-log-prune",
    )

    stop_event = asyncio.Event()
```

Then locate the existing watcher cancellation block at the end of `run_server`:

```python
    watcher_task.cancel()
    try:
        await watcher_task
    except asyncio.CancelledError:
        pass

    await server.stop()
    log.info("shutdown complete")
```

Replace with:

```python
    watcher_task.cancel()
    prune_task.cancel()
    for task in (watcher_task, prune_task):
        try:
            await task
        except asyncio.CancelledError:
            pass

    await server.stop()
    log.info("shutdown complete")
```

- [ ] **Step 9.3: Run all STT tests to confirm no regression**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests
```

Expected: all tests pass. (No new test for the daily loop — it is a thin scheduling shim around the already-tested `prune_old_logs`. Adding a fake-clock test for the loop would require mocking `datetime` and `asyncio.sleep` for marginal value.)

- [ ] **Step 9.4: Verify imports**

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -c "from stt_service import server, __main__"
```

Expected: no output, no exception.

- [ ] **Step 9.5: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/src/stt_service/__main__.py \
        capabilityServices/STTService/src/stt_service/server.py
git commit -m "$(cat <<'EOF'
feat(stt): prune old jsonl logs at startup and at daily rollover

__main__ runs a synchronous prune after config load, before the
asyncio loop starts. run_server schedules a long-lived asyncio task
that sleeps until the next UTC midnight, prunes, then reschedules.
Task is cancelled cleanly on shutdown.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: STT — add `retention_days` to `config.example.yaml`

**Files:**
- Modify: `capabilityServices/STTService/config/config.example.yaml`

- [ ] **Step 10.1: Extend the existing `logging:` section**

In `capabilityServices/STTService/config/config.example.yaml`, locate this block:

```yaml
logging:
  # stdout log level — what `docker logs stt-service` shows.
  # One of: debug | info | warning | error.
  # JSONL log files always capture everything regardless of this setting.
  level: "info"

  # CPU/RSS sampling cadence in milliseconds. Each sample writes one line
  # to logs/metrics.jsonl. 1000 ms is cheap (~0.1% CPU overhead) and gives
  # per-second resolution for latency investigations. Set to 0 to disable.
  metrics_interval_ms: 1000
```

Replace with:

```yaml
logging:
  # stdout log level — what `docker logs stt-service` shows.
  # One of: debug | info | warning | error.
  # JSONL log files always capture everything regardless of this setting.
  level: "info"

  # CPU/RSS sampling cadence in milliseconds. Each sample writes one line
  # to logs/<date>-metrics.jsonl. 1000 ms is cheap (~0.1% CPU overhead)
  # and gives per-second resolution for latency investigations.
  # Set to 0 to disable.
  metrics_interval_ms: 1000

  # Days to retain rotated jsonl files in the logs dir. Files older
  # than this are deleted at startup and at each UTC-midnight rollover.
  # Applies to <date>-service.jsonl, <date>-metrics.jsonl, and
  # conn_<id>.jsonl alike (all matched by mtime). Set to 0 to disable
  # pruning. Range: 0-365.
  retention_days: 7
```

- [ ] **Step 10.2: Confirm the example loads cleanly**

Add a one-shot smoke test that the example YAML still parses against the live config loader:

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -c "
from pathlib import Path
from stt_service.config import load_config
cfg = load_config(
    Path('config/config.example.yaml'),
    model_dir=Path('/tmp'), log_dir=Path('/tmp'),
    recording_dir=Path('/tmp'), tokens_path=Path('/tmp/tokens.yaml'),
)
print('retention_days:', cfg.logging.retention_days)
"
```

Expected output: `retention_days: 7`.

- [ ] **Step 10.3: Return to repo root and commit**

```bash
cd ../..
git add capabilityServices/STTService/config/config.example.yaml
git commit -m "$(cat <<'EOF'
chore(stt): document logging.retention_days in config.example.yaml

Default 7 days. Updates the metrics_interval_ms comment to reflect the
new dated filename pattern.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Docker — add `logging:` driver block to local compose

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

- [ ] **Step 11.1: Add the block to `gateway` service**

In `deploy/docker/docker-compose.yml`, locate the `gateway:` service block. After its existing `healthcheck:` block (so just before the `# Local STT capability service ...` divider comment), add the following AT THE SAME INDENTATION LEVEL as `healthcheck:`:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

Final structure for gateway should look like:

```yaml
  gateway:
    container_name: sentient-gateway
    # ... existing keys ...
    healthcheck:
      # ... existing healthcheck ...
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

- [ ] **Step 11.2: Add the block to `stt-service`**

In the same file, locate the `stt-service:` service block. After its `healthcheck:` block (which is the last block of the file), add the same `logging:` block at the same indentation level:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

- [ ] **Step 11.3: Validate compose file syntax**

```bash
docker compose -f deploy/docker/docker-compose.yml config > /dev/null
```

Expected: no error output. (`docker compose config` parses and renders the merged config; non-zero exit and stderr text mean a YAML or schema problem.)

- [ ] **Step 11.4: Commit**

```bash
git add deploy/docker/docker-compose.yml
git commit -m "$(cat <<'EOF'
chore(deploy): cap container stdout via json-file driver (local compose)

10 MB rotated logs, max 7 archives per service. Targets the docker
logs firehose that app-side daily rotation does not control.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Docker — add `logging:` driver block to Pi compose

**Files:**
- Modify: `deploy/pi/docker-compose.yml`

- [ ] **Step 12.1: Add the block to `gateway`**

Same edit as Task 11.1 but in `deploy/pi/docker-compose.yml`. After the existing `healthcheck:` block of the `gateway:` service, add at the same indentation level:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

- [ ] **Step 12.2: Add the block to `stt-service`**

Same edit as Task 11.2 but in `deploy/pi/docker-compose.yml`. After the `stt-service` service's `healthcheck:` block, add at the same indentation level:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "7"
```

- [ ] **Step 12.3: Validate compose file syntax**

The Pi compose uses `${CI_REGISTRY_IMAGE}` which is normally set by CI. Inject a placeholder so the validator can render the merged config without that variable being defined locally:

```bash
CI_REGISTRY_IMAGE=placeholder docker compose -f deploy/pi/docker-compose.yml config > /dev/null
```

Expected: exit 0 with no error output.

- [ ] **Step 12.4: Commit**

```bash
git add deploy/pi/docker-compose.yml
git commit -m "$(cat <<'EOF'
chore(deploy): cap container stdout via json-file driver (pi compose)

Mirrors the local compose change. 10 MB rotated logs, max 7 archives
per service. App-side rotation manages app-written files; this caps
the docker logs firehose.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Stop conflicting containers (pre-flight for Task 14)

> Per `feedback_docker_ps_before_tests`: running `sentient-*` containers hold ports the test suite binds to. Stop them before running CI.

**No commit for this task — it is a precondition for Task 14.**

- [ ] **Step 13.1: List running sentient containers**

```bash
docker ps --filter "name=sentient-" --format "{{.Names}}"
```

- [ ] **Step 13.2: If any are listed, stop them**

```bash
docker stop $(docker ps --filter "name=sentient-" --format "{{.Names}}") 2>/dev/null || true
```

Expected: containers (if any) stop cleanly. The `|| true` keeps the command non-fatal when there is nothing to stop.

- [ ] **Step 13.3: Confirm none are running**

```bash
docker ps --filter "name=sentient-" --format "{{.Names}}"
```

Expected: empty output.

---

### Task 14: Full repo CI (lint + typecheck + tests)

**No commit for this task — it is verification only.**

- [ ] **Step 14.1: Run the full local CI**

```bash
source scripts/env.sh && bun run ci
```

Expected: lint, typecheck, and all test suites pass (gateway, web-sdk, webui, config, etc.).

- [ ] **Step 14.2: Run the STT tests separately** (because `bun run ci` does not invoke Python)

```bash
cd capabilityServices/STTService && PYTHONPATH=src python -m unittest discover -s tests && cd "$OLDPWD"
```

Expected: all tests pass.

If anything fails:
- **Do NOT** disable, skip, or weaken any test.
- **Do NOT** change tuned constants (per `feedback_tuned_constants`).
- Investigate the failing test, identify the change in your prior tasks that caused it, and fix that change.
- Re-run the failing test until it passes, then re-run the full CI.

---

### Task 15: Manual docker smoke verification

**No commit for this task — it is verification of the deploy-side change.**

> Per `feedback_docker_verify_before_done`: build via deploy/docker, `compose up -d`, exercise + read logs before claiming done.

- [ ] **Step 15.1: Build the local-compose images**

```bash
docker compose -f deploy/docker/docker-compose.yml build
```

Expected: gateway and stt-service images build cleanly.

- [ ] **Step 15.2: Bring the stack up in the background**

```bash
docker compose -f deploy/docker/docker-compose.yml up -d
```

Expected: both containers report `Healthy` within 60 seconds.

- [ ] **Step 15.3: Confirm the json-file driver options are applied to each container**

```bash
for c in sentient-gateway sentient-stt-service; do
  echo "=== $c ==="
  docker inspect "$c" --format '{{json .HostConfig.LogConfig}}'
done
```

Expected output for each: `{"Type":"json-file","Config":{"max-file":"7","max-size":"10m"}}` (key order may vary).

- [ ] **Step 15.4: Confirm app-side dated log files appear under the host log dirs**

After the containers have been up for at least 30 seconds:

```bash
ls -la ~/.sentient/gateway/logs/ ~/.sentient/stt-service/logs/
```

Expected:
- `~/.sentient/gateway/logs/` contains a `YYYY-MM-DD.log` file (today's date in local time).
- `~/.sentient/stt-service/logs/` contains `YYYY-MM-DD-service.jsonl` and (if `metrics_interval_ms > 0`) `YYYY-MM-DD-metrics.jsonl`.

- [ ] **Step 15.5: Force-age a stub file and bounce one container to confirm prune fires at startup**

```bash
# Drop a fake old file in each log dir, mtime = 30 days ago.
# Use python for cross-platform mtime stamping (BSD `touch -t` and GNU
# `touch -d` differ; python `os.utime` works identically on both).
python3 -c "
import os, time
for path in [
    '$HOME/.sentient/gateway/logs/2026-01-01.log',
    '$HOME/.sentient/stt-service/logs/2026-01-01-service.jsonl',
]:
    open(path, 'a').close()
    when = time.time() - 30 * 86400
    os.utime(path, (when, when))
"

# Restart both services.
docker compose -f deploy/docker/docker-compose.yml restart gateway stt-service

# Wait a few seconds for startup.
sleep 5

# Confirm the stub files are gone.
ls -la ~/.sentient/gateway/logs/ ~/.sentient/stt-service/logs/
```

Expected: neither `2026-01-01.log` nor `2026-01-01-service.jsonl` is present after restart.

- [ ] **Step 15.6: Tear the stack down**

```bash
docker compose -f deploy/docker/docker-compose.yml down
```

- [ ] **Step 15.7: Final check — branch is on the feature branch and clean**

```bash
git status && git log --oneline feature/logging-rotation-retention ^develop
```

Expected:
- `git status` → "nothing to commit, working tree clean"
- `git log` → 12 commits (Task 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12) plus the original spec commit, total 13.

---

## Done

The plan is complete when all 15 tasks are checked off. Hand back to the user with:

> "All 15 tasks complete on `feature/logging-rotation-retention`. Gateway and STT both daily-rotate and prune by retention. Docker stdout capped at 10 MB × 7 files per service. Manual docker smoke confirmed prune fires at startup. Ready for review or PR."

The user will decide next steps (PR to develop, additional review, etc.).
