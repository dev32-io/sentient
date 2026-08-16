import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../../access/capability.js";
import { WebArtifactStore } from "./web-artifact-store.js";

const roots: string[] = [];
async function cap(user: `u_${string}`): Promise<Capability> {
  const rootPath = await mkdtemp(join(tmpdir(), `${user}-`));
  roots.push(rootPath);
  await chmod(rootPath, 0o700);
  return { ownerUserId: user, rootPath, resource: "web-artifact", role: "adult" };
}
const cfg = {
  ttlMs: 1000,
  maxEntries: 2,
  maxBytes: 100_000,
  maxSliceChars: 80,
  maxPassages: 2,
  passageContextChars: 10,
};
const artifact = (content: string) => ({
  sourceUrl: "https://a.test",
  finalUrl: "https://a.test/x",
  title: "A",
  contentType: "text/plain",
  content,
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

describe("WebArtifactStore", () => {
  test("uses opaque IDs and restrictive directory/file modes", async () => {
    const capability = await cap("u_aaaaaaaa");
    const store = new WebArtifactStore(cfg);
    const id = await store.put(capability, artifact("secret full content"));
    expect(id).toMatch(/^wa_[a-f0-9]{32}$/);
    expect((await stat(join(capability.rootPath, "web-artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(capability.rootPath, "web-artifacts", `${id}.json`))).mode & 0o777).toBe(0o600);
  });

  test("enforces bounded offset slices and matching passages", async () => {
    const capability = await cap("u_aaaaaaaa");
    const store = new WebArtifactStore(cfg);
    const content = "zero alpha one two three alpha four five six alpha end";
    const id = await store.put(capability, artifact(content));
    expect(await store.readSlice(capability, id, 5, 10)).toMatchObject({
      ok: true,
      value: { content: "alpha one ", totalChars: content.length, returnedStart: 5, returnedEnd: 15 },
    });
    expect(await store.readSlice(capability, id, 0, 81)).toEqual({ ok: false, error: "invalid_request" });
    const matches = await store.findPassages(capability, id, "alpha", 10);
    expect(matches).toMatchObject({ ok: true, value: { matches: 2 } });
    if (matches.ok) expect(matches.value.content.length).toBeLessThanOrEqual(cfg.maxSliceChars);
  });

  test("refuses malformed, expired, and foreign ownership records", async () => {
    let now = 100;
    const owner = await cap("u_aaaaaaaa");
    const other = await cap("u_bbbbbbbb");
    const store = new WebArtifactStore(cfg, () => now);
    const id = await store.put(owner, artifact("private"));
    expect(await store.readSlice(owner, "../../x", 0, 5)).toEqual({ ok: false, error: "malformed" });

    await mkdir(join(other.rootPath, "web-artifacts"), { recursive: true });
    await cp(join(owner.rootPath, "web-artifacts", `${id}.json`), join(other.rootPath, "web-artifacts", `${id}.json`));
    expect(await store.readSlice(other, id, 0, 5)).toEqual({ ok: false, error: "foreign" });

    now = 1100;
    expect(await store.readSlice(owner, id, 0, 5)).toEqual({ ok: false, error: "expired" });
  });

  test("evicts oldest entries at byte capacity", async () => {
    let now = 1;
    const capability = await cap("u_aaaaaaaa");
    const store = new WebArtifactStore({ ...cfg, maxEntries: 10, maxBytes: 550 }, () => now);
    const first = await store.put(capability, artifact("a".repeat(200)));
    now++;
    const second = await store.put(capability, artifact("b".repeat(200)));
    expect(await store.readSlice(capability, first, 0, 5)).toEqual({ ok: false, error: "not_found" });
    expect(await store.readSlice(capability, second, 0, 5)).toMatchObject({ ok: true });
  });

  test("evicts oldest entries at entry capacity", async () => {
    let now = 1;
    const capability = await cap("u_aaaaaaaa");
    const store = new WebArtifactStore(cfg, () => now);
    const first = await store.put(capability, artifact("first"));
    now++;
    await store.put(capability, artifact("second"));
    now++;
    const third = await store.put(capability, artifact("third"));
    expect(await store.readSlice(capability, first, 0, 5)).toEqual({ ok: false, error: "not_found" });
    expect(await store.readSlice(capability, third, 0, 5)).toMatchObject({ ok: true });
  });
});
