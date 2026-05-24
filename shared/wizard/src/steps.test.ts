import { describe, expect, it } from "vitest";
import { VALID_FORWARD, VALID_REVERSE, WIZARD_STEPS, type WizardStepId } from "./steps.ts";

describe("WIZARD_STEPS", () => {
  it("has exactly six steps in order: provider, voice, secrets, bringup, admin, finish", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["provider", "voice", "secrets", "bringup", "admin", "finish"]);
  });

  it("every advanceTo points at a valid step id (or null for terminal)", () => {
    const ids = new Set<WizardStepId>(WIZARD_STEPS.map((s) => s.id));
    for (const s of WIZARD_STEPS) {
      if (s.advanceTo === null) continue;
      expect(ids.has(s.advanceTo)).toBe(true);
    }
  });

  it("VALID_FORWARD covers each non-terminal step's advance pair", () => {
    expect(VALID_FORWARD.has("provider→voice")).toBe(true);
    expect(VALID_FORWARD.has("voice→secrets")).toBe(true);
    expect(VALID_FORWARD.has("secrets→bringup")).toBe(true);
    expect(VALID_FORWARD.has("bringup→admin")).toBe(true);
    expect(VALID_FORWARD.has("admin→finish")).toBe(true);
    expect(VALID_FORWARD.size).toBe(5);
  });

  it("VALID_REVERSE only covers steps with explicit backTo", () => {
    expect(VALID_REVERSE.has("voice→provider")).toBe(true);
    expect(VALID_REVERSE.has("secrets→voice")).toBe(true);
    expect(VALID_REVERSE.size).toBe(2);
  });

  it("terminal step has advanceTo=null", () => {
    const finish = WIZARD_STEPS.find((s) => s.id === "finish");
    expect(finish?.advanceTo).toBeNull();
  });
});
