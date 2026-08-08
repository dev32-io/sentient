import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCatalogSchema } from "@sentient/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  applySchema014Migration,
  applySchema015Migration,
  migrateOperatorConfigYaml,
  migrateOperatorConfigYamlSync,
} from "./operator-config-migrator.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A realistic 0.1.0 host config with ALL the dead keys that must be removed.
const HOST_CONFIG_v010 = `\
schema_version: "0.1.0"
port: 8888
host: 0.0.0.0
max_sessions: 100
auth_timeout_ms: 5000
session_persist_ms: 120000

session:
  inactivity_timeout_ms: 300000
  inactivity_check_interval_ms: 30000
  ws_idle_timeout_ms: 255000
  retention_ttl_ms: 1800000
  replay_buffer_max_bytes: 16777216
  tts_drain_grace_ms: 2000

hermes:
  worker:
    container_name: sentient-hermes
    url_template: "http://sentient-hermes:{port}"
    port_base: 8650
  defaults:
    max_output_tokens: 512
    request_timeout_ms: 60000
    idempotency_window_s: 300
  resource_management:
    mode: always_on
    max_concurrent: 3
    idle_pause_after_ms: 900000
    idle_stop_after_ms: 3600000
    ram_pressure_threshold_pct: 85
    cold_start_filler_text: "one sec..."
  web_tools:
    provider: searxng
    searxng:
      enabled: true
`;

// A 0.1.0 config that already has per_user_max_sessions + idle_timeout_ms
// (e.g. manually added) — they must NOT be overwritten.
const HOST_CONFIG_v010_HAS_NEW_FIELDS = `\
schema_version: "0.1.0"
session:
  ws_idle_timeout_ms: 255000
  retention_ttl_ms: 1800000
  replay_buffer_max_bytes: 16777216
  per_user_max_sessions: 10
  idle_timeout_ms: 1800000
hermes:
  worker:
    container_name: sentient-hermes
    url_template: "http://sentient-hermes:{port}"
    port_base: 8650
  web_tools:
    provider: searxng
    searxng:
      enabled: true
`;

const LEGACY_DDG_YAML = `\
hermes:
  worker:
    container_name: sentient-hermes
    url_template: "http://sentient-hermes:{port}"
    port_base: 8650

  web_tools:
    # or "searxng" post-Phase-3
    provider: duckduckgo
    duckduckgo:
      enabled: true

  home_assistant_observer:
    enabled: true
`;

const ALREADY_MIGRATED_YAML = `\
schema_version: "0.1.5"
hermes:
  web_tools:
    provider: searxng
    searxng:
      enabled: true
`;

const NO_WEB_TOOLS_YAML = `\
schema_version: "0.1.5"
hermes:
  worker:
    container_name: sentient-hermes
    url_template: "http://sentient-hermes:{port}"
    port_base: 8650
`;

const EXTENSIVE_YAML = `\
port: 9000
host: "0.0.0.0"
max_sessions: 10

hermes:
  worker:
    container_name: sentient-hermes
    url_template: "http://sentient-hermes:{port}"
    port_base: 8650
  defaults:
    max_output_tokens: 512
  web_tools:
    provider: duckduckgo
    duckduckgo:
      enabled: true
  home_assistant_observer:
    enabled: false

logging:
  level: info
  retention_days: 7
  level_overrides: {}
`;

// A 0.1.1 config carrying the old stt.language: en — the 0.1.2 migration must
// flip it to auto and bump the version.
const V011_STT_EN_YAML = `\
schema_version: "0.1.1"
stt:
  provider: local-stt
  url: ws://stt-service:8766
  language: en
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTmp(dir: string, content: string): string {
  const p = join(dir, "config.yaml");
  writeFileSync(p, content, "utf-8");
  return p;
}

function readTmp(p: string): string {
  return readFileSync(p, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests — sync variant
// ---------------------------------------------------------------------------

describe("migrateOperatorConfigYamlSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites legacy provider duckduckgo to searxng", () => {
    const p = writeTmp(dir, LEGACY_DDG_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("provider: searxng");
    expect(result).not.toContain("duckduckgo");
    expect(result).toContain("searxng:");
    expect(result).toContain("enabled: true");
  });

  it("drops the duckduckgo sub-block after migration", () => {
    const p = writeTmp(dir, LEGACY_DDG_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).not.toMatch(/duckduckgo/);
  });

  it("adds searxng.enabled: true when missing", () => {
    const noSearxngYaml = `\
