import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Override SENTIENT_GATEWAY_ROOT before importing the module under test
const TEST_ROOT = await mkdtemp(join(tmpdir(), "sentient-archive-"));
process.env.SENTIENT_GATEWAY_ROOT = TEST_ROOT;

const { archiveUserDir } = await import("./archive-user-dir.js");

describe("archiveUserDir", () => {
  afterEach(async () => {
    try {
      await rm(TEST_ROOT, { recursive: true, force: true });
    } catch {}
  });

  it("renames user dir into _archive with timestamp", async () => {
    const userDir = join(TEST_ROOT, "u_abc123");
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(join(userDir, "profile.json"), "{}");

    const result = await archiveUserDir("u_abc123");

    expect(result.ok).toBe(true);
    // source gone
    await expect(fs.access(userDir)).rejects.toThrow();
    // archive dir exists with a prefixed entry
    const entries = await fs.readdir(join(TEST_ROOT, "_archive"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^u_abc123-/);
  });

  it("returns io-error when source dir does not exist", async () => {
    const result = await archiveUserDir("u_nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("io-error");
  });
});
