import { readFileSync, writeFileSync } from "node:fs";
import { type Document, type YAMLMap, isMap, isScalar, parseDocument } from "yaml";
import { getLog } from "../logging/logger.ts";
import { writeFileAtomic } from "../user-auth/atomic-write.ts";

const log = getLog(["sentient", "config", "migration", "operator-config"]);

// ---------------------------------------------------------------------------
// migrateOperatorConfigYaml
//
// Runs BEFORE the zod schema validates the operator's config.yaml.
//
// Migration chain (idempotent — gated on schema_version):
//
//   pre-0.1.0 → 0.1.0: Rewrites legacy `hermes.web_tools.provider:
//     duckduckgo` → `searxng`, drops the duckduckgo sub-block.
//
//   0.1.0 → 0.1.1 (this feature branch — slice 8.1):
//     ADD:    session.per_user_max_sessions: 40
//             session.idle_timeout_ms: 900000
//     REMOVE: session_persist_ms (root)
//             session.inactivity_timeout_ms
//             session.inactivity_check_interval_ms
//             session.retention_ttl_ms
//             hermes.defaults.request_timeout_ms
//             hermes.defaults.idempotency_window_s
//             hermes.resource_management (whole block)
//     SET:    schema_version: "0.1.1"
//
//   0.1.1 → 0.1.2 (whisper-stt native — bilingual STT):
//     SET:    stt.language: "auto"   (Whisper autodetects en/zh; the old "en"
//             default forced English and dropped Chinese input)
//             schema_version: "0.1.2"
//
//   0.1.2 → 0.1.3 (session-model task 8 — derived retention):
//     ADD:    session.retention_ms: 900000
//     REMOVE: session.replay_journal_retention_ms  (renamed to retention_ms)
//             session.idle_timeout_ms             (dead since 0.1.1: added by
//                                                  that step, never in the
//                                                  schema, zero readers)
//     SET:    schema_version: "0.1.3"
//
//     The old value is NOT carried across the rename. `replay_journal_retention_ms`
//     bounded JOURNAL BYTES after the last window left; `retention_ms` governs
//     how long a whole SESSION — its runtime, its store handle, its running
//     background tasks — stays resident. A number tuned for the first is not a
//     number tuned for the second, so the migration writes the new default and
//     logs whatever the operator had. Both values reach the log line, so a host
//     that had deliberately tuned it can be re-tuned deliberately.
//
//     `lost_task_threshold_ms` and `retention_recheck_interval_ms` are NOT
//     backfilled: both carry `.default()` in the schema, so an absent key boots
//     (the `replay_journal_max_bytes` precedent).
//
// Uses yaml's Document API to preserve comments and unrelated keys.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pre-0.1.0 → 0.1.0: duckduckgo → searxng web-tools migration
// ---------------------------------------------------------------------------

interface WebToolsMigrationResult {
  providerRewritten: boolean;
  duckduckgoDropped: boolean;
  searxngAdded: boolean;
}

