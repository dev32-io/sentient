import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/components/chat/chat-messages.css"), "utf8");

describe("chat message responsive and motion contract", () => {
  it("bounds readable streaming width and preserves long content/code overflow", () => {
    expect(css).toContain("width: min(100%, 62ch)");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/\.bubble-text__md pre[\s\S]*overflow-x: auto/);
    expect(css).toContain("@media (max-width: 620px)");
  });

  it("removes nonessential native response motion for Reduced Motion", () => {
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".bubble-speaking-wave");
    expect(reducedMotion).toContain("animation: none");
    expect(reducedMotion).toContain(".bubble-text__caret { display: none; }");
  });

  it("uses v2 semantic materials instead of local foundation recipes", () => {
    expect(css).toContain("background: var(--slate-face)");
    expect(css).toContain("box-shadow: var(--plate-shadow)");
    expect(css).toContain("background: var(--well-face)");
    expect(css).toContain("box-shadow: var(--well-shadow)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\s*\(/i);
    expect(css).not.toMatch(/var\(--shadow-/);
    expect(css).not.toMatch(/border-radius\s*:\s*\d/);
    expect(css).not.toMatch(/(?:animation|transition)[^:]*:\s*[^;]*\b\d+(?:\.\d+)?(?:ms|s)\b/);
  });
});
