import { describe, expect, it } from "bun:test";
import { capToolResult } from "./tool-result-cap.js";

// The marker itself adds characters on top of the head+tail budget, so a
// capped result is allowed to land a little OVER `limit` — this is the
// generous ceiling on that overshoot, not a config value.
const MARKER_SLACK = 300;

describe("capToolResult", () => {
  it("INVARIANT: an oversized tool result is truncated, and says so", () => {
    const out = capToolResult("x".repeat(50_000), { limit: 20_000 });
    expect(out.length).toBeLessThanOrEqual(20_000 + MARKER_SLACK);
    expect(out).toContain("truncated");
  });

  it("leaves a result at or under the limit completely unchanged", () => {
    const content = "y".repeat(20_000);
    expect(capToolResult(content, { limit: 20_000 })).toBe(content);

    const short = "small result";
    expect(capToolResult(short, { limit: 20_000 })).toBe(short);
  });

  it("HEAD-AND-TAIL: keeps content from both the start and the end, not just the head", () => {
    // History/log-shaped data carries meaning at both ends — a head-only cap
    // would silently discard whatever is newest.
    const content = `${"START".repeat(1000)}MIDDLE${"END".repeat(1000)}`;
    const out = capToolResult(content, { limit: 2_000 });
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
    expect(out).not.toContain("MIDDLE");
  });

  it("the marker names roughly how much was cut, so the model can narrow its query", () => {
    const original = "z".repeat(50_000);
    const out = capToolResult(original, { limit: 20_000 });
    // The omitted-character count and the original size are both surfaced —
    // a bare "truncated" with no numbers gives the model nothing to act on.
    expect(out).toMatch(/\d+ of 50000 characters/);
  });
});
