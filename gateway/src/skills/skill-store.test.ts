import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SkillStore, createSkillStore } from "./skill-store.js";
import type { SkillFile } from "./skill-file.js";

const MAX_BODY_CHARS = 20000;
const KNOWN_TOOLS = new Set(["search_web"]);

function makeSkill(overrides: Partial<SkillFile> = {}): SkillFile {
  return {
    name: "dinner-planner",
    description: "Plan family dinners",
    body: "# Steps\n1. Plan.\n2. Cook.",
    ...overrides,
  };
}

let root: string;
let store: SkillStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skill-store-test-"));
  store = createSkillStore(root, { maxBodyChars: MAX_BODY_CHARS, knownTools: KNOWN_TOOLS });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SkillStore — happy path", () => {
  it("writes, lists, reads, then removes a skill", () => {
    expect(store.write(makeSkill(), { overwrite: false })).toBeNull();

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("dinner-planner");
    expect(listed[0]?.description).toBe("Plan family dinners");
    expect(typeof listed[0]?.updatedAt).toBe("number");

    expect(store.read("dinner-planner")).toEqual(makeSkill());

    expect(store.remove("dinner-planner")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.read("dinner-planner")).toBeNull();
  });
});

describe("SkillStore — write duplicate/overwrite semantics", () => {
  it("refuses a duplicate write without overwrite", () => {
    expect(store.write(makeSkill(), { overwrite: false })).toBeNull();
    const result = store.write(makeSkill({ description: "A different plan" }), { overwrite: false });
    expect(result).toEqual({ kind: "duplicate" });
    // Original is untouched.
    expect(store.read("dinner-planner")?.description).toBe("Plan family dinners");
  });

  it("updates an existing skill when overwrite is true", () => {
    expect(store.write(makeSkill(), { overwrite: false })).toBeNull();
    const updated = makeSkill({ description: "Updated plan", body: "# New steps\n1. Reorder." });
    expect(store.write(updated, { overwrite: true })).toBeNull();
    expect(store.read("dinner-planner")).toEqual(updated);
    expect(store.list()).toHaveLength(1);
  });
});

describe("SkillStore — list skips corrupt entries", () => {
  it("skips an unparseable SKILL.md but still lists the others", () => {
    expect(store.write(makeSkill({ name: "good-one" }), { overwrite: false })).toBeNull();

    const brokenDir = join(root, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "SKILL.md"), "not a frontmatter file at all\n");

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("good-one");
  });

  it("skips a dir whose frontmatter name does not match its dir name", () => {
    expect(store.write(makeSkill({ name: "good-one" }), { overwrite: false })).toBeNull();

    const mismatchedDir = join(root, "mismatched");
    mkdirSync(mismatchedDir, { recursive: true });
    writeFileSync(
      join(mismatchedDir, "SKILL.md"),
      "---\nname: not-mismatched\ndescription: d\n---\nbody\n",
    );

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe("good-one");
  });
});

describe("SkillStore — read absent", () => {
  it("returns null for a skill that does not exist", () => {
    expect(store.read("nope")).toBeNull();
  });

  it("returns false removing a skill that does not exist", () => {
    expect(store.remove("nope")).toBe(false);
  });
});

describe("SkillStore — validation errors pass through from T4", () => {
  it("rejects a bad name without writing anything to disk", () => {
    const result = store.write(makeSkill({ name: "Not A Slug" }), { overwrite: false });
    expect(result).toEqual({ kind: "bad_name", name: "Not A Slug" });
    expect(store.list()).toEqual([]);
  });

  it("rejects a skill referencing an unknown tool", () => {
    const result = store.write(makeSkill({ tools: ["not_a_real_tool"] }), { overwrite: false });
    expect(result).toEqual({ kind: "unknown_tools", tools: ["not_a_real_tool"] });
    expect(store.list()).toEqual([]);
  });
});

describe("SkillStore — symlink escape guard", () => {
  let outsideDir: string;

  beforeEach(() => {
    outsideDir = mkdtempSync(join(tmpdir(), "skill-store-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "not a skill\n");
    symlinkSync(outsideDir, join(root, "evil"), "dir");
  });

  afterEach(() => {
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("refuses to read through a symlinked skill dir", () => {
    expect(store.read("evil")).toBeNull();
  });

  it("refuses to write through a symlinked skill dir, never following it", () => {
    const result = store.write(makeSkill({ name: "evil" }), { overwrite: false });
    expect(result).toEqual({ kind: "path_refused" });
    // The outside directory was never touched.
    expect(readdirSync(outsideDir)).toEqual(["secret.txt"]);
  });

  it("refuses to write through a symlinked skill dir even with overwrite:true — not escapable like a duplicate", () => {
    const result = store.write(makeSkill({ name: "evil" }), { overwrite: true });
    expect(result).toEqual({ kind: "path_refused" });
    expect(readdirSync(outsideDir)).toEqual(["secret.txt"]);
  });

  it("refuses to remove through a symlinked skill dir", () => {
    expect(store.remove("evil")).toBe(false);
    expect(readdirSync(outsideDir)).toEqual(["secret.txt"]);
  });

  it("does not list a symlinked skill dir that escapes the root", () => {
    expect(store.write(makeSkill({ name: "good-one" }), { overwrite: false })).toBeNull();
    const listed = store.list();
    expect(listed.map((m) => m.name)).toEqual(["good-one"]);
  });
});
