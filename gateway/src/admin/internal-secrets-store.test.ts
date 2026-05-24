import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInternalSecretsStore } from "./internal-secrets-store.ts";

function file_in_dir(dir: string): string {
  return join(dir, "internal-secrets.json");
}

describe("createInternalSecretsStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "internal-secrets-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a 64-char hex token on first loadOrInit and persists it", async () => {
    const store = createInternalSecretsStore(dir);
    const result = await store.loadOrInit();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hermesAuthToken).toMatch(/^[0-9a-f]{64}$/);

    const file = join(dir, "internal-secrets.json");
    const stat = statSync(file);
    // 0600 = owner rw, no group, no other
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.hermesAuthToken).toBe(result.value.hermesAuthToken);
    expect(onDisk.schemaVersion).toBe(2);
  });

  it("returns the existing token on subsequent loadOrInit calls", async () => {
    const store = createInternalSecretsStore(dir);
    const a = await store.loadOrInit();
    const b = await store.loadOrInit();
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(b.value.hermesAuthToken).toBe(a.value.hermesAuthToken);
  });

  it("returns the synchronous value once loaded", async () => {
    const store = createInternalSecretsStore(dir);
    await store.loadOrInit();
    const tok = store.getHermesAuthTokenSync();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws from getHermesAuthTokenSync if loadOrInit was never called", () => {
    const store = createInternalSecretsStore(dir);
    expect(() => store.getHermesAuthTokenSync()).toThrow(/loadOrInit/);
  });

  it("migrates a v1 file to v2 by generating searxngSecret on loadOrInit", async () => {
    const file = join(dir, "internal-secrets.json");
    const v1Token = "a".repeat(64);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, hermesAuthToken: v1Token }), { mode: 0o600 });

    const store = createInternalSecretsStore(dir);
    const result = await store.loadOrInit();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hermesAuthToken).toBe(v1Token);
    expect(result.value.searxngSecret).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.hermesAuthToken).toBe(v1Token);
    expect(onDisk.searxngSecret).toBe(result.value.searxngSecret);
  });

  it("returns the existing searxngSecret on subsequent loadOrInit calls (idempotent)", async () => {
    const store = createInternalSecretsStore(dir);
    const a = await store.loadOrInit();
    const b = await store.loadOrInit();
    if (!a.ok || !b.ok) throw new Error("unreachable");
    expect(b.value.searxngSecret).toBe(a.value.searxngSecret);
  });

  it("generates both tokens fresh on a missing file (v2 schema)", async () => {
    const store = createInternalSecretsStore(dir);
    const result = await store.loadOrInit();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hermesAuthToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.searxngSecret).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = JSON.parse(readFileSync(file_in_dir(dir), "utf8"));
    expect(onDisk.schemaVersion).toBe(2);
  });

  it("exposes searxngSecret synchronously after loadOrInit", async () => {
    const store = createInternalSecretsStore(dir);
    await store.loadOrInit();
    expect(store.getSearxngSecretSync()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws from getSearxngSecretSync if loadOrInit was never called", () => {
    const store = createInternalSecretsStore(dir);
    expect(() => store.getSearxngSecretSync()).toThrow(/loadOrInit/);
  });
});
