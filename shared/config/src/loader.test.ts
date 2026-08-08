import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { gatewayConfigSchema } from "./schema.ts";
import { loadConfig, resolveEnvVars, resolveEnvVarsDeep } from "./loader.ts";
import type { GatewayConfig } from "./schema.ts";

// Repo template config — the same file every fresh operator install ships
// with. Fixture helper for tests that need to parse it (optionally with some
// keys stripped, to simulate an operator config that predates a section).
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_CONFIG_PATH = join(THIS_DIR, "..", "..", "..", "gateway", "config.yaml");

/** Delete a dot-path key (e.g. "orchestrator.skills") from a parsed object,
 *  in place. No-op if any segment along the path is missing. */
function stripKeyPath(obj: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (!leaf) return;
  let cursor: unknown = obj;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor !== null && typeof cursor === "object") {
    delete (cursor as Record<string, unknown>)[leaf];
  }
}

/** Load + validate the repo's checked-in gateway/config.yaml, optionally
 *  stripping dot-path keys first to simulate a pre-upgrade operator config
 *  that predates a given section. Mirrors `loadConfig`'s own
 *  parse -> resolve-env-vars -> schema.parse pipeline so the fixture exercises
 *  the same path as a real boot. */
function loadConfigFixture(options?: { stripKeys?: string[] }): GatewayConfig {
  const raw = parseYaml(readFileSync(REPO_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
  for (const key of options?.stripKeys ?? []) {
    stripKeyPath(raw, key);
  }
  const resolved = resolveEnvVarsDeep(raw);
  return gatewayConfigSchema.parse(resolved) as GatewayConfig;
}

describe("resolveEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "test_value";
    process.env.TEST_PORT = "3000";
  });

  afterEach(() => {
    process.env.TEST_KEY = undefined;
    process.env.TEST_PORT = undefined;
  });

  it("replaces single env var", () => {
    expect(resolveEnvVars("${TEST_KEY}")).toBe("test_value");
  });

  it("replaces multiple env vars in one string", () => {
    expect(resolveEnvVars("${TEST_KEY}:${TEST_PORT}")).toBe("test_value:3000");
  });

  it("returns string unchanged when no vars present", () => {
    expect(resolveEnvVars("plain string")).toBe("plain string");
  });

  it("resolves undefined env var to empty string", () => {
    expect(resolveEnvVars("${UNDEFINED_VAR}")).toBe("");
  });
});

describe("resolveEnvVarsDeep", () => {
  beforeEach(() => {
    process.env.API_KEY = "sk-test";
  });

  afterEach(() => {
    process.env.API_KEY = undefined;
  });

  it("resolves nested objects", () => {
    const input = { provider: { api_key: "${API_KEY}", model: "nova-3" } };
    const result = resolveEnvVarsDeep(input) as { provider: { api_key: string; model: string } };

    expect(result.provider.api_key).toBe("sk-test");
    expect(result.provider.model).toBe("nova-3");
  });

  it("resolves arrays", () => {
    const input = ["${API_KEY}", "plain"];
    const result = resolveEnvVarsDeep(input);

    expect(result).toEqual(["sk-test", "plain"]);
  });

  it("passes through numbers and booleans", () => {
    expect(resolveEnvVarsDeep(42)).toBe(42);
    expect(resolveEnvVarsDeep(true)).toBe(true);
    expect(resolveEnvVarsDeep(null)).toBe(null);
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = "sk-live";
  });

  afterEach(() => {
    process.env.TEST_API_KEY = undefined;
  });

  it("loads and validates YAML with env vars", () => {
    const yaml = `
port: 3000
api_key: \${TEST_API_KEY}
`;
    const schema = z.object({
      port: z.number(),
      api_key: z.string(),
    });

    const config = loadConfig(yaml, schema);

    expect(config.port).toBe(3000);
    expect(config.api_key).toBe("sk-live");
  });

  it("throws on schema validation failure", () => {
    const yaml = "port: not_a_number";
    const schema = z.object({ port: z.number() });

    expect(() => loadConfig(yaml, schema)).toThrow();
  });
});

describe("loadConfigFixture — orchestrator.skills + security.inbound_scan", () => {
  it("parses orchestrator.skills and security.inbound_scan", () => {
    const cfg = loadConfigFixture(); // existing helper against the repo config.yaml
    expect(cfg.orchestrator?.skills.max_index_entries).toBe(50);
    expect(cfg.orchestrator?.skills.max_body_chars).toBe(20000);
    expect(cfg.security.inbound_scan.enabled).toBe(true);
    expect(cfg.security.inbound_scan.channels.skill_body).toBe(true);
  });

  it("boots a pre-upgrade config missing both sections, on secure defaults", () => {
    const cfg = loadConfigFixture({ stripKeys: ["orchestrator.skills", "security.inbound_scan"] });
    expect(cfg.orchestrator?.skills.max_index_entries).toBe(50);
    expect(cfg.security.inbound_scan.enabled).toBe(true); // missing block = scanning ON — secure by default
  });
});
