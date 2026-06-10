import { describe, expect, it } from "vitest";
import { shouldAdmitSessionNew } from "./session-new-rate-limit.ts";

const MIN_INTERVAL = 500;

describe("shouldAdmitSessionNew", () => {
  it("admits the first frame when no prior session.new exists", () => {
    expect(shouldAdmitSessionNew(null, 1000, MIN_INTERVAL)).toBe(true);
  });

  it("rejects a second frame inside the min interval", () => {
    // Previous at t=1000, next at t=1499 → only 499ms elapsed (< 500).
    expect(shouldAdmitSessionNew(1000, 1499, MIN_INTERVAL)).toBe(false);
  });

  it("admits once exactly the min interval has elapsed", () => {
    // Boundary: now - last === minInterval admits.
    expect(shouldAdmitSessionNew(1000, 1500, MIN_INTERVAL)).toBe(true);
  });

  it("admits when well past the min interval", () => {
    expect(shouldAdmitSessionNew(1000, 5000, MIN_INTERVAL)).toBe(true);
  });
});