hermes:
  web_tools:
    provider: duckduckgo
`;
    const p = writeTmp(dir, noSearxngYaml);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("provider: searxng");
    expect(result).toContain("enabled: true");
  });

  it("is a no-op when provider is already searxng", () => {
    const p = writeTmp(dir, ALREADY_MIGRATED_YAML);
    const statBefore = statSync(p);
    migrateOperatorConfigYamlSync(p);
    const statAfter = statSync(p);
    // File must not have been written
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(readTmp(p)).toBe(ALREADY_MIGRATED_YAML);
  });

  it("is a no-op when no web_tools block exists", () => {
    const p = writeTmp(dir, NO_WEB_TOOLS_YAML);
    const statBefore = statSync(p);
    migrateOperatorConfigYamlSync(p);
    const statAfter = statSync(p);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("preserves unrelated keys after migration", () => {
    const p = writeTmp(dir, EXTENSIVE_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    // Unrelated top-level keys must survive
    expect(result).toContain("port: 9000");
    expect(result).toContain("max_sessions: 10");
    expect(result).toContain("container_name: sentient-hermes");
    expect(result).toContain("max_output_tokens: 512");
    expect(result).toContain("home_assistant_observer:");
    expect(result).toContain("retention_days: 7");
    // Migration applied
    expect(result).toContain("provider: searxng");
    expect(result).not.toContain("duckduckgo");
  });

  it("skips gracefully when file is missing — no throw", () => {
    const missing = join(dir, "nonexistent.yaml");
    expect(() => migrateOperatorConfigYamlSync(missing)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — async variant
// ---------------------------------------------------------------------------

describe("migrateOperatorConfigYaml (async)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-async-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rewrites legacy duckduckgo to searxng atomically", async () => {
    const p = writeTmp(dir, LEGACY_DDG_YAML);
    await migrateOperatorConfigYaml(p);
    const result = readTmp(p);
    expect(result).toContain("provider: searxng");
    expect(result).not.toContain("duckduckgo");
    // No leftover tmp file
    expect(() => statSync(`${p}.tmp`)).toThrow();
  });

  it("is a no-op when already migrated (async)", async () => {
    const p = writeTmp(dir, ALREADY_MIGRATED_YAML);
    const statBefore = statSync(p);
    await migrateOperatorConfigYaml(p);
    const statAfter = statSync(p);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("skips gracefully when file is missing (async) — no throw", async () => {
    const missing = join(dir, "nonexistent.yaml");
    await expect(migrateOperatorConfigYaml(missing)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — schema 0.1.0 → 0.1.1 migration
// ---------------------------------------------------------------------------

describe("migrateOperatorConfigYamlSync — schema 0.1.0 → 0.1.1", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-011-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the whole chain in one pass, leaving schema_version at the head", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).toContain('schema_version: "0.1.5"');
  });

  it("removes all dead session keys", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).not.toContain("inactivity_timeout_ms");
    expect(result).not.toContain("inactivity_check_interval_ms");
    expect(result).not.toContain("retention_ttl_ms");
  });

  it("removes session_persist_ms from root", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).not.toContain("session_persist_ms");
  });

  it("removes dead hermes.defaults keys", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).not.toContain("request_timeout_ms");
    expect(result).not.toContain("idempotency_window_s");
  });

  it("removes hermes.resource_management block", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).not.toContain("resource_management");
    expect(result).not.toContain("idle_pause_after_ms");
    expect(result).not.toContain("idle_stop_after_ms");
    expect(result).not.toContain("cold_start_filler_text");
  });

  it("adds per_user_max_sessions: 40 when missing", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).toContain("per_user_max_sessions: 40");
  });

  it("leaves no idle_timeout_ms behind — 0.1.1 added it, 0.1.3 removed it as dead", () => {
    // The key was never in `sessionConfigSchema`, so zod stripped it and
    // nothing ever read it. It is the cautionary case behind the
    // `replay_journal_retention_ms` -> `retention_ms` rename.
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    // Anchored: `ws_idle_timeout_ms` is a LIVE key that contains this substring.
    expect(readTmp(p)).not.toMatch(/^\s*idle_timeout_ms:/m);
  });

  it("does NOT overwrite per_user_max_sessions if already present", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010_HAS_NEW_FIELDS);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("per_user_max_sessions: 10");
    expect(result).not.toContain("per_user_max_sessions: 40");
  });

  it("removes a hand-tuned idle_timeout_ms too — the key had no reader to honour", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010_HAS_NEW_FIELDS);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).not.toMatch(/^\s*idle_timeout_ms:/m);
  });

  it("preserves unrelated keys (port, auth_timeout_ms, session.ws_idle_timeout_ms, etc.)", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("port: 8888");
    expect(result).toContain("auth_timeout_ms: 5000");
    expect(result).toContain("ws_idle_timeout_ms: 255000");
    expect(result).toContain("replay_buffer_max_bytes: 16777216");
    expect(result).toContain("max_output_tokens: 512");
  });

  it("is a no-op when schema_version is already at the head", () => {
    const p = writeTmp(dir, ALREADY_MIGRATED_YAML);
    const statBefore = statSync(p);
    migrateOperatorConfigYamlSync(p);
    const statAfter = statSync(p);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("migrates 0.1.1 stt.language en -> auto", () => {
    const p = writeTmp(dir, V011_STT_EN_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("language: auto");
    expect(result).not.toMatch(/language:\s*en\b/);
  });

  it("is a no-op when stt.language is already auto at the head version", () => {
    const yaml = `\
