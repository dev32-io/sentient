import { describe, expect, it } from "vitest";
import { createSalienceMap } from "./salience-map.js";

const entries = {
  "user.speech.final": { speak: 85 },
  "user.speech.start": { speak: 0, "*cancel*": 100 },
  "user.text.input": { speak: 85 },
};

describe("SalienceMap", () => {
  it("returns per-effect salience for known event kind", () => {
    const map = createSalienceMap(entries);
    expect(map.lookup("user.speech.final")).toEqual({ speak: 85 });
  });

  it("returns empty object for unknown event kind", () => {
    const map = createSalienceMap(entries);
    expect(map.lookup("sensor.motion.enter")).toEqual({});
  });

  it("returns cancel salience for speech start", () => {
    const map = createSalienceMap(entries);
    const result = map.lookup("user.speech.start");
    expect(result["*cancel*"]).toBe(100);
    expect(result.speak).toBe(0);
  });

  it("returns frozen objects (immutable)", () => {
    const map = createSalienceMap(entries);
    const result = map.lookup("user.speech.final");
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: testing mutation guard on frozen object
      (result as any).speak = 999;
    }).toThrow();
  });
});
