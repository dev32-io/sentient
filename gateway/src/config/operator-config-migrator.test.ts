import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateOperatorConfigYaml, migrateOperatorConfigYamlSync } from "./operator-config-migrator.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
hermes:
  web_tools:
    provider: searxng
    searxng:
      enabled: true
`;

const NO_WEB_TOOLS_YAML = `\
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
    request_timeout_ms: 60000
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