schema_version: "0.1.5"
stt:
  provider: local-stt
  language: auto
`;
    const p = writeTmp(dir, yaml);
    const statBefore = statSync(p);
    migrateOperatorConfigYamlSync(p);
    expect(statSync(p).mtimeMs).toBe(statBefore.mtimeMs);
  });
});

// ---------------------------------------------------------------------------
// Tests — schema 0.1.2 → 0.1.3 (derived retention: the key's JOB changed)
// ---------------------------------------------------------------------------

const V012_TUNED_RETENTION_YAML = `\
schema_version: "0.1.2"
session:
  ws_idle_timeout_ms: 255000
  replay_journal_max_bytes: 16777216
  replay_journal_retention_ms: 60000
`;

describe("migrateOperatorConfigYamlSync — schema 0.1.2 → 0.1.3", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-013-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames replay_journal_retention_ms to retention_ms", () => {
    const p = writeTmp(dir, V012_TUNED_RETENTION_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).not.toContain("replay_journal_retention_ms");
    expect(result).toContain("retention_ms: 900000");
    expect(result).toContain('schema_version: "0.1.5"');
  });

  it("does NOT carry the old value across the rename", () => {
    // `replay_journal_retention_ms` bounded JOURNAL BYTES after the last window
    // left; `retention_ms` governs how long a whole SESSION — its runtime, its
    // store handle, its running background tasks — stays resident. A 60 s value
    // tuned for the first would silently make the second orphan work.
    const p = writeTmp(dir, V012_TUNED_RETENTION_YAML);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).not.toContain("60000");
  });

  it("leaves unrelated session keys alone", () => {
    const p = writeTmp(dir, V012_TUNED_RETENTION_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("ws_idle_timeout_ms: 255000");
    expect(result).toContain("replay_journal_max_bytes: 16777216");
  });
});

// ---------------------------------------------------------------------------
// Tests — schema 0.1.3 → 0.1.4 (gateway binds loopback)
// ---------------------------------------------------------------------------

// A realistic seeded 0.1.3 operator config: a managed_services block that
// predates inbound-proxy, which is exactly the shape every existing install has.
const V013_NO_INBOUND_PROXY_YAML = `\
schema_version: "0.1.3"
port: 8888
host: 0.0.0.0

tls:
  enabled: true
  hostnames:
    - "localhost"

