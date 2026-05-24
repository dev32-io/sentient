import { describe, expect, it } from "vitest";
import { renderPauses } from "./pause-renderer.ts";

describe("renderPauses — english", () => {
  it("renders a single pause", () => {
    expect(renderPauses("hi [pause.0] there", [1200], "en")).toBe("hi [paused 1.2s] there");
  });

  it("renders multiple pauses in order", () => {
    const text = "a [pause.0] b [pause.1] c";
    expect(renderPauses(text, [1234, 876], "en")).toBe("a [paused 1.2s] b [paused 0.9s] c");
  });

  it("returns text unchanged when no pauses", () => {
    expect(renderPauses("plain text", [], "en")).toBe("plain text");
  });

  it("rounds to whole seconds when >= 10s", () => {
    expect(renderPauses("x [pause.0] y", [12_340], "en")).toBe("x [paused 12s] y");
  });

  it("clamps very short pauses to 0.1s", () => {
    expect(renderPauses("x [pause.0] y", [40], "en")).toBe("x [paused 0.1s] y");
  });
});

describe("renderPauses — chinese", () => {
  it("uses zh template", () => {
    expect(renderPauses("你好 [pause.0] 世界", [1200], "zh")).toBe("你好 [停顿 1.2秒] 世界");
  });
});

describe("renderPauses — contract-violation tolerance", () => {
  it("replaces what it can when pauses array is shorter", () => {
    const text = "a [pause.0] b [pause.1] c";
    expect(renderPauses(text, [1000], "en")).toBe("a [paused 1.0s] b [pause.1] c");
  });

  it("ignores extra pauses when array is longer", () => {
    const text = "a [pause.0] b";
    expect(renderPauses(text, [1000, 2000], "en")).toBe("a [paused 1.0s] b");
  });
});
