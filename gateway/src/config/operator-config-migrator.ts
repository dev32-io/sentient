import { readFileSync, writeFileSync } from "node:fs";
import { type Document, type Pair, type YAMLMap, isMap, isScalar, parseDocument } from "yaml";
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
//   0.1.3 → 0.1.4 (inbound-proxy — gateway binds loopback):
//     SET:    host: "127.0.0.1"   (only when it was still the literal
//             "0.0.0.0" — a host an operator customised deliberately is left
//             untouched)
//             schema_version: "0.1.4"
//     ADD:    managed_services.inbound-proxy  (the policy entry for the new
//             outward-facing door)
//             inbound_proxy.cert_dir: null    (so the block exists and an
//             operator can see where to point a real cert)
//
//     The bind change and the two additions are ONE step on purpose. Taking the
//     old door away without installing the new one leaves a host reachable from
//     nowhere but itself, silently — and rollback cannot undo it, because a
//     rolled-back binary still reads the already-migrated config.
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
// 0.1.3 → 0.1.4: the gateway binds loopback, inbound-proxy owns the LAN
// ---------------------------------------------------------------------------

const SCHEMA_014_VERSION = "0.1.4";
const HOST_ALL_INTERFACES = "0.0.0.0";
const HOST_LOOPBACK = "127.0.0.1";
const MANAGED_SERVICES_KEY = "managed_services";
const INBOUND_PROXY_SERVICE_NAME = "inbound-proxy";
const INBOUND_PROXY_CONFIG_KEY = "inbound_proxy";
const TLS_KEY = "tls";

/** The `managed_services.inbound-proxy` policy entry, verbatim from the shipped
 *  gateway/config.yaml. Written as YAML rather than an object literal so the
 *  operator's file gets the same comments the shipped file carries — a policy
 *  entry that appears from nowhere with no explanation is worse than no entry. */
const INBOUND_PROXY_SERVICE_YAML = `\
template: inbound-proxy.yaml
allowed_images: ["sentient/inbound-proxy:local"]
networks: ["sentient-edge"]
# INFRASTRUCTURE class — see gateway/src/system-orchestrator/types.ts#infra.
# Applied before the wizard (it IS the route to the wizard), never given up on
# by the watchdog, and not recreated while unchanged and healthy. Load-bearing:
# without it those three behaviours are dead code for the only service they
# exist to protect.
infra: true
# Grants the ONE public-port exception in the stack. Admits 0.0.0.0:80 and
# 0.0.0.0:443 only, enforced at three layers. Load-bearing: without it all three
# layers refuse the container and nothing listens on the LAN.
public_ports: true
# Probes the door the LAN actually uses. Self-signed in dev, so the probe is TCP
# rather than HTTP — an HTTP probe would need a trust anchor the orchestrator
# has no reason to carry.
healthcheck:
  tcp: "127.0.0.1:443"
  timeout_ms: 30000
# Deliberately EMPTY. nginx resolves its upstream at request time, so it does not
# need the gateway to be up first — and it must not, since the gateway is what
# starts it.
depends_on: []
optional: false
`;

const INBOUND_PROXY_SERVICE_COMMENT = `\
 inbound-proxy — the ONE outward-facing door (design 2026-08-04 §2).
 ADDED BY THE 0.1.3 -> 0.1.4 MIGRATION, in the same step that moved \`host\` to
 127.0.0.1. The bind change alone would leave this host reachable from nowhere
 but itself. Hand-edit freely: the migration never touches an entry that already
 exists.`;

const INBOUND_PROXY_CONFIG_YAML = "cert_dir: null\n";

const INBOUND_PROXY_CONFIG_COMMENT = `\
 inbound-proxy — the ONE outward-facing door (design 2026-08-04 §2).
 ADDED BY THE 0.1.3 -> 0.1.4 MIGRATION.
 cert_dir: directory holding the cert.pem + key.pem presented on 443. null =
 use the gateway's own self-signed material (~/.sentient/gateway/certs), which
 is the dev default and the fresh-host fallback. Point it at a real, externally
 managed cert once one exists:
   cert_dir: /Users/OPERATOR/.data/certs/sentient.dev32.io
 Renewing a cert IN PLACE (same path, new bytes) does not change the container
 spec, so the proxy is skipped as unchanged: restarting the gateway does NOT
 reload it. Run \`docker kill -s HUP sentient-inbound-proxy\` after a renewal.`;