managed_services:
  egress-proxy:
    template: egress-proxy.yaml
    allowed_images: ["kalaksi/tinyproxy:latest"]
    networks: ["sentient-internal", "sentient-external"]
    healthcheck:
      noop: true
    depends_on: []
    optional: false

  ha-mcp:
    template: ha-mcp.yaml
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"]
    networks: ["sentient-internal", "sentient-external"]
    healthcheck:
      tcp: "127.0.0.1:8086"
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: true
`;

function inboundProxyEntry(doc: ReturnType<typeof parseDocument>): Record<string, unknown> {
  const js = doc.toJS() as { managed_services?: Record<string, Record<string, unknown>> };
  return js.managed_services?.["inbound-proxy"] ?? {};
}

describe("0.1.3 -> 0.1.4: gateway binds loopback", () => {
  it("rewrites host 0.0.0.0 to 127.0.0.1 and bumps the version", () => {
    const doc = parseDocument(['schema_version: "0.1.3"', "port: 8888", "host: 0.0.0.0"].join("\n"));

    const result = applySchema014Migration(doc);

    expect(result).not.toBeNull();
    expect(result?.hostPrev).toBe("0.0.0.0");
    expect(doc.get("host")).toBe("127.0.0.1");
    expect(doc.get("schema_version")).toBe("0.1.4");
  });

  it("leaves a deliberately-customised host alone but still bumps the version", () => {
    const doc = parseDocument(['schema_version: "0.1.3"', "host: 192.168.0.5"].join("\n"));

    const result = applySchema014Migration(doc);

    expect(result?.hostRewritten).toBe(false);
    expect(doc.get("host")).toBe("192.168.0.5");
    expect(doc.get("schema_version")).toBe("0.1.4");
  });

  it("is a no-op on a config that is not at 0.1.3", () => {
    const doc = parseDocument(['schema_version: "0.1.2"', "host: 0.0.0.0"].join("\n"));

    expect(applySchema014Migration(doc)).toBeNull();
    expect(doc.get("host")).toBe("0.0.0.0");
  });

  // INVARIANT: the bind change and the inbound-proxy backfill are ONE step.
  // Nothing else merges the shipped policy block into a seeded operator config,
  // so a loopback bind without this entry leaves the host reachable from nowhere
  // but itself — silently, and un-rollback-able, since a rolled-back binary
  // still reads the migrated config.
  it("backfills the inbound-proxy policy entry alongside the host rewrite", () => {
    const doc = parseDocument(V013_NO_INBOUND_PROXY_YAML);

    const result = applySchema014Migration(doc);

    expect(result?.inboundProxyServiceAdded).toBe(true);
    expect(result?.managedServicesBlockCreated).toBe(false);
    expect(doc.get("host")).toBe("127.0.0.1");
    expect(inboundProxyEntry(doc)).toEqual({
      template: "inbound-proxy.yaml",
      allowed_images: ["sentient/inbound-proxy:local"],
      networks: ["sentient-edge"],
      infra: true,
      public_ports: true,
      healthcheck: { tcp: "127.0.0.1:443", timeout_ms: 30000 },
      depends_on: [],
      optional: false,
    });
  });

  it("adds the inbound_proxy block with a null cert_dir", () => {
    const doc = parseDocument(V013_NO_INBOUND_PROXY_YAML);

    const result = applySchema014Migration(doc);

    expect(result?.inboundProxyConfigAdded).toBe(true);
    expect((doc.toJS() as { inbound_proxy: { cert_dir: string | null } }).inbound_proxy).toEqual({ cert_dir: null });
  });

  it("creates the managed_services block when the host has none", () => {
    const doc = parseDocument(['schema_version: "0.1.3"', "host: 0.0.0.0"].join("\n"));

    const result = applySchema014Migration(doc);

    expect(result?.managedServicesBlockCreated).toBe(true);
    expect(result?.inboundProxyServiceAdded).toBe(true);
    expect(inboundProxyEntry(doc).infra).toBe(true);
  });

  it("backfills the entry even when the host was customised and left alone", () => {
    const doc = parseDocument(V013_NO_INBOUND_PROXY_YAML.replace("host: 0.0.0.0", "host: 192.168.0.5"));

    const result = applySchema014Migration(doc);

    expect(result?.hostRewritten).toBe(false);
    expect(result?.inboundProxyServiceAdded).toBe(true);
  });

  it("leaves an operator's hand-written inbound-proxy entry exactly as written", () => {
    const handWritten = V013_NO_INBOUND_PROXY_YAML.concat(`\
  inbound-proxy:
    template: inbound-proxy.yaml
    allowed_images: ["sentient/inbound-proxy:local"]
    networks: ["sentient-edge"]
    infra: true
    public_ports: true
    healthcheck:
      tcp: "127.0.0.1:8443"
      timeout_ms: 5000
    depends_on: []
    optional: true
