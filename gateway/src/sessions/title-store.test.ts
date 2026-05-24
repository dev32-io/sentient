import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTitleStore } from "./title-store.ts";

describe("TitleStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "title-store-"));
  });

  it("returns undefined for a missing override", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    expect(await s.getTitle("missing")).toBeUndefined();
  });

  it("setTitle persists, getTitle reads it back", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    await s.setTitle("s1", "My chat");
    expect(await s.getTitle("s1")).toBe("My chat");
    const onDisk = JSON.parse(await readFile(join(dir, "u1", "sessions", "titles.json"), "utf8"));
    expect(onDisk.s1).toBe("My chat");
  });

  it("getTitlesFor returns map for known ids only", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    await s.setTitle("a", "A");
    await s.setTitle("b", "B");
    const map = await s.getTitlesFor(["a", "b", "c"]);
    expect(map).toEqual({ a: "A", b: "B" });
  });

  it("delete removes the override", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    await s.setTitle("s1", "Hi");
    await s.delete("s1");
    expect(await s.getTitle("s1")).toBeUndefined();
  });

  it("corrupt JSON falls back to empty map and survives", async () => {
    await mkdir(join(dir, "u1", "sessions"), { recursive: true });
    await writeFile(join(dir, "u1", "sessions", "titles.json"), "this is not json", "utf8");
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    expect(await s.getTitle("anything")).toBeUndefined();
    await s.setTitle("s1", "ok");
    expect(await s.getTitle("s1")).toBe("ok");
  });

  it("file mode is 0600 after write", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    await s.setTitle("s1", "Hi");
    const st = await stat(join(dir, "u1", "sessions", "titles.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("user dir is mode 0700 after write", async () => {
    const s = createTitleStore({ userDataRoot: dir, userId: "u1" });
    await s.setTitle("s1", "Hi");
    const st = await stat(join(dir, "u1"));
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("rejects user ids that contain path separators", () => {
    expect(() => createTitleStore({ userDataRoot: dir, userId: "../escape" })).toThrow(/invalid userId/i);
  });
});
