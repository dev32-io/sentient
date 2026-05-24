import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyTitles } from "./storage-migrator.ts";

describe("migrateLegacyTitles", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "storage-migrator-"));
  });

  it("moves <legacyDir>/<userId>.json to <newRoot>/<userId>/sessions/titles.json", async () => {
    const legacyDir = join(root, "session-titles");
    const newRoot = join(root, "users");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "u_abc.json"), JSON.stringify({ s1: "Hello" }));

    await migrateLegacyTitles({ legacyDir, newRoot, userId: "u_abc" });

    const moved = await readFile(join(newRoot, "u_abc", "sessions", "titles.json"), "utf8");
    expect(JSON.parse(moved)).toEqual({ s1: "Hello" });
  });

  it("is idempotent: running twice leaves data intact", async () => {
    const legacyDir = join(root, "session-titles");
    const newRoot = join(root, "users");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "u_abc.json"), JSON.stringify({ s1: "Hi" }));

    await migrateLegacyTitles({ legacyDir, newRoot, userId: "u_abc" });
    await migrateLegacyTitles({ legacyDir, newRoot, userId: "u_abc" });

    const moved = await readFile(join(newRoot, "u_abc", "sessions", "titles.json"), "utf8");
    expect(JSON.parse(moved)).toEqual({ s1: "Hi" });
  });

  it("no-op when no legacy file exists", async () => {
    const legacyDir = join(root, "session-titles");
    const newRoot = join(root, "users");
    await migrateLegacyTitles({ legacyDir, newRoot, userId: "u_abc" });
    // Should not throw; new file should not exist either.
    let exists = true;
    try {
      await readFile(join(newRoot, "u_abc", "sessions", "titles.json"), "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("user dir is mode 0700 after migration", async () => {
    const legacyDir = join(root, "session-titles");
    const newRoot = join(root, "users");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "u_abc.json"), JSON.stringify({ s1: "Hi" }));

    await migrateLegacyTitles({ legacyDir, newRoot, userId: "u_abc" });

    const userDirStat = await stat(join(newRoot, "u_abc"));
    expect(userDirStat.mode & 0o777).toBe(0o700);
  });

  it("rejects user ids that contain path separators", async () => {
    await expect(migrateLegacyTitles({ legacyDir: root, newRoot: root, userId: "../escape" })).rejects.toThrow(
      /invalid userId/i,
    );
  });
});