interface Schema014MigrationResult {
  /** What `host` held before, so an operator who chose a value deliberately can
   *  see it in the log rather than discovering it from a refused connection. */
  hostPrev: string | null;
  hostRewritten: boolean;
  /** The `managed_services.inbound-proxy` policy entry this step wrote. False
   *  when the operator already had one — theirs is never overwritten. */
  inboundProxyServiceAdded: boolean;
  /** True when the host had no `managed_services:` block at all and this step
   *  created one to hold the entry. */
  managedServicesBlockCreated: boolean;
  /** The root `inbound_proxy:` block this step wrote. */
  inboundProxyConfigAdded: boolean;
}

/** Parse a static YAML snippet into a node this document can adopt. The snippet
 *  is a compile-time constant, so a parse failure is a programming error, not an
 *  operator-input error. */
function parseSnippet(snippet: string): unknown {
  return parseDocument(snippet).contents;
}

/** Builds a commented pair. The comment is not decoration: a policy entry that
 *  appears in an operator's file from nowhere, with no provenance, is the kind
 *  of thing that gets deleted by the next person trying to tidy up. */
function commentedPair(doc: Document, key: string, value: unknown, comment: string): Pair {
  const pair = doc.createPair(key, value);
  if (isScalar(pair.key)) pair.key.commentBefore = comment;
  return pair;
}

/** Inserts a root-level pair immediately after `afterKey`, or appends when that
 *  key is absent. Position is cosmetic — an operator reading their config finds
 *  `inbound_proxy:` beside `tls:`, where the shipped file puts it. */
function insertRootPairAfter(root: YAMLMap, pair: Pair, afterKey: string): void {
  const anchorIndex = root.items.findIndex((item) => isScalar(item.key) && item.key.value === afterKey);
  if (anchorIndex === -1) root.items.push(pair);
  else root.items.splice(anchorIndex + 1, 0, pair);
}

/** Backfills `managed_services.inbound-proxy`. Idempotent twice over: the
 *  version gate above runs this step once, and an existing entry — an operator
 *  who added one by hand — is left exactly as they wrote it. */
function backfillInboundProxyService(doc: Document, root: YAMLMap): { added: boolean; blockCreated: boolean } {
  let servicesNode: unknown = root.get(MANAGED_SERVICES_KEY, true);
  let blockCreated = false;

  if (!isMap(servicesNode)) {
    // No block at all. That host runs no managed addons — and the loopback bind
    // in this same step just took away the only way in, so it needs the door
    // more than anyone.
    servicesNode = doc.createNode({});
    root.set(MANAGED_SERVICES_KEY, servicesNode);
    blockCreated = true;
  }

  const services = servicesNode as YAMLMap;
  if (services.has(INBOUND_PROXY_SERVICE_NAME)) return { added: false, blockCreated };

  services.items.push(
    commentedPair(
      doc,
      INBOUND_PROXY_SERVICE_NAME,
      parseSnippet(INBOUND_PROXY_SERVICE_YAML),
      INBOUND_PROXY_SERVICE_COMMENT,
    ),
  );

  return { added: true, blockCreated };
}

/** Backfills the root `inbound_proxy:` block. An absent block is legal (the
 *  schema defaults it), so this is about VISIBILITY: an operator who cannot see
 *  the key has no reason to think a real cert is configurable at all. */
function backfillInboundProxyConfig(doc: Document, root: YAMLMap): boolean {
  if (isMap(root.get(INBOUND_PROXY_CONFIG_KEY, true))) return false;

  const pair = commentedPair(
    doc,
    INBOUND_PROXY_CONFIG_KEY,
    parseSnippet(INBOUND_PROXY_CONFIG_YAML),
    INBOUND_PROXY_CONFIG_COMMENT,
  );
  insertRootPairAfter(root, pair, TLS_KEY);
  return true;
}

