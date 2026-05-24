import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserPortStore, nextFreePort } from "./user-port-store.ts";

describe("nextFreePort", () => {
  it("returns base when no bindings", () => {
    expect(nextFreePort(8650, [])).toBe(8650);
  });

  it("returns base when bindings on other ports", () => {
    expect(nextFreePort(8650, [{ userId: "u_aaaaaaaa", port: 9000 }])).toBe(8650);
  });

  it("skips contiguous occupied ports", () => {
    const bindings = [
      { userId: "u_aaaaaaaa", port: 8650 },
      { userId: "u_bbbbbbbb", port: 8651 },
      { userId: "u_cccccccc", port: 8652 },
    ];
    expect(nextFreePort(8650, bindings)).toBe(8653);
  });

  it("fills gaps", () => {
    const bindings = [
      { userId: "u_aaaaaaaa", port: 8650 },
      { userId: "u_cccccccc", port: 8652 },
    ];
    expect(nextFreePort(8650, bindings)).toBe(8651);
  });
});

describe("UserPortStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "user-port-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty list when file missing", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    const r = await store.list();
    expect(r.ok && r.value).toEqual([]);
  });

  it("bind allocates port_base for first user", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    const r = await store.bind("u_aaaaaaaa");
    expect(r.ok && r.value).toEqual({ userId: "u_aaaaaaaa", port: 8650 });
  });

  it("bind allocates next port for second user", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    await store.bind("u_aaaaaaaa");
    const r = await store.bind("u_bbbbbbbb");
    expect(r.ok && r.value).toEqual({ userId: "u_bbbbbbbb", port: 8651 });
  });

  it("bind is idempotent for existing user", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    const first = await store.bind("u_aaaaaaaa");
    const second = await store.bind("u_aaaaaaaa");
    expect(first.ok && second.ok && first.value).toEqual(second.ok ? second.value : null);
  });

  it("unbind removes a binding and frees the port", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    await store.bind("u_aaaaaaaa");
    await store.bind("u_bbbbbbbb");
    await store.unbind("u_aaaaaaaa");
    const r = await store.bind("u_cccccccc");
    expect(r.ok && r.value.port).toBe(8650); // freed slot reused
  });

  it("resolvePort returns port for known user", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    await store.bind("u_aaaaaaaa");
    expect(await store.resolvePort("u_aaaaaaaa")).toBe(8650);
  });

  it("resolvePort returns null for unknown user", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    expect(await store.resolvePort("u_aaaaaaaa")).toBeNull();
  });

  it("resolvePort returns null for malformed userId — never reads disk for invalid", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    expect(await store.resolvePort("../etc/passwd")).toBeNull();
    expect(await store.resolvePort("admin")).toBeNull();
  });

  it("bind throws on malformed userId", async () => {
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    await expect(store.bind("admin")).rejects.toThrow(/invalid userId/);
  });

  it("migrates legacy slot-bindings.json on first read", async () => {
    const legacy = [
      { userId: "u_aaaaaaaa", slotKey: "alice", port: 8650 },
      { userId: "u_bbbbbbbb", slotKey: "bob", port: 8651 },
    ];
    await writeFile(join(dir, "slot-bindings.json"), JSON.stringify(legacy));
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    const r = await store.list();
    expect(r.ok && r.value).toEqual([
      { userId: "u_aaaaaaaa", port: 8650 },
      { userId: "u_bbbbbbbb", port: 8651 },
    ]);
    // New file written
    const fileText = await readFile(join(dir, "user-ports.json"), "utf8");
    expect(JSON.parse(fileText)).toEqual([
      { userId: "u_aaaaaaaa", port: 8650 },
      { userId: "u_bbbbbbbb", port: 8651 },
    ]);
  });

  it("returns corrupt-file error on malformed JSON", async () => {
    await writeFile(join(dir, "user-ports.json"), "not json");
    const store = createUserPortStore({ rootDir: dir, portBase: 8650 });
    const r = await store.list();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("corrupt-file");
  });
});
