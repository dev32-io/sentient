import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig, resolveEnvVars, resolveEnvVarsDeep } from "./loader.ts";

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
