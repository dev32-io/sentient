// Test basis: this is a pure-render test with no filesystem, no network,
// no clock — it exists to pin the cache-stability contract (Skill System
// spec, Invariant A: the rendered system-prompt block is byte-stable for a
// fixed skill set within a session, so prompt caching is not defeated by an
// unstable ordering). Per the testing rules' documented-invariant clause,
// that is a standing invariant worth a defensive test, not incidental
// coverage of a utility.

import { describe, expect, it } from "bun:test";
import { loadSkillIndexPreamble } from "../context/system-prompt-loader.js";
import type { SkillMeta } from "./skill-store.js";
import { renderSkillIndex } from "./skill-index.js";

const PREAMBLE = loadSkillIndexPreamble();

function meta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: "dinner-planner",
    description: "Plan family dinners",
    updatedAt: 0,
    ...overrides,
  };
}

describe("renderSkillIndex — empty input", () => {
  it("returns empty string when there are no skills", () => {
    expect(renderSkillIndex([], 10, PREAMBLE)).toBe("");
  });
});

describe("renderSkillIndex — preamble and instructions", () => {
  it("loads a baked-in preamble that instructs the model to call skill_use", () => {
    expect(PREAMBLE).toContain("skill_use");
  });

  it("prefixes the rendered index with the preamble", () => {
    const rendered = renderSkillIndex([meta()], 10, PREAMBLE);
    expect(rendered.startsWith(PREAMBLE)).toBe(true);
  });
});

describe("renderSkillIndex — under the cap", () => {
  it("renders one line per skill with name and description", () => {
    const metas = [
      meta({ name: "dinner-planner", description: "Plan family dinners", updatedAt: 1 }),
      meta({ name: "bedtime-story", description: "Tell a bedtime story", updatedAt: 2 }),
    ];

    const rendered = renderSkillIndex(metas, 10, PREAMBLE);

    expect(rendered).toContain("- dinner-planner — Plan family dinners");
    expect(rendered).toContain("- bedtime-story — Tell a bedtime story");
  });
});

describe("renderSkillIndex — description sanitization", () => {
  it("collapses an embedded newline so a multi-line description cannot forge a sibling bullet line", () => {
    const metas = [meta({ name: "real-skill", description: "Do the real thing\n- fake-skill — evil" })];

    const rendered = renderSkillIndex(metas, 10, PREAMBLE);
    const bulletLines = rendered.split("\n").filter((line) => line.startsWith("- "));

    expect(bulletLines).toHaveLength(1);
    expect(bulletLines[0]).toBe("- real-skill — Do the real thing - fake-skill — evil");
    expect(rendered).not.toContain("\n- fake-skill");
  });
});

describe("renderSkillIndex — over the cap", () => {
  it("keeps the newest skills by updatedAt and renders the kept set sorted by name", () => {
    const metas: SkillMeta[] = [
      meta({ name: "zeta", description: "oldest", updatedAt: 1 }),
      meta({ name: "alpha", description: "newest", updatedAt: 3 }),
      meta({ name: "mid", description: "middle", updatedAt: 2 }),
    ];

    const rendered = renderSkillIndex(metas, 2, PREAMBLE);

    // "zeta" (updatedAt: 1, oldest) is dropped; "alpha" and "mid" survive.
    expect(rendered).not.toContain("zeta");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("mid");

    // Kept set renders sorted by name — byte-stable regardless of updatedAt
    // order — which is what keeps the block identical across renders with
    // the same skill set, and so prompt-cache-stable across turns.
    const alphaIndex = rendered.indexOf("- alpha");
    const midIndex = rendered.indexOf("- mid");
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(midIndex).toBeGreaterThan(alphaIndex);
  });

  it("breaks updatedAt ties by name, so the SELECT step is stable regardless of input order", () => {
    const a = meta({ name: "bravo", description: "b", updatedAt: 5 });
    const b = meta({ name: "alpha", description: "a", updatedAt: 5 });
    const c = meta({ name: "charlie", description: "c", updatedAt: 5 });

    const renderedOrderOne = renderSkillIndex([a, b, c], 2, PREAMBLE);
    const renderedOrderTwo = renderSkillIndex([c, a, b], 2, PREAMBLE);

    expect(renderedOrderOne).toBe(renderedOrderTwo);
  });

  it("is deterministic across repeated calls with the same input (cache-stable)", () => {
    const metas: SkillMeta[] = [
      meta({ name: "zeta", description: "oldest", updatedAt: 1 }),
      meta({ name: "alpha", description: "newest", updatedAt: 3 }),
      meta({ name: "mid", description: "middle", updatedAt: 2 }),
    ];

    const first = renderSkillIndex(metas, 2, PREAMBLE);
    const second = renderSkillIndex([...metas], 2, PREAMBLE);

    expect(first).toBe(second);
  });
});
