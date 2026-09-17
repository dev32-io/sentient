import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/components/chat/chat-messages.css"), "utf8");

describe("chat message responsive and motion contract", () => {
  it("bounds readable streaming width and keeps only measured/owned bottom clearance", () => {
    expect(css).toContain("width: min(100%, 62ch)");
    expect(css).toMatch(/padding-bottom:\s*calc\(\s*var\(--chat-bottom-clear, 0px\) \+ var\(--chat-owned-tail, 0px\)/);
    expect(css).not.toContain("80dvh");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/\.bubble-text__md pre[\s\S]*overflow-x: auto/);
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).toMatch(/\.message-bubble__meta[\s\S]*padding: var\(--space-md\) var\(--space-md\) 0;/);
    expect(css).toMatch(
      /\.message-bubble__text-inner[\s\S]*padding: var\(--space-sm\) var\(--space-md\) var\(--space-md\);/,
    );
  });

  it("clips text effects while keeping swept face and contour cast unconstrained", () => {
    const activityRule = css.match(/\.message-bubble__activity \{([^}]*)\}/)?.[1];
    const surfaceRule = css.match(/\.message-bubble__surface \{([^}]*)\}/)?.[1];

    expect(activityRule).toContain("overflow: hidden");
    expect(surfaceRule).toContain("overflow: visible");
    expect(css).toContain('.message-bubble[data-message-state="thinking"] .message-bubble__surface-ember');
    expect(css).not.toContain("drop-shadow");
    expect(css).not.toContain("message-bubble__elevation");
  });

  it("removes nonessential native response motion for Reduced Motion", () => {
    const reducedMotion = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reducedMotion).toContain(".bubble-speaking-wave");
    expect(reducedMotion).toContain("animation: none");
    expect(reducedMotion).toMatch(/\.bubble-text__caret\s*\{\s*display: none;/);
  });

  it("uses v2 semantic materials instead of local foundation recipes", () => {
    expect(css).toContain("--slate-base: var(--color-paper)");
    expect(css).toContain("background: var(--well-face)");
    expect(css).toContain("box-shadow: var(--well-shadow)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\s*\(/i);
    expect(css).not.toMatch(/var\(--shadow-/);
    expect(css).not.toMatch(/border-radius\s*:\s*\d/);
    expect(css).not.toMatch(/(?:animation|transition)[^:]*:\s*[^;]*\b\d+(?:\.\d+)?(?:ms|s)\b/);
  });
});
