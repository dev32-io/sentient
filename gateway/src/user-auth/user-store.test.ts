import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UserRecord } from "./types.js";
import { createUserStore } from "./user-store.js";

function sample(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    userId: "kevin",
    displayName: "Kevin",
    pinHash: "$argon2id$fake",
    role: "admin",
    avatarTint: "terra",
    createdAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("createUserStore", () => {
  let root: string;
  let store: ReturnType<typeof createUserStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sentient-users-"));
    process.env.SENTIENT_GATEWAY_ROOT = root;
    store = createUserStore();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // biome-ignore lint/performance/noDelete: delete is the correct way to unset a process.env key
    delete process.env.SENTIENT_GATEWAY_ROOT;
  });

  it("returns empty list when users.json missing", async () => {
    const r = await store.list();
    expect(r).toEqual({ ok: true, value: [] });
  });

  it("adds a user and reads it back", async () => {
    const add = await store.add(sample());
    expect(add).toEqual({ ok: true, value: undefined });
    const list = await store.list();
    expect(list).toEqual({ ok: true, value: [sample()] });
  });

  it("returns already-exists on duplicate userId", async () => {
    await store.add(sample());
    const dup = await store.add(sample({ displayName: "Other" }));
    expect(dup).toEqual({ ok: false, error: "already-exists" });
  });

  it("get returns null for unknown userId", async () => {
    const r = await store.get("ghost");
    expect(r).toEqual({ ok: true, value: null });
  });

  it("get returns the record", async () => {
    await store.add(sample());
    const r = await store.get("kevin");
    expect(r).toEqual({ ok: true, value: sample() });
  });

  it("update patches fields and keeps userId intact", async () => {
    await store.add(sample());
    const upd = await store.update("kevin", { displayName: "Kevin Ye" });
    expect(upd).toEqual({ ok: true, value: undefined });
    const got = await store.get("kevin");
    expect(got.ok && got.value?.displayName).toBe("Kevin Ye");
  });

  it("update returns not-found for missing user", async () => {
    const upd = await store.update("ghost", { displayName: "x" });
    expect(upd).toEqual({ ok: false, error: "not-found" });
  });

  it("remove deletes the user", async () => {
    await store.add(sample());
    const rm = await store.remove("kevin");
    expect(rm).toEqual({ ok: true, value: undefined });
    const list = await store.list();
    expect(list).toEqual({ ok: true, value: [] });
  });

  it("remove returns not-found for missing user", async () => {
    const rm = await store.remove("ghost");
    expect(rm).toEqual({ ok: false, error: "not-found" });
  });

  it("returns corrupt-file when users.json is not an array", async () => {
    writeFileSync(join(root, "users.json"), '{"not":"an array"}', "utf8");
    const r = await store.list();
    expect(r).toEqual({ ok: false, error: "corrupt-file" });
  });

  it("persists via atomic rename — no .tmp sibling after add", async () => {
    await store.add(sample());
    expect(existsSync(join(root, "users.json.tmp"))).toBe(false);
    expect(existsSync(join(root, "users.json"))).toBe(true);
  });

  it("round-trips non-ASCII display names", async () => {
    await store.add(sample({ displayName: "凯文" }));
    const got = await store.get("kevin");
    expect(got.ok && got.value?.displayName).toBe("凯文");
  });
});
