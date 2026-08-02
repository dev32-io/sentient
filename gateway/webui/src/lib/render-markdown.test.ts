// gateway/webui/src/lib/render-markdown.test.ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown.ts";

describe("renderMarkdown", () => {
  it("renders a bare numeric reply as visible text instead of an empty list", () => {
    // CommonMark quirk (task-21 extra defect): "84." alone is valid syntax
    // for a single EMPTY ordered-list item — <ol start="84"><li></li></ol>.
    // The digits become the list marker, the answer body vanishes, and the
    // user sees a blank bubble. Terse numeric answers are the common case
    // for this voice assistant ("what's the thermostat set to?" -> "84."),
    // so this must render the number, not nothing.
    const html = renderMarkdown("84.");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("<li></li>");
    expect(html).toContain("84.");
  });

  it("renders other bare list markers (dash, asterisk, paren-numbered) as visible text", () => {
    expect(renderMarkdown("-")).not.toMatch(/<li>\s*<\/li>/);
    expect(renderMarkdown("*")).not.toMatch(/<li>\s*<\/li>/);
    expect(renderMarkdown("1)")).not.toMatch(/<li>\s*<\/li>/);
  });

  it("still renders a genuine ordered list with real items", () => {
    const html = renderMarkdown("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("still renders a genuine unordered list with real items", () => {
    const html = renderMarkdown("- first\n- second");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
  });

  it("renders a decimal number as plain text, not a list", () => {
    // "84.5" was never at risk (no CommonMark list marker matches it), but
    // pin it anyway as the nearest neighbor to the bare-integer defect.
    const html = renderMarkdown("84.5");
    expect(html).not.toContain("<ol");
    expect(html).toContain("84.5");
  });
});
