import { expect, test } from "bun:test";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import { makeSecretAccessor } from "./secret-accessor.js";

const FAKE_SEARXNG_SECRET = "a".repeat(64);
const FAKE_HERMES_TOKEN = "b".repeat(64);

const mockInternalStore: InternalSecretsStore = {
  loadOrInit: async () => ({
    ok: true,
    value: { hermesAuthToken: FAKE_HERMES_TOKEN, searxngSecret: FAKE_SEARXNG_SECRET },
  }),
  getHermesAuthTokenSync: () => FAKE_HERMES_TOKEN,
  getSearxngSecretSync: () => FAKE_SEARXNG_SECRET,
};

/** Minimal SecretsStore stub: loadSync returns a flat nested object. */
const mockSecretsStore = {
  loadSync: () => ({ home_assistant: { mcp_server_token: "ha-tok", url: "http://ha:8123" } }),
} as unknown as SecretsStore;

test("resolves internal.searxng_secret via internalSecretsStore", () => {
  const accessor = makeSecretAccessor(mockSecretsStore, mockInternalStore);
  expect(accessor.resolve("internal.searxng_secret")).toBe(FAKE_SEARXNG_SECRET);
});

test("resolves operator binding (home_assistant.mcp_server_token) via secretsStore", () => {
  const accessor = makeSecretAccessor(mockSecretsStore, mockInternalStore);
  expect(accessor.resolve("home_assistant.mcp_server_token")).toBe("ha-tok");
});

test("returns null for unknown internal.* key", () => {
  const accessor = makeSecretAccessor(mockSecretsStore, mockInternalStore);
  expect(accessor.resolve("internal.nonexistent_key")).toBeNull();
});

test("returns null when secretsStore is null for operator key", () => {
  const accessor = makeSecretAccessor(null, mockInternalStore);
  expect(accessor.resolve("home_assistant.mcp_server_token")).toBeNull();
});

test("still resolves internal.searxng_secret when secretsStore is null", () => {
  const accessor = makeSecretAccessor(null, mockInternalStore);
  expect(accessor.resolve("internal.searxng_secret")).toBe(FAKE_SEARXNG_SECRET);
});
