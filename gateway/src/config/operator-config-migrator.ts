import { readFileSync, writeFileSync } from "node:fs";
import type { ImpactTier } from "@sentient/protocol";
import {
  type Document,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";
import { getLog } from "../logging/logger.ts";
import { writeFileAtomic } from "../user-auth/atomic-write.ts";

const log = getLog(["sentient", "config", "migration", "operator-config"]);

// ---------------------------------------------------------------------------
// Deferred logging — this module runs BEFORE the logger exists
// ---------------------------------------------------------------------------
//
// `main.ts` calls `loadLoggingConfig()` to learn where the log file goes, and
// THAT is what runs this migration (startup-config.ts). So `createGatewayLogger`
// has not run yet, and a `log.warn` from here reaches nothing at all — verified
// empirically: no console line, no file line, silently dropped. The second
// migration call inside `loadStartupConfig` cannot re-emit it either, because
// the version is already bumped by then and the whole chain no-ops.
//
// That matters because deploy/README.md tells an operator to grep for
// `migration:0.1.5:unknown-tools` after an upgrade. A signal nobody can receive
// is worse than no signal, since it reads as "nothing happened".
//
// So every line is BUFFERED here and replayed by `flushMigrationLog`, which
// `loadStartupConfig` calls once the logger is up. The buffer is bounded by the
// number of migration steps, and drained on flush.

type LogFields = Record<string, string | number | boolean | null>;

interface DeferredLogLine {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly fields: LogFields;
}

const deferred: DeferredLogLine[] = [];

function noteInfo(event: string, fields: LogFields): void {
  deferred.push({ level: "info", event, fields });
}

function noteWarn(event: string, fields: LogFields): void {
  deferred.push({ level: "warn", event, fields });
}

/**
 * Replay every line the migration buffered, now that the logger exists. Called
 * once, by `loadStartupConfig`, which main.ts runs well after
 * `createGatewayLogger`. Idempotent: the buffer is drained, so a second call
 * emits nothing.
 */
export function flushMigrationLog(): void {
  const pending = deferred.splice(0, deferred.length);
  for (const line of pending) {
    if (line.level === "warn") log.warn(line.event, line.fields);
    else log.info(line.event, line.fields);
  }
}

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
//   0.1.4 → 0.1.5 (per-tool permissions — every tool declares an impact tier):
//     SET:    mcp_catalog.*.tools.include[] and .available[] entries from bare
//             strings (`- ha_get_state`) to `{ name, tier }` maps, with `tier`
//             taken from the shipped catalog as it stood at this step.
//             schema_version: "0.1.5"
//
//     `tier` is REQUIRED and has no default (shared/config/src/schemas/
//     mcp-catalog.ts), and the operator config is parsed by `schema.parse`,
//     which throws on a path nothing on the boot path catches. So an untiered
//     catalog is not a degraded gateway — it is a gateway that does not start,
//     on every existing production host, since setup-prod.py never overwrites
//     an existing config.yaml by hard rule.
//
//     An entry the operator already tiered by hand is NEVER overwritten (the
//     `backfillInboundProxyService` rule). A tool the shipped catalog does not
//     describe gets `admin` — the operator-only tier — and an inline marker
//     comment naming it, NOT `read`: the migration cannot know an unknown
//     tool's blast radius, and the two ways of guessing fail asymmetrically.
//     Guess `read` and a guest silently gains a tool nobody vetted, invisibly.
//     Guess `admin` and the operator loses one visibly — in a WARN, in a
//     comment in their own file, one word from being corrected.
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

  const result: Schema012MigrationResult = {
    languagePrev: null,
    languageSetToAuto: false,
  };

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
// 0.1.4 → 0.1.5: every catalogued tool declares an impact tier
// ---------------------------------------------------------------------------

const SCHEMA_015_VERSION = "0.1.5";
const MCP_CATALOG_KEY = "mcp_catalog";
const TOOLS_KEY = "tools";
const TOOL_NAME_KEY = "name";
const TOOL_TIER_KEY = "tier";

/** The two tool lists the catalog schema tiers. `exclude` is deliberately
 *  absent: it names what is NOT exposed, so there is nothing for a tier to
 *  gate, and the schema keeps it a bare string list. */
const TIERED_TOOL_LIST_KEYS = ["include", "available"] as const;

/** The tier a tool gets when the shipped catalog has never heard of it.
 *
 *  `admin` is the operator-only tier, so this is the LEAST-privilege answer —
 *  chosen because the failure modes are not symmetric. An over-tiered tool
 *  announces itself the first time the operator's own assistant declines to use
 *  it; an under-tiered one hands a guest something nobody vetted and says
 *  nothing, ever. Both are wrong; only one is discoverable. */
const UNKNOWN_TOOL_TIER: ImpactTier = "admin";

/** Written into the operator's own config beside every guessed tier. The WARN
 *  in the log scrolls away; this does not. */
const UNKNOWN_TOOL_MARKER =
  " TIER GUESSED BY THE 0.1.4 -> 0.1.5 MIGRATION — the shipped catalog does not describe this tool, so it got the operator-only `admin` tier rather than a silent `read`. Re-tier it deliberately: read|write|confirm|admin.";

/** Every tool the SHIPPED catalog curated at this schema step, and the tier it
 *  declared for it.
 *
 *  FROZEN ON PURPOSE, and not read out of the live gateway/config.yaml. A
 *  migration is a historical artifact: it describes one specific transition
 *  between two specific shapes, and it must produce the same output in two
 *  years' time as it does today. Wiring it to the current shipped catalog would
 *  make an old host's migrated tiers depend on which release happened to run
 *  the migration — a later re-tier of, say, `ma_queue` would silently rewrite
 *  the meaning of an upgrade that already happened. */
const SHIPPED_TOOL_TIERS_015: Record<string, Record<string, ImpactTier>> = {
  home_assistant: {
    ha_get_overview: "read",
    ha_get_state: "read",
    ha_search: "read",
    ha_get_history: "read",
    ha_eval_template: "read",
    ha_get_operation_status: "read",
    ha_list_floors_areas: "read",
    ha_get_zone: "read",
    ha_get_camera_image: "read",
    ha_call_service: "confirm",
    ha_bulk_control: "confirm",
    ha_get_todo: "read",
    ha_set_todo_item: "write",
    ha_remove_todo_item: "write",
    ha_config_get_calendar_events: "read",
    ha_config_set_calendar_event: "write",
    ha_config_remove_calendar_event: "confirm",
  },
  gateway: {
    identify_user: "read",
    pause_audio: "read",
    resume_audio: "read",
    update_user_settings: "read",
  },
  music_assistant: {
    ma_search: "read",
    ma_browse: "read",
    ma_list_players: "read",
    ma_volume: "read",
    ma_group: "write",
    ma_playback: "read",
    ma_play_media: "read",
    ma_queue: "write",
    ma_queue_item: "write",
    ma_transfer_queue: "write",
  },
  fetch: { fetch: "read" },
  searxng: { search_web: "read" },
};

/** Tool name → tier across every shipped server, or `null` when two servers
 *  curate the same name and the answer is therefore ambiguous. The fallback for
 *  a server key the operator renamed: a tier describes what the UPSTREAM tool
 *  does, not which local key happens to hold it. */
const SHIPPED_TIER_BY_TOOL_NAME: ReadonlyMap<string, ImpactTier | null> = (() => {
  const index = new Map<string, ImpactTier | null>();
  for (const tools of Object.values(SHIPPED_TOOL_TIERS_015)) {
    for (const [name, tier] of Object.entries(tools)) {
      index.set(name, index.has(name) ? null : tier);
    }
  }
  return index;
})();

/** The tier the shipped catalog declares for one tool, or `undefined` when it
 *  does not describe it. `undefined` is NOT a tier and must never be widened
 *  into one — the same rule `tierOf` states in the catalog schema. */
function shippedTier(server: string, toolName: string): ImpactTier | undefined {
  return SHIPPED_TOOL_TIERS_015[server]?.[toolName] ?? SHIPPED_TIER_BY_TOOL_NAME.get(toolName) ?? undefined;
}

interface ToolTierBackfill {
  /** `<server>.<tool>` for each entry given the tier the shipped catalog declares. */
  tiered: string[];
  /** `<server>.<tool>` for each entry the shipped catalog does not describe. */
  unknown: string[];
}

interface Schema015MigrationResult {
  tieredTools: string[];
  unknownTools: string[];
}

function recordBackfill(result: ToolTierBackfill, server: string, name: string, tier: ImpactTier | undefined): void {
  (tier === undefined ? result.unknown : result.tiered).push(`${server}.${name}`);
}

/** Appends the guessed-tier marker without discarding a comment the operator
 *  wrote on that same line. */
function withUnknownMarker(existing: string | null | undefined): string {
  return existing === null || existing === undefined || existing.trim() === ""
    ? UNKNOWN_TOOL_MARKER
    : `${existing} |${UNKNOWN_TOOL_MARKER}`;
}

/** Moves a scalar's comments and blank-line spacing onto its replacement, so an
 *  operator's annotated list still reads as they wrote it. Each field is copied
 *  only when it is present: `exactOptionalPropertyTypes` makes an explicit
 *  `undefined` a different thing from an absent key, and yaml renders the two
 *  differently. */
function carryTrivia(from: Scalar, to: YAMLMap, comment: string | null | undefined): void {
  if (from.spaceBefore !== undefined) to.spaceBefore = from.spaceBefore;
  if (from.commentBefore !== undefined) to.commentBefore = from.commentBefore;
  if (comment !== undefined) to.comment = comment;
}

/** `- ha_get_state` → `- { name: ha_get_state, tier: read }`. */
function tierScalarItem(doc: Document, scalar: Scalar, server: string, result: ToolTierBackfill): unknown {
  if (typeof scalar.value !== "string") return scalar;

  const name = scalar.value;
  const tier = shippedTier(server, name);
  const node = doc.createNode({
    [TOOL_NAME_KEY]: name,
    [TOOL_TIER_KEY]: tier ?? UNKNOWN_TOOL_TIER,
  }) as YAMLMap;
  node.flow = true;
  carryTrivia(scalar, node, tier === undefined ? withUnknownMarker(scalar.comment) : scalar.comment);

  recordBackfill(result, server, name, tier);
  return node;
}

/** A half-migrated entry — `- name: x` with no `tier:` — is the same problem as
 *  a bare string. An entry that already HAS a tier is the operator's own
 *  decision and is returned untouched, whatever it says. */
function tierMapItem(map: YAMLMap, server: string, result: ToolTierBackfill): unknown {
  if (map.has(TOOL_TIER_KEY)) return map;

  const nameNode = map.get(TOOL_NAME_KEY, true);
  if (!isScalar(nameNode) || typeof nameNode.value !== "string") return map;

  const name = nameNode.value;
  const tier = shippedTier(server, name);
  map.set(TOOL_TIER_KEY, tier ?? UNKNOWN_TOOL_TIER);
  if (tier === undefined) map.comment = withUnknownMarker(map.comment);

  recordBackfill(result, server, name, tier);
  return map;
}

function tierListItem(doc: Document, item: unknown, server: string, result: ToolTierBackfill): unknown {
  if (isScalar(item)) return tierScalarItem(doc, item, server, result);
  if (isMap(item)) return tierMapItem(item, server, result);
  // Anything else (a nested seq, an alias) is not a tool entry. Left alone so
  // the schema names it, rather than mangled into something that parses.
  return item;
}

function tierServerEntry(doc: Document, server: string, entry: unknown, result: ToolTierBackfill): void {
  if (!isMap(entry)) return;

  const toolsNode = (entry as YAMLMap).get(TOOLS_KEY, true);
  if (!isMap(toolsNode)) return;

  for (const listKey of TIERED_TOOL_LIST_KEYS) {
    const listNode = (toolsNode as YAMLMap).get(listKey, true);
    if (!isSeq(listNode)) continue;
    const list = listNode as YAMLSeq;
    list.items = list.items.map((item) => tierListItem(doc, item, server, result));
  }
}

function backfillToolTiers(doc: Document, root: YAMLMap): ToolTierBackfill {
  const result: ToolTierBackfill = { tiered: [], unknown: [] };

  const catalogNode = root.get(MCP_CATALOG_KEY, true);
  if (!isMap(catalogNode)) return result;

  for (const serverPair of (catalogNode as YAMLMap).items) {
    if (!isScalar(serverPair.key)) continue;
    tierServerEntry(doc, String(serverPair.key.value), serverPair.value, result);
  }

  return result;
}

/** Backfills the now-mandatory `tier:` on every catalogued tool.
 *
 *  Unlike the 0.1.3 → 0.1.4 step this one cannot leave the config half-done:
 *  `tier` is required with no default, so a tool this step misses is a config
 *  the zod schema throws on, at `loadStartupConfig`, uncaught — a gateway that
 *  does not boot rather than one that boots wrong. */
export function applySchema015Migration(doc: Document): Schema015MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_015_VERSION) return null; // already migrated
  if (currentVersion !== SCHEMA_014_VERSION) return null;

  const backfill = backfillToolTiers(doc, root);

  // Bumped even for a host with no `mcp_catalog:` at all — the version tracks
  // the SCHEMA, not whether this particular host had anything to rewrite.
  root.set("schema_version", SCHEMA_015_VERSION);
  return { tieredTools: backfill.tiered, unknownTools: backfill.unknown };
}