function applyWebToolsMigration(doc: Document): WebToolsMigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const hermesNode = root.get("hermes", true);
  if (!isMap(hermesNode)) return null;

  const webToolsNode = (hermesNode as YAMLMap).get("web_tools", true);
  if (!isMap(webToolsNode)) return null;

  const webTools = webToolsNode as YAMLMap;

  const providerNode = webTools.get("provider", true);
  const currentProvider = isScalar(providerNode) ? String(providerNode.value) : null;

  if (currentProvider !== "duckduckgo") return null;

  const result: WebToolsMigrationResult = {
    providerRewritten: false,
    duckduckgoDropped: false,
    searxngAdded: false,
  };

  webTools.set("provider", "searxng");
  result.providerRewritten = true;

  const hasDdg = webTools.has("duckduckgo");
  if (hasDdg) {
    webTools.delete("duckduckgo");
    result.duckduckgoDropped = true;
  }

  const existingSearxng = webTools.get("searxng", true);
  if (!isMap(existingSearxng)) {
    webTools.set("searxng", doc.createNode({ enabled: true }));
    result.searxngAdded = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// 0.1.0 → 0.1.1: dead-timer removal + required-field backfill
// ---------------------------------------------------------------------------

interface Schema011MigrationResult {
  addedPerUserMaxSessions: boolean;
  addedIdleTimeoutMs: boolean;
  removedKeys: string[];
}

const DEAD_ROOT_KEYS = ["session_persist_ms"] as const;
const DEAD_SESSION_KEYS = ["inactivity_timeout_ms", "inactivity_check_interval_ms", "retention_ttl_ms"] as const;
const DEAD_HERMES_DEFAULTS_KEYS = ["request_timeout_ms", "idempotency_window_s"] as const;
const TARGET_VERSION = "0.1.1";
const SOURCE_VERSION = "0.1.0";

function applySchema011Migration(doc: Document): Schema011MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  // Gate: only run when schema_version is "0.1.0" (or absent — treat as pre-versioned).
  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === TARGET_VERSION) return null; // already migrated

  // Allow migration for hosts on 0.1.0 OR hosts with no schema_version yet
  // (they will have been on the old ddg→searxng migration but not versioned).
  if (currentVersion !== null && currentVersion !== SOURCE_VERSION) return null;

  const result: Schema011MigrationResult = {
    addedPerUserMaxSessions: false,
    addedIdleTimeoutMs: false,
    removedKeys: [],
  };

  // --- Remove dead root keys ---
  for (const key of DEAD_ROOT_KEYS) {
    if (root.has(key)) {
      root.delete(key);
      result.removedKeys.push(key);
    }
  }

  // --- Remove dead session keys ---
  const sessionNode = root.get("session", true);
  if (isMap(sessionNode)) {
    const session = sessionNode as YAMLMap;
    for (const key of DEAD_SESSION_KEYS) {
      if (session.has(key)) {
        session.delete(key);
        result.removedKeys.push(`session.${key}`);
      }
    }
    // Backfill required fields if missing (fail-loud guard).
    if (!session.has("per_user_max_sessions")) {
      session.set("per_user_max_sessions", 40);
      result.addedPerUserMaxSessions = true;
    }
    if (!session.has("idle_timeout_ms")) {
      session.set("idle_timeout_ms", 900000);
      result.addedIdleTimeoutMs = true;
    }
  }

  // --- Remove dead hermes.defaults keys + hermes.resource_management ---
  const hermesNode = root.get("hermes", true);
  if (isMap(hermesNode)) {
    const hermes = hermesNode as YAMLMap;

    const defaultsNode = hermes.get("defaults", true);
    if (isMap(defaultsNode)) {
      const defaults = defaultsNode as YAMLMap;
      for (const key of DEAD_HERMES_DEFAULTS_KEYS) {
        if (defaults.has(key)) {
          defaults.delete(key);
          result.removedKeys.push(`hermes.defaults.${key}`);
        }
      }
    }

    if (hermes.has("resource_management")) {
      hermes.delete("resource_management");
      result.removedKeys.push("hermes.resource_management");
    }
  }

  // --- Bump schema_version ---
  root.set("schema_version", TARGET_VERSION);

  return result;
}

// ---------------------------------------------------------------------------
// 0.1.1 → 0.1.2: STT decode language en → auto (bilingual autodetect)
// ---------------------------------------------------------------------------

const SCHEMA_012_VERSION = "0.1.2";

interface Schema012MigrationResult {
  languagePrev: string | null;
  languageSetToAuto: boolean;
}

function applySchema012Migration(doc: Document): Schema012MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_012_VERSION) return null; // already migrated
  // Runs only at 0.1.1 — reached fresh, or via the 0.1.0→0.1.1 step in the same
  // pass (that step sets schema_version to TARGET_VERSION = "0.1.1" first).
  if (currentVersion !== TARGET_VERSION) return null;

  const result: Schema012MigrationResult = { languagePrev: null, languageSetToAuto: false };

  const sttNode = root.get("stt", true);
  if (isMap(sttNode)) {
    const stt = sttNode as YAMLMap;
    const langNode = stt.get("language", true);
    result.languagePrev = isScalar(langNode) ? String(langNode.value) : null;
    stt.set("language", "auto");
    result.languageSetToAuto = result.languagePrev !== "auto";
  }

  root.set("schema_version", SCHEMA_012_VERSION);
  return result;
}

// ---------------------------------------------------------------------------
// 0.1.2 → 0.1.3: session retention rename (journal bytes → session lifetime)
// ---------------------------------------------------------------------------

const SCHEMA_013_VERSION = "0.1.3";
const RETENTION_MS_DEFAULT = 900000;
/** Keys this step removes from the `session:` block. `replay_journal_retention_ms`
 *  is superseded by `retention_ms`; `idle_timeout_ms` is the dead key the 0.1.1
 *  step added and nothing ever read. */
const RENAMED_RETENTION_KEY = "replay_journal_retention_ms";
const DEAD_SESSION_KEYS_013 = [RENAMED_RETENTION_KEY, "idle_timeout_ms"] as const;

