// gateway/webui/src/lib/render-markdown.test.ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown.ts";

describe("renderMarkdown", () => {
  it("retains GFM headers and rectangular table structure without admitting active attributes", () => {
    const html = renderMarkdown("| Name | Value |\n| --- | --- |\n| Alpha | 42 |\n| Beta | 7 | ");
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelectorAll("thead tr th")).toHaveLength(2);
    expect(root.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelectorAll("tbody tr td")).toHaveLength(4);
    const hostile = renderMarkdown(
      '<table onclick="bad()"><tr><th style="background:url(https://tracker.invalid)">Safe</th><td><svg onload="bad()"></svg><iframe src="https://tracker.invalid"></iframe></td></tr></table>',
    );
    expect(hostile).toContain("Safe");
    expect(hostile).not.toMatch(/onclick|style=|svg|iframe|tracker/);
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>bad()</script>", "vbscript:bad()"])(
    "rejects malicious link URL %s",
    (url) => {
      expect(renderMarkdown(`<a href="${url}" onmouseover="bad()">link</a>`)).not.toMatch(/href=|onmouseover/);
    },
  );

  it("never fetches Markdown image URLs; only caller-authorized attachment previews become local images", () => {
    const path = "/api/v1/attachments/att_fixture/preview";
    const images = new Map([[path, "blob:http://localhost/owned-preview"]]);
    const html = renderMarkdown(`![Accessible café](${path})`, images);
    expect(html).toContain('src="blob:http://localhost/owned-preview"');
    expect(html).toContain('alt="Accessible café"');
    expect(html).toContain('width="640" height="360"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    for (const url of [
      "https://tracker.invalid/pixel",
      "//tracker.invalid/pixel",
      "/private.png",
      "blob:http://localhost/unowned",
      "data:image/svg+xml,evil",
      "javascript:alert(1)",
    ]) {
      expect(
        renderMarkdown(`<img src="${url}" alt="Fallback" onerror="bad()" srcset="https://tracker.invalid 2x">`, images),
      ).toBe("Fallback");
    }
    expect(renderMarkdown(`![Fallback](${path})`)).toContain("Fallback");
    expect(renderMarkdown(`![Fallback](${path})`)).not.toContain("<img");
    expect(renderMarkdown(`![Fallback](${path})`, new Map([[path, "https://tracker.invalid/pixel"]]))).not.toContain(
      "<img",
    );
  });
  describe("a bare list marker alone", () => {
    it("renders a bare numeric marker as visible text instead of an empty ordered list", () => {
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

    it.each([
      ["dash", "-"],
      ["asterisk", "*"],
      ["paren-numbered", "1)"],
    ])("renders a bare %s marker as visible text instead of an empty list item", (_label, marker) => {
      const html = renderMarkdown(marker);
      expect(html).not.toMatch(/<li>\s*<\/li>/);
      expect(html).toContain(marker);
    });
  });

  describe("a bare marker CommonMark merges into one list token with a genuine list", () => {
    // Code-review finding: the original guard bailed on `items.length !== 1`,
    // so it never rescued these — a bare marker immediately followed by a
    // real list of the same marker type is not two tokens, it's one merged
    // "list" token, and the bare item stayed silently empty.

    it("rescues a bare marker separated from a real ordered list by a blank line, rendering BOTH", () => {
      const html = renderMarkdown("84.\n\n1. check the batteries\n2. check the wifi\n");
      expect(html).not.toContain("<li></li>");
      expect(html).toContain("84.");
      expect(html).toContain("check the batteries");
      expect(html).toContain("check the wifi");
    });

    it("rescues a bare marker separated from a real ordered list by a single newline, rendering BOTH", () => {
      const html = renderMarkdown("84.\n1. real item");
      expect(html).not.toContain("<li></li>");
      expect(html).toContain("84.");
      expect(html).toContain("real item");
    });

    it("rescues two consecutive bare markers, both visible", () => {
      const html = renderMarkdown("84.\n\n85.\n");
      expect(html).not.toContain("<li></li>");
      expect(html).toContain("84.");
      expect(html).toContain("85.");
    });
  });

  describe("genuine lists are unaffected", () => {
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
  });

  it("does not get stuck mid-stream on a partial digit that could become a marker", () => {
    // Streaming re-renders on every delta; a lone "8" must render as plain
    // text (it is, trivially — marked never treats a single digit alone as
    // a list marker), and must not get wedged once more characters arrive.
    expect(renderMarkdown("8")).toContain("8");
    expect(renderMarkdown("84.5 degrees")).toContain("84.5 degrees");
  });

  it("renders a decimal number as plain text, not a list", () => {
    // "84.5" was never at risk (no CommonMark list marker matches it), but
    // pin it anyway as the nearest neighbor to the bare-integer defect.
    const html = renderMarkdown("84.5");
    expect(html).not.toContain("<ol");
    expect(html).toContain("84.5");
  });
});
