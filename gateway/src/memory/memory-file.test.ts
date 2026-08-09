import { describe, expect, it } from "bun:test";
import {
  MEMORY_SLUG_RE,
  type TopicFile,
  countUsage,
  parseTopicFile,
  serializeTopicFile,
  validateMemoryText,
} from "./memory-file.js";

describe("MEMORY_SLUG_RE", () => {
  it("accepts lowercase-kebab slugs", () => {
    expect(MEMORY_SLUG_RE.test("family-trips")).toBe(true);
    expect(MEMORY_SLUG_RE.test("a")).toBe(true);
  });

  it("rejects slugs with path traversal characters", () => {
    expect(MEMORY_SLUG_RE.test("../etc/passwd")).toBe(false);
    expect(MEMORY_SLUG_RE.test("topics/../secret")).toBe(false);
    expect(MEMORY_SLUG_RE.test("a/b")).toBe(false);
  });

  it("rejects uppercase, spaces, and leading hyphen", () => {
    expect(MEMORY_SLUG_RE.test("Family-Trips")).toBe(false);
    expect(MEMORY_SLUG_RE.test("family trips")).toBe(false);
    expect(MEMORY_SLUG_RE.test("-family")).toBe(false);
  });
});

describe("parseTopicFile", () => {
  it("round-trips serialize→parse", () => {
    const topic: TopicFile = {
      name: "family-trips",
      description: "Notes on family trips",
      body: "- Went to the beach in July.\n",
    };
    const parsed = parseTopicFile(serializeTopicFile(topic, topic.body));
    expect(parsed).toEqual({ ok: true, topic });
  });

  it("accepts a zh (Chinese) body", () => {
    const topic: TopicFile = {
      name: "zh-topic",
      description: "A topic with a Chinese body",
      body: "第一步：做饭。第二步：吃饭。",
    };
    const parsed = parseTopicFile(serializeTopicFile(topic, topic.body));
    expect(parsed).toEqual({ ok: true, topic });
  });

  it("rejects a slug with path traversal characters (bad_name)", () => {
    const raw = serializeTopicFile({ name: "x", description: "d" }, "body").replace(
      "name: x",
      "name: ../../etc/passwd",
    );
    const parsed = parseTopicFile(raw);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "bad_name", name: "../../etc/passwd" } });
  });

  it("rejects a slug with uppercase/spaces (bad_name)", () => {
    const raw = serializeTopicFile({ name: "x", description: "d" }, "body").replace("name: x", "name: My Topic");
    const parsed = parseTopicFile(raw);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "bad_name", name: "My Topic" } });
  });

  it("rejects invisible characters in the body fail-closed", () => {
    const raw = serializeTopicFile({ name: "x", description: "d" }, "do​thing");
    expect(parseTopicFile(raw)).toMatchObject({
      ok: false,
      error: { kind: "invisible_chars", count: 1 },
    });
  });

  it("counts multiple invisible characters", () => {
    const raw = serializeTopicFile({ name: "x", description: "d" }, "a​b⁠c﻿");
    expect(parseTopicFile(raw)).toMatchObject({
      ok: false,
      error: { kind: "invisible_chars", count: 3 },
    });
  });

  it("rejects content missing the frontmatter fence", () => {
    const parsed = parseTopicFile("just some body text, no frontmatter at all");
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects unclosed frontmatter fence", () => {
    const parsed = parseTopicFile("---\nname: x\ndescription: d\n");
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects frontmatter that is not valid YAML", () => {
    const raw = "---\nname: [unterminated\n---\nbody\n";
    const parsed = parseTopicFile(raw);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });

  it("rejects frontmatter missing required fields", () => {
    const raw = "---\nname: x\n---\nbody\n";
    const parsed = parseTopicFile(raw);
    expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed_frontmatter" } });
  });
});

describe("serializeTopicFile", () => {
  it("produces a frontmatter fence followed by the body", () => {
    const raw = serializeTopicFile({ name: "x", description: "d" }, "body text");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("name: x");
    expect(raw).toContain("description: d");
    expect(raw.endsWith("body text")).toBe(true);
  });
});

describe("countUsage", () => {
  it("counts lines and chars for a simple text", () => {
    expect(countUsage("a\nb\nc")).toEqual({ lines: 3, chars: 5 });
  });

  it("counts a single-line text as 1 line", () => {
    expect(countUsage("hello")).toEqual({ lines: 1, chars: 5 });
  });

  it("counts an empty string as 1 line, 0 chars", () => {
    expect(countUsage("")).toEqual({ lines: 1, chars: 0 });
  });
});

describe("validateMemoryText", () => {
  const opts = { maxLines: 3, maxChars: 20 };

  it("accepts text exactly at the line cap boundary", () => {
    const text = "line1\nline2\nline3";
    expect(countUsage(text).lines).toBe(3);
    expect(validateMemoryText(text, opts)).toEqual({ ok: true });
  });

  it("rejects text one line over the cap boundary", () => {
    const text = "line1\nline2\nline3\nline4";
    const usage = countUsage(text);
    expect(usage.lines).toBe(4);
    expect(validateMemoryText(text, opts)).toEqual({
      ok: false,
      error: "cap_lines",
      lines: usage.lines,
      chars: usage.chars,
    });
  });

  it("accepts text exactly at the char cap boundary", () => {
    const text = "a".repeat(20);
    expect(text.length).toBe(20);
    expect(validateMemoryText(text, { maxLines: 100, maxChars: 20 })).toEqual({ ok: true });
  });

  it("rejects text one char over the cap boundary", () => {
    const text = "a".repeat(21);
    expect(validateMemoryText(text, { maxLines: 100, maxChars: 20 })).toEqual({
      ok: false,
      error: "cap_chars",
      lines: 1,
      chars: 21,
    });
  });

  it("rejects invisible characters even under the caps", () => {
    const text = "ok​";
    expect(validateMemoryText(text, { maxLines: 100, maxChars: 100 })).toEqual({
      ok: false,
      error: "invisible_chars",
      lines: 1,
      chars: text.length,
    });
  });

  it("prioritizes cap_lines over cap_chars when both are exceeded", () => {
    const text = "a".repeat(30).split("").join("\n"); // 30 lines, way over both caps
    const usage = countUsage(text);
    expect(validateMemoryText(text, opts)).toEqual({
      ok: false,
      error: "cap_lines",
      lines: usage.lines,
      chars: usage.chars,
    });
  });
});