interface Schema013MigrationResult {
  /** What `replay_journal_retention_ms` held, so a deliberately-tuned host can
   *  be re-tuned deliberately rather than silently reset. */
  replayJournalRetentionMsPrev: number | null;
  retentionMsAdded: boolean;
  removedKeys: string[];
}

function applySchema013Migration(doc: Document): Schema013MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_013_VERSION) return null; // already migrated
  // Runs only at 0.1.2 — reached fresh, or via the earlier steps in this pass.
  if (currentVersion !== SCHEMA_012_VERSION) return null;

  const result: Schema013MigrationResult = {
    replayJournalRetentionMsPrev: null,
    retentionMsAdded: false,
    removedKeys: [],
  };

  const sessionNode = root.get("session", true);
  if (isMap(sessionNode)) {
    const session = sessionNode as YAMLMap;

    const previous = session.get(RENAMED_RETENTION_KEY, true);
    if (isScalar(previous) && typeof previous.value === "number") {
      result.replayJournalRetentionMsPrev = previous.value;
    }

    for (const key of DEAD_SESSION_KEYS_013) {
      if (session.has(key)) {
        session.delete(key);
        result.removedKeys.push(`session.${key}`);
      }
    }

    if (!session.has("retention_ms")) {
      session.set("retention_ms", RETENTION_MS_DEFAULT);
      result.retentionMsAdded = true;
    }
  }

  root.set("schema_version", SCHEMA_013_VERSION);
  return result;
}

// ---------------------------------------------------------------------------
// Public API — sync (used by loadStartupConfig) + async (tests, future use)
// ---------------------------------------------------------------------------

function applyAllMigrations(doc: Document): boolean {
  const webToolsResult = applyWebToolsMigration(doc);
  const schema011Result = applySchema011Migration(doc);
  const schema012Result = applySchema012Migration(doc);
  const schema013Result = applySchema013Migration(doc);

  if (webToolsResult !== null) {
    log.info("migration:web-tools", {
      providerRewritten: webToolsResult.providerRewritten,
      duckduckgoDropped: webToolsResult.duckduckgoDropped,
      searxngAdded: webToolsResult.searxngAdded,
    });
  }

  if (schema011Result !== null) {
    log.info("migration:0.1.1", {
      addedPerUserMaxSessions: schema011Result.addedPerUserMaxSessions,
      addedIdleTimeoutMs: schema011Result.addedIdleTimeoutMs,
      removedKeys: schema011Result.removedKeys,
    });
  }

  if (schema012Result !== null) {
    log.info("migration:0.1.2", {
      languagePrev: schema012Result.languagePrev,
      languageSetToAuto: schema012Result.languageSetToAuto,
    });
  }

  if (schema013Result !== null) {
    log.info("migration:0.1.3", {
      replayJournalRetentionMsPrev: schema013Result.replayJournalRetentionMsPrev,
      retentionMs: RETENTION_MS_DEFAULT,
      retentionMsAdded: schema013Result.retentionMsAdded,
      removedKeys: schema013Result.removedKeys,
      reason:
        "the key now governs SESSION lifetime, not journal bytes — the previous value was not carried across the rename",
    });
  }

  return webToolsResult !== null || schema011Result !== null || schema012Result !== null || schema013Result !== null;
}

/**
 * Sync variant used by `loadStartupConfig` (which is sync).
 * Reads `configPath`, applies all pending migrations if needed,
 * and writes back. No-op if already fully migrated. Errors are logged
 * as warnings; the caller continues — the schema will surface the mismatch
 * if migration somehow fails.
 */
export function migrateOperatorConfigYamlSync(configPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e: unknown) {
    log.warn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    log.warn("parse-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  const changed = applyAllMigrations(doc);
  if (!changed) return;

  const updated = doc.toString();
  try {
    writeFileSync(configPath, updated, { encoding: "utf-8" });
  } catch (e: unknown) {
    log.warn("write-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  log.info("migrated", { path: configPath });
}

/**
 * Async variant with true atomic write (tmp→rename). Used in contexts where
 * async is already available (e.g. tests, future async boot path).
 */
export async function migrateOperatorConfigYaml(configPath: string): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e: unknown) {
    log.warn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    log.warn("parse-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  const changed = applyAllMigrations(doc);
  if (!changed) return;

  const updated = doc.toString();
  try {
    await writeFileAtomic(configPath, updated);
  } catch (e: unknown) {
    log.warn("write-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  log.info("migrated", { path: configPath });
}