`);
    const doc = parseDocument(handWritten);

    const result = applySchema014Migration(doc);

    expect(result?.inboundProxyServiceAdded).toBe(false);
    expect(inboundProxyEntry(doc).healthcheck).toEqual({ tcp: "127.0.0.1:8443", timeout_ms: 5000 });
    expect(inboundProxyEntry(doc).optional).toBe(true);
  });
});

describe("0.1.4 backfill on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-014-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the entry once, no matter how many times the chain runs", () => {
    const p = writeTmp(dir, V013_NO_INBOUND_PROXY_YAML);

    migrateOperatorConfigYamlSync(p);
    migrateOperatorConfigYamlSync(p);
    migrateOperatorConfigYamlSync(p);

    const result = readTmp(p);
    expect(result.split("\n").filter((l) => /^ {2}inbound-proxy:$/.test(l))).toHaveLength(1);
    expect(result.split("\n").filter((l) => /^inbound_proxy:$/.test(l))).toHaveLength(1);
    expect(result).toContain("host: 127.0.0.1");
    expect(result).toContain('schema_version: "0.1.5"');
  });

  it("keeps every pre-existing service entry", () => {
    const p = writeTmp(dir, V013_NO_INBOUND_PROXY_YAML);

    migrateOperatorConfigYamlSync(p);

    const services = Object.keys(
      (parseDocument(readTmp(p)).toJS() as { managed_services: Record<string, unknown> }).managed_services,
    );
    expect(services).toEqual(["egress-proxy", "ha-mcp", "inbound-proxy"]);
  });
});

// ---------------------------------------------------------------------------
// Tests — schema 0.1.4 → 0.1.5 (every catalogued tool declares an impact tier)
// ---------------------------------------------------------------------------

// The mcp_catalog EXACTLY as a production host holds it at 0.1.4 — every tool a
// bare string, because `tier:` did not exist yet. Reproduced verbatim (comments
// trimmed) from `git show adb017dc:gateway/config.yaml`, which is the last
// commit before the field became mandatory. If this fixture ever passes
// `mcpCatalogSchema` WITHOUT the migration, the field stopped being required
// and this whole step is dead.
const V014_UNTIERED_CATALOG_YAML = `\
schema_version: "0.1.4"
port: 8888
host: 127.0.0.1

mcp_catalog:
  home_assistant:
    transport: http
    url: http://127.0.0.1:8086/mcp
    timeout: 30
    connect_timeout: 5
    description: Home Assistant smart-home control via ha-mcp sidecar.
    tools:
      include:
        # query / state
        - ha_get_overview
        - ha_get_state
        - ha_search
        - ha_get_history
        - ha_eval_template
        - ha_get_operation_status
        # spatial
        - ha_list_floors_areas
        - ha_get_zone
        - ha_get_camera_image
        # action
        - ha_call_service
        - ha_bulk_control
        # todos / shopping list
        - ha_get_todo
        - ha_set_todo_item
        - ha_remove_todo_item
        # calendar
        - ha_config_get_calendar_events
        - ha_config_set_calendar_event
        - ha_config_remove_calendar_event

  gateway:
    transport: stdio
    command: nc
    args: ["-U", "/tmp/mcp-{{userId}}.sock"]
    description: Sentient gateway tools (identify, audio, channel).
    tools:
      include:
        - identify_user
        - pause_audio
        - resume_audio
        - update_user_settings

  music_assistant:
    transport: http
    url: http://127.0.0.1:8668/mcp
    timeout: 30
    connect_timeout: 5
    description: Music Assistant playback control.
    tools:
      include:
        - ma_search
        - ma_browse
        - ma_list_players
        - ma_volume
        - ma_group
        - ma_playback
        - ma_play_media
        - ma_queue
        - ma_queue_item
        - ma_transfer_queue

  fetch:
    transport: http
    url: http://127.0.0.1:8088/mcp
    description: Fetch URL contents as markdown.
    tools:
      include:
        - fetch

  searxng:
    transport: http
    url: http://127.0.0.1:8087/mcp
    description: SearXNG metasearch web search.
    tools:
      include:
        - search_web
