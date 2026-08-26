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
});
