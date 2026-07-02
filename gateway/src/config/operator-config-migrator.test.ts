import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateOperatorConfigYaml, migrateOperatorConfigYamlSync } from "./operator-config-migrator.ts";

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
schema_version: "0.1.2"
hermes:
  web_tools:
    provider: searxng
    searxng:
      enabled: true
`;

const NO_WEB_TOOLS_YAML = `\
schema_version: "0.1.2"
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

  it("bumps schema_version to 0.1.1 on a 0.1.0 host config", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).toContain('schema_version: "0.1.2"');
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

  it("adds idle_timeout_ms: 900000 when missing", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010);
    migrateOperatorConfigYamlSync(p);
    expect(readTmp(p)).toContain("idle_timeout_ms: 900000");
  });

  it("does NOT overwrite per_user_max_sessions if already present", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010_HAS_NEW_FIELDS);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("per_user_max_sessions: 10");
    expect(result).not.toContain("per_user_max_sessions: 40");
  });

  it("does NOT overwrite idle_timeout_ms if already present", () => {
    const p = writeTmp(dir, HOST_CONFIG_v010_HAS_NEW_FIELDS);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("idle_timeout_ms: 1800000");
    expect(result).not.toContain("idle_timeout_ms: 900000");
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

  it("is a no-op when schema_version is already 0.1.2", () => {
    const p = writeTmp(dir, ALREADY_MIGRATED_YAML);
    const statBefore = statSync(p);
    migrateOperatorConfigYamlSync(p);
    const statAfter = statSync(p);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });

  it("migrates 0.1.1 stt.language en -> auto and bumps to 0.1.2", () => {
    const p = writeTmp(dir, V011_STT_EN_YAML);
    migrateOperatorConfigYamlSync(p);
    const result = readTmp(p);
    expect(result).toContain("language: auto");
    expect(result).not.toMatch(/language:\s*en\b/);
    expect(result).toContain('schema_version: "0.1.2"');
  });

  it("is a no-op when stt.language already auto at 0.1.2", () => {
    const yaml = `\
schema_version: "0.1.2"
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