`;

function catalogOf(yaml: string): unknown {
  return (parseDocument(yaml).toJS() as { mcp_catalog: unknown }).mcp_catalog;
}

function tierIn(yaml: string, server: string, tool: string): string | undefined {
  const catalog = catalogOf(yaml) as Record<string, { tools: { include: { name: string; tier: string }[] } }>;
  return catalog[server]?.tools.include.find((entry) => entry.name === tool)?.tier;
}

/** One server's `include` / `available` list, as plain JS. */
function toolListIn(doc: ReturnType<typeof parseDocument>, server: string, key: "include" | "available"): unknown[] {
  const js = doc.toJS() as { mcp_catalog: Record<string, { tools: Record<string, unknown[]> }> };
  return js.mcp_catalog[server]?.tools[key] ?? [];
}

describe("0.1.4 -> 0.1.5: every catalogued tool declares an impact tier", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "op-config-migrator-015-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // THE merge-blocking case. `mcp_catalog` is parsed by `schema.parse`, which
  // throws, and nothing on the boot path catches it — so an untiered catalog is
  // not a degraded gateway, it is a gateway that does not start.
  it("refuses to parse a real pre-change catalog before the migration runs", () => {
    // A bare string is not a half-filled tool entry — it is the WRONG SHAPE, so
    // zod rejects it before it ever reaches the "declares no impact tier" arm.
    expect(() => mcpCatalogSchema.parse(catalogOf(V014_UNTIERED_CATALOG_YAML))).toThrow(/"include"/);
  });

  it("makes a real pre-change catalog parse", () => {
    const p = writeTmp(dir, V014_UNTIERED_CATALOG_YAML);

    migrateOperatorConfigYamlSync(p);

    expect(() => mcpCatalogSchema.parse(catalogOf(readTmp(p)))).not.toThrow();
    expect(readTmp(p)).toContain('schema_version: "0.1.5"');
  });

  it("backfills each tool the tier the shipped catalog declares for it", () => {
    const p = writeTmp(dir, V014_UNTIERED_CATALOG_YAML);

    migrateOperatorConfigYamlSync(p);
    const migrated = readTmp(p);

    // One per tier, so a table that collapsed to a single value cannot pass.
    expect(tierIn(migrated, "home_assistant", "ha_get_state")).toBe("read");
    expect(tierIn(migrated, "home_assistant", "ha_set_todo_item")).toBe("write");
    expect(tierIn(migrated, "home_assistant", "ha_call_service")).toBe("confirm");
    expect(tierIn(migrated, "music_assistant", "ma_transfer_queue")).toBe("write");
    expect(tierIn(migrated, "music_assistant", "ma_playback")).toBe("read");
    expect(tierIn(migrated, "searxng", "search_web")).toBe("read");
  });

  // The whole point of tiering: a generic dispatcher that reaches locks and
  // alarms must not come back as a tool a child can call. Backfilling `read`
  // everywhere would pass every other assertion in this file.
  it("does not widen a confirm-tier tool into a read", () => {
    const p = writeTmp(dir, V014_UNTIERED_CATALOG_YAML);

    migrateOperatorConfigYamlSync(p);
    const migrated = readTmp(p);

    // POSITIVE, not `not.toBe("read")`. `tierIn` returns `undefined` for an
    // entry it cannot find, so the absence form passes for a tool the migration
    // dropped entirely — it could never tell "correctly tiered" from "gone".
    expect(tierIn(migrated, "home_assistant", "ha_bulk_control")).toBe("confirm");
    expect(tierIn(migrated, "home_assistant", "ha_config_remove_calendar_event")).toBe("confirm");
  });

  it("keeps the operator's own comments on the tool list", () => {
    const p = writeTmp(dir, V014_UNTIERED_CATALOG_YAML);

    migrateOperatorConfigYamlSync(p);
    const migrated = readTmp(p);

    expect(migrated).toContain("# query / state");
    expect(migrated).toContain("# todos / shopping list");
  });

  // The `backfillInboundProxyService` rule, applied to a list: an operator who
  // already tiered a tool by hand has made a decision, and a migration that
  // silently overrides it is worse than one that does nothing.
  it("leaves a tier the operator wrote themselves exactly as written", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.4"',
        "mcp_catalog:",
        "  home_assistant:",
        "    tools:",
        "      include:",
        "        - { name: ha_call_service, tier: write }",
        "        - ha_get_state",
      ].join("\n"),
    );

    const result = applySchema015Migration(doc);

    expect(result?.tieredTools).toEqual(["home_assistant.ha_get_state"]);
    expect(toolListIn(doc, "home_assistant", "include")).toEqual([
      { name: "ha_call_service", tier: "write" },
      { name: "ha_get_state", tier: "read" },
    ]);
  });

  // A half-migrated entry — the operator added `name:` but no `tier:` — is the
  // same problem as a bare string and gets the same answer.
  it("tiers a map entry that names a tool but declares no tier", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.4"',
        "mcp_catalog:",
        "  searxng:",
        "    tools:",
        "      include:",
        "        - name: search_web",
      ].join("\n"),
    );

    applySchema015Migration(doc);

    expect(toolListIn(doc, "searxng", "include")).toEqual([{ name: "search_web", tier: "read" }]);
  });

  // A tool the shipped catalog never described has an UNKNOWN blast radius.
  // `read` would hand it to a guest; the migration cannot know that is safe, so
  // it goes to the one tier only the operator reaches and says so in the file.
  it("gives an operator-added tool the shipped catalog does not know the admin tier", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.4"',
        "mcp_catalog:",
        "  my_own_mcp:",
        "    tools:",
        "      include:",
        "        - wipe_the_nas",
      ].join("\n"),
    );

    const result = applySchema015Migration(doc);

    expect(result?.unknownTools).toEqual(["my_own_mcp.wipe_the_nas"]);
    expect(tierIn(doc.toString(), "my_own_mcp", "wipe_the_nas")).toBe("admin");
    expect(doc.toString()).toContain("shipped catalog does not describe");
  });

  // The tier belongs to the upstream tool, not to the local key that holds it.
  it("still finds a tier for a tool under a server key the operator renamed", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.4"',
        "mcp_catalog:",
        "  house:",
        "    tools:",
        "      include:",
        "        - ha_call_service",
      ].join("\n"),
    );

    const result = applySchema015Migration(doc);

    expect(result?.unknownTools).toEqual([]);
    expect(tierIn(doc.toString(), "house", "ha_call_service")).toBe("confirm");
  });

  it("tiers the operator-declared `available` universe as well as `include`", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.4"',
        "mcp_catalog:",
        "  searxng:",
        "    tools:",
        "      available:",
        "        - search_web",
        "      include:",
        "        - search_web",
      ].join("\n"),
    );

    applySchema015Migration(doc);

    expect(toolListIn(doc, "searxng", "available")).toEqual([{ name: "search_web", tier: "read" }]);
  });

  it("writes one tier per tool no matter how many times the chain runs", () => {
    const p = writeTmp(dir, V014_UNTIERED_CATALOG_YAML);

    migrateOperatorConfigYamlSync(p);
    migrateOperatorConfigYamlSync(p);
    migrateOperatorConfigYamlSync(p);

    const migrated = readTmp(p);
    expect(migrated.match(/name: search_web/g)).toHaveLength(1);
    expect(() => mcpCatalogSchema.parse(catalogOf(migrated))).not.toThrow();
  });

  it("is a no-op on a config that is not at 0.1.4", () => {
    const doc = parseDocument(
      [
        'schema_version: "0.1.3"',
        "mcp_catalog:",
        "  searxng:",
        "    tools:",
        "      include:",
        "        - search_web",
      ].join("\n"),
    );

    expect(applySchema015Migration(doc)).toBeNull();
    expect(doc.toString()).toContain("- search_web");
  });

  it("bumps a host that has no mcp_catalog at all", () => {
    const doc = parseDocument(['schema_version: "0.1.4"', "port: 8888"].join("\n"));

    const result = applySchema015Migration(doc);

    expect(result).not.toBeNull();
    expect(doc.get("schema_version")).toBe("0.1.5");
  });
});
