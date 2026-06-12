import { describe, expect, it } from "vitest";
import { type ActivitySource, createActivityClock } from "./activity-clock.js";

describe("ActivityClock", () => {
  it("starts warm at construction time", () => {
    let t = 1_000;
    const clock = createActivityClock(() => t);
    t = 1_500;
    expect(clock.idleMs(t)).toBe(500);
  });

  it("resets idle on any touch", () => {
    let t = 1_000;
    const clock = createActivityClock(() => t);
    t = 5_000;
    clock.touch("acp.in");
    t = 5_200;
    expect(clock.idleMs(t)).toBe(200);
    expect(clock.lastActivityMs()).toBe(5_000);
  });

  it("treats all four sources identically", () => {
    let t = 0;
    const clock = createActivityClock(() => t);
    const sources: ActivitySource[] = ["ws.in", "ws.out", "acp.out", "acp.in"];
    for (const s of sources) {
      t += 100;
      clock.touch(s);
      expect(clock.idleMs(t)).toBe(0);
    }
  });
});