// ---------------------------------------------------------------------------
// 0.1.5 → 0.1.6: first-class Web/Home/Music cutover
// ---------------------------------------------------------------------------

const SCHEMA_016_VERSION = "0.1.6";
const RETIRED_CORE_SERVERS = ["fetch", "searxng", "home_assistant", "music_assistant"] as const;
const RETIRED_CORE_SERVICES = ["fetch-mcp", "searxng-mcp", "ha-mcp", "ma-mcp"] as const;

interface Schema016MigrationResult {
  removedCatalog: string[];
  removedServices: string[];
}

/** Retire only the four product-owned sidecars. Third-party catalog entries and
 * operator workloads are untouched; running harness-owned containers are
 * removed later by boot reconciliation after these names leave the registry. */
export function applySchema016Migration(doc: Document): Schema016MigrationResult | null {
  const root = doc.contents;
  if (!isMap(root)) return null;
  const versionNode = root.get("schema_version", true);
  const currentVersion = isScalar(versionNode) ? String(versionNode.value) : null;
  if (currentVersion === SCHEMA_016_VERSION) return null;
  if (currentVersion !== SCHEMA_015_VERSION) return null;

  const result: Schema016MigrationResult = {
    removedCatalog: [],
    removedServices: [],
  };
  const catalog = root.get(MCP_CATALOG_KEY, true);
  if (isMap(catalog)) {
    for (const name of RETIRED_CORE_SERVERS) {
      if (catalog.has(name)) {
        catalog.delete(name);
        result.removedCatalog.push(name);
      }
    }
  }
  const services = root.get(MANAGED_SERVICES_KEY, true);
  if (isMap(services)) {
    for (const name of RETIRED_CORE_SERVICES) {
      if (services.has(name)) {
        services.delete(name);
        result.removedServices.push(name);
      }
    }
    const ingress = services.get("ingress-proxy", true);
    if (isMap(ingress)) {
      ingress.set("healthcheck", doc.createNode({ tcp: "127.0.0.1:8090", timeout_ms: 30000 }));
      ingress.set("depends_on", doc.createNode([]));
    }
    const outbound = services.get("outbound-worker", true);
    if (isMap(outbound)) outbound.set("depends_on", doc.createNode(["egress-proxy", "searxng", "ingress-proxy"]));
  }
  root.set("schema_version", SCHEMA_016_VERSION);
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
  const schema014Result = applySchema014Migration(doc);
  const schema015Result = applySchema015Migration(doc);
  const schema016Result = applySchema016Migration(doc);

  if (webToolsResult !== null) {
    noteInfo("migration:web-tools", {
      providerRewritten: webToolsResult.providerRewritten,
      duckduckgoDropped: webToolsResult.duckduckgoDropped,
      searxngAdded: webToolsResult.searxngAdded,
    });
  }

  if (schema011Result !== null) {
    noteInfo("migration:0.1.1", {
      addedPerUserMaxSessions: schema011Result.addedPerUserMaxSessions,
      addedIdleTimeoutMs: schema011Result.addedIdleTimeoutMs,
      removedKeys: schema011Result.removedKeys.join(", "),
    });
  }

  if (schema012Result !== null) {
    noteInfo("migration:0.1.2", {
      languagePrev: schema012Result.languagePrev,
      languageSetToAuto: schema012Result.languageSetToAuto,
    });
  }

  if (schema013Result !== null) {
    noteInfo("migration:0.1.3", {
      replayJournalRetentionMsPrev: schema013Result.replayJournalRetentionMsPrev,
      retentionMs: RETENTION_MS_DEFAULT,
      retentionMsAdded: schema013Result.retentionMsAdded,
      removedKeys: schema013Result.removedKeys.join(", "),
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
    noteInfo("migration:0.1.4", {
      hostPrev: schema014Result.hostPrev,
      hostRewritten: schema014Result.hostRewritten,
      reason: hostReason,
    });
    // Logged separately from the host rewrite so the two halves of the step are
    // both visible: the door that closed AND the door that opened.
    noteInfo("migration:0.1.4:inbound-proxy", {
      serviceEntryAdded: schema014Result.inboundProxyServiceAdded,
      managedServicesBlockCreated: schema014Result.managedServicesBlockCreated,
      certDirBlockAdded: schema014Result.inboundProxyConfigAdded,
      reason: schema014Result.inboundProxyServiceAdded
        ? "the gateway now binds loopback, so the LAN needs inbound-proxy in managed_services — nothing else merges the shipped policy block into a seeded operator config"
        : "an inbound-proxy entry was already present — left exactly as the operator wrote it",
    });
  }

  if (schema016Result !== null) {
    noteInfo("migration:0.1.6:core-tool-cutover", {
      removedCatalog: schema016Result.removedCatalog.join(", "),
      removedServices: schema016Result.removedServices.join(", "),
      reason: "Web, Home, and Music are first-class tools; harness-owned obsolete containers will be reaped safely",
    });
  }

  if (schema015Result !== null) {
    noteInfo("migration:0.1.5", {
      tieredCount: schema015Result.tieredTools.length,
      tieredTools: schema015Result.tieredTools.join(", "),
      reason:
        "every catalogued tool now declares an impact tier — the role gate reads it, and the schema refuses to load a catalog without one",
    });
    // Separate, and a WARN, because this is the half the operator has to act
    // on: a tool the shipped catalog cannot describe kept its NAME but not its
    // reach, and only they know what it actually does.
    if (schema015Result.unknownTools.length > 0) {
      const tools = schema015Result.unknownTools.join(", ");
      noteWarn("migration:0.1.5:unknown-tools", {
        count: schema015Result.unknownTools.length,
        tools,
        tier: UNKNOWN_TOOL_TIER,
        reason:
          "the shipped catalog does not describe these tools, so their blast radius is unknown — each got the operator-only `admin` tier rather than a silent `read`, and each is marked in config.yaml for a deliberate re-tier",
      });
      // A BARE CONSOLE WRITE, deliberately, and the ONE in this module.
      // Everything above is buffered for `flushMigrationLog`, which only runs
      // if boot gets that far — and the very next thing after this migration is
      // the schema parse, which THROWS on a config it still cannot accept. That
      // is precisely the boot where an operator most needs to know a tool was
      // re-tiered, and precisely the boot where the buffer is never flushed.
      // Under launchd this lands in stderr.log (see the prod plist).
      //
      // ON A HEALTHY BOOT THIS APPEARS TWICE on stderr — once here, once when
      // the flush replays it through the logger's console sink. Accepted, and
      // not a bug to go fixing later: de-duplicating means predicting whether
      // the flush will happen, which is exactly the thing that cannot be known
      // from here. The daily log file still carries it exactly once.
      console.warn(
        `[sentient.config.migration] migration:0.1.5:unknown-tools tier=${UNKNOWN_TOOL_TIER} tools=${tools}`,
      );
    }
  }

  return (
    webToolsResult !== null ||
    schema011Result !== null ||
    schema012Result !== null ||
    schema013Result !== null ||
    schema014Result !== null ||
    schema015Result !== null ||
    schema016Result !== null
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
    noteWarn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    noteWarn("parse-failed", {
      path: configPath,
      reason: (e as Error).message,
    });
    return;
  }

  const changed = applyAllMigrations(doc);
  if (!changed) return;

  const updated = doc.toString();
  try {
    writeFileSync(configPath, updated, { encoding: "utf-8" });
  } catch (e: unknown) {
    noteWarn("write-failed", {
      path: configPath,
      reason: (e as Error).message,
    });
    return;
  }

  noteInfo("migrated", { path: configPath });
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
    noteWarn("read-failed", { path: configPath, reason: (e as Error).message });
    return;
  }

  let doc: Document;
  try {
    doc = parseDocument(raw);
  } catch (e: unknown) {
    noteWarn("parse-failed", {
      path: configPath,
      reason: (e as Error).message,
    });
    return;
  }

  const changed = applyAllMigrations(doc);
  if (!changed) return;

  const updated = doc.toString();
  try {
    await writeFileAtomic(configPath, updated);
  } catch (e: unknown) {
    noteWarn("write-failed", {
      path: configPath,
      reason: (e as Error).message,
    });
    return;
  }

  noteInfo("migrated", { path: configPath });
}