/** Moves the gateway off every interface and behind inbound-proxy, and installs
 *  inbound-proxy in the same breath.
 *
 *  This step exists because production reads a SEEDED operator config that the
 *  installer never overwrites — changing the checked-in default alone would
 *  leave every existing mini listening on 0.0.0.0 forever, with the new proxy
 *  in front of a gateway that is still directly reachable beside it.
 *
 *  ONE STEP, DELIBERATELY. Nothing merges the shipped config.yaml's policy block
 *  into a seeded operator config, so a bind change on its own would flip the
 *  gateway to loopback while the registry still had no inbound-proxy: no
 *  listener on 80 or 443, no error, no WARN, and a host reachable from nowhere
 *  but itself. Rollback cannot undo that either — a rolled-back binary reads the
 *  same already-migrated config. So the two writes must not be separable.
 *
 *  Only the literal 0.0.0.0 is rewritten. A host that says anything else was
 *  set on purpose, and silently overriding a deliberate choice is worse than
 *  leaving a warning in the log. */
export function applySchema014Migration(doc: Document): Schema014MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_014_VERSION) return null; // already migrated
  if (currentVersion !== SCHEMA_013_VERSION) return null;

  const hostNode = root.get("host", true);
  const hostPrev = isScalar(hostNode) ? String(hostNode.value) : null;
  const hostRewritten = hostPrev === HOST_ALL_INTERFACES;
  if (hostRewritten) root.set("host", HOST_LOOPBACK);

  const service = backfillInboundProxyService(doc, root);
  const inboundProxyConfigAdded = backfillInboundProxyConfig(doc, root);

  root.set("schema_version", SCHEMA_014_VERSION);
  return {
    hostPrev,
    hostRewritten,
    inboundProxyServiceAdded: service.added,
    managedServicesBlockCreated: service.blockCreated,
    inboundProxyConfigAdded,
  };
}

// ---------------------------------------------------------------------------
// Public API — sync (used by loadStartupConfig) + async (tests, future use)
// ---------------------------------------------------------------------------

function applyAllMigrations(doc: Document): boolean {
  const webToolsResult = applyWebToolsMigration(doc);
  const schema011Result = applySchema011Migration(doc);
  const schema012Result = applySchema012Migration(doc);
  const schema013Result = applySchema013Migration(doc);
  const schema014Result = applySchema014Migration(doc);

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

  if (schema014Result !== null) {
    // Three distinct cases — an absent key is NOT a customisation, and must not
    // be logged as one: it resolves to the schema's own default (127.0.0.1),
    // not to whatever this migration step did or didn't touch.
    const hostReason =
      schema014Result.hostPrev === null
        ? "no host key present — the schema default (127.0.0.1) applies"
        : schema014Result.hostRewritten
          ? "the gateway now binds loopback; inbound-proxy owns the LAN-facing 443"
          : "host was customised — left as-is; set it to 127.0.0.1 manually to sit behind inbound-proxy";
    log.info("migration:0.1.4", {
      hostPrev: schema014Result.hostPrev,
      hostRewritten: schema014Result.hostRewritten,
      reason: hostReason,
    });
    // Logged separately from the host rewrite so the two halves of the step are
    // both visible: the door that closed AND the door that opened.
    log.info("migration:0.1.4:inbound-proxy", {
      serviceEntryAdded: schema014Result.inboundProxyServiceAdded,
      managedServicesBlockCreated: schema014Result.managedServicesBlockCreated,
      certDirBlockAdded: schema014Result.inboundProxyConfigAdded,
      reason: schema014Result.inboundProxyServiceAdded
        ? "the gateway now binds loopback, so the LAN needs inbound-proxy in managed_services — nothing else merges the shipped policy block into a seeded operator config"
        : "an inbound-proxy entry was already present — left exactly as the operator wrote it",
    });
  }

  return (
    webToolsResult !== null ||
    schema011Result !== null ||
    schema012Result !== null ||
    schema013Result !== null ||
    schema014Result !== null
  );
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
