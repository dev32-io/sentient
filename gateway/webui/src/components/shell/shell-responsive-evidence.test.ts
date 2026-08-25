import { describe, expect, it } from "vitest";
import { measureShellResponsiveEvidence } from "./shell-responsive-evidence.ts";

function setViewport(width: number, height: number, scrollWidth = width): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(document.documentElement, "scrollWidth", { configurable: true, value: scrollWidth });
}

describe("shell responsive evidence", () => {
  it.each([
    [1280, 900],
    [390, 844],
  ])("reports overflow-safe shell fixtures at %d×%d", (width, height) => {
    setViewport(width, height);
    document.body.innerHTML = '<div data-app-shell><button type="button">Chat</button></div>';
    const button = document.querySelector("button") as HTMLButtonElement;
    button.getClientRects = () => [{ width: 44, height: 44 }] as unknown as DOMRectList;
    button.getBoundingClientRect = () => ({ width: 44, height: 44 }) as DOMRect;
    const evidence = measureShellResponsiveEvidence(document);
    expect(evidence.viewport).toEqual({ width, height });
    expect(evidence.noHorizontalOverflow).toBe(true);
    expect(evidence.minimumInteractiveTarget).toEqual({ width: 44, height: 44 });
  });

  it("observes 200% root text scaling without changing shell state", () => {
    setViewport(390, 844);
    document.documentElement.style.fontSize = "32px";
    expect(measureShellResponsiveEvidence(document).textScale).toBe(2);
    document.documentElement.style.fontSize = "";
  });
});
