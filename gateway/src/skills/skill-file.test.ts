import { describe, expect, it } from "bun:test";
import {
  MAX_DESCRIPTION_CHARS,
  SKILL_NAME_RE,
  type SkillFile,
  parseSkillFile,
  serializeSkillFile,
  validateSkillInput,
} from "./skill-file.js";

const MAX_BODY_CHARS = 20000;

describe("SKILL_NAME_RE", () => {
  it("accepts lowercase-kebab names", () => {
    expect(SKILL_NAME_RE.test("dinner-planner")).toBe(true);
    expect(SKILL_NAME_RE.test("a")).toBe(true);
  });

  it("rejects names with spaces or capitals", () => {
    expect(SKILL_NAME_RE.test("My Skill")).toBe(false);
  });
});

describe("parseSkillFile", () => {
  it("round-trips serialize→parse", () => {
    const skill: SkillFile = {
      name: "dinner-planner",
      description: "Plan dinners",
      tools: ["search_web"],
      body: "# Steps\n…",
    };
    const parsed = parseSkillFile(serializeSkillFile(skill), { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toEqual({ ok: true, skill });
  });

  it("round-trips a skill with tools omitted", () => {
    const skill: SkillFile = {
      name: "no-tools-skill",
      description: "Has no tools field",
      body: "Just a body.",
    };
    const parsed = parseSkillFile(serializeSkillFile(skill), { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toEqual({ ok: true, skill });
  });

  it("accepts a zh (Chinese) body", () => {
    const skill: SkillFile = {
      name: "zh-skill",
      description: "A skill with a Chinese body",
      body: "# 步骤\n第一步：做饭。第二步：吃饭。",
    };
    const parsed = parseSkillFile(serializeSkillFile(skill), { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toEqual({ ok: true, skill });
  });

  it("rejects a bad name (uppercase/spaces)", () => {
    const raw = serializeSkillFile({ name: "x", description: "d", body: "b" }).replace("name: x", "name: My Skill");
    const parsed = parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({ ok: false, error: { kind: "bad_name", name: "My Skill" } });
  });

  it("rejects a description over MAX_DESCRIPTION_CHARS", () => {
    const longDescription = "d".repeat(MAX_DESCRIPTION_CHARS + 1);
    const raw = serializeSkillFile({ name: "x", description: longDescription, body: "b" });
    const parsed = parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "description_too_long", length: longDescription.length },
    });
  });

  it("rejects a body over the configured cap", () => {
    const overCapBody = "b".repeat(MAX_BODY_CHARS + 1);
    const raw = serializeSkillFile({ name: "x", description: "d", body: overCapBody });
    const parsed = parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "body_too_long", length: overCapBody.length, max: MAX_BODY_CHARS },
    });
  });

  it("rejects invisible characters in the body fail-closed", () => {
    const raw = serializeSkillFile({ name: "x", description: "d", body: "do​thing" });
    expect(parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS })).toMatchObject({
      ok: false,
      error: { kind: "invisible_chars", count: 1 },
    });
  });

  it("counts multiple invisible characters", () => {
    const raw = serializeSkillFile({ name: "x", description: "d", body: "a​b⁠c﻿" });
    expect(parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS })).toMatchObject({
      ok: false,
      error: { kind: "invisible_chars", count: 3 },
    });
  });

  it("rejects content missing the frontmatter fence", () => {
    const parsed = parseSkillFile("just some body text, no frontmatter at all", {
      maxBodyChars: MAX_BODY_CHARS,
    });
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects unclosed frontmatter fence", () => {
    const parsed = parseSkillFile("---\nname: x\ndescription: d\n", { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects frontmatter that is not valid YAML", () => {
    const raw = "---\nname: [unterminated\n---\nbody\n";
    const parsed = parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects frontmatter missing required fields", () => {
    const raw = "---\nname: x\n---\nbody\n";
    const parsed = parseSkillFile(raw, { maxBodyChars: MAX_BODY_CHARS });
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });
});

describe("validateSkillInput", () => {
  const knownTools: ReadonlySet<string> = new Set(["search_web", "get_weather"]);

  it("returns null for a valid skill", () => {
    const skill: SkillFile = {
      name: "dinner-planner",
      description: "Plan dinners",
      tools: ["search_web"],
      body: "# Steps\n…",
    };
    expect(validateSkillInput(skill, { maxBodyChars: MAX_BODY_CHARS, knownTools })).toBeNull();
  });

  it("returns null when tools is omitted", () => {
    const skill: SkillFile = { name: "no-tools-skill", description: "d", body: "b" };
    expect(validateSkillInput(skill, { maxBodyChars: MAX_BODY_CHARS, knownTools })).toBeNull();
  });

  it("flags unknown tools not present in knownTools", () => {
    const skill: SkillFile = {
      name: "x",
      description: "d",
      tools: ["phantom_tool"],
      body: "b",
    };
    expect(validateSkillInput(skill, { maxBodyChars: MAX_BODY_CHARS, knownTools })).toEqual({
      kind: "unknown_tools",
      tools: ["phantom_tool"],
    });
  });

  it("flags only the unknown subset when tools mix known and unknown", () => {
    const skill: SkillFile = {
      name: "x",
      description: "d",
      tools: ["search_web", "phantom_tool"],
      body: "b",
    };
    expect(validateSkillInput(skill, { maxBodyChars: MAX_BODY_CHARS, knownTools })).toEqual({
      kind: "unknown_tools",
      tools: ["phantom_tool"],
    });
  });

  it("still enforces structural checks (e.g. bad_name) before unknown_tools", () => {
    const skill: SkillFile = {
      name: "My Skill",
      description: "d",
      tools: ["phantom_tool"],
      body: "b",
    };
    expect(validateSkillInput(skill, { maxBodyChars: MAX_BODY_CHARS, knownTools })).toEqual({
      kind: "bad_name",
      name: "My Skill",
    });
  });
});

describe("serializeSkillFile", () => {
  it("produces a frontmatter fence followed by the body", () => {
    const raw = serializeSkillFile({ name: "x", description: "d", body: "body text" });
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("name: x");
    expect(raw).toContain("description: d");
    expect(raw.endsWith("body text")).toBe(true);
  });
});
