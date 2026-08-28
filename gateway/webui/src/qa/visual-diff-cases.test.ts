import { describe, expect, it } from "vitest";
import { actionButtonCase } from "./visual-diff-cases.ts";

describe("visual diff action-button cases", () => {
  it("maps both disabled handoff forms to the approved unavailable specimen", () => {
    expect(actionButtonCase("action-button--secondary--disabled")).toEqual({
      variant: "default",
      label: "Unavailable",
      disabled: true,
    });
    expect(actionButtonCase("action-button--secondary--compact-disabled")).toEqual({
      variant: "default",
      label: "Unavailable",
      disabled: true,
    });
  });
});
