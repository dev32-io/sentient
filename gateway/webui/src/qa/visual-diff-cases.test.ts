import { describe, expect, it } from "vitest";
import { actionButtonCase, resolveVisualDiffCase, visualDiffComponentRegistry } from "./visual-diff-cases.ts";

const CURRENT_ACTION_BUTTON_CASES = [
  "action-button--destructive--compact-rest",
  "action-button--destructive--focus",
  "action-button--destructive--hover",
  "action-button--destructive--pressed",
  "action-button--destructive--rest",
  "action-button--primary--compact-rest",
  "action-button--primary--focus",
  "action-button--primary--hover",
  "action-button--primary--pressed",
  "action-button--primary--rest",
  "action-button--quiet--compact-rest",
  "action-button--quiet--focus",
  "action-button--quiet--hover",
  "action-button--quiet--pressed",
  "action-button--quiet--rest",
  "action-button--secondary--compact-disabled",
  "action-button--secondary--compact-rest",
  "action-button--secondary--disabled",
  "action-button--secondary--focus",
  "action-button--secondary--hover",
  "action-button--secondary--pressed",
  "action-button--secondary--rest",
] as const;

const CURRENT_PLATE_CASES = ["plate--default--compact-rest", "plate--default--rest"] as const;

describe("visual diff component cases", () => {
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

  it("keeps every current handoff case on the compatibility lookup", () => {
    for (const caseId of CURRENT_ACTION_BUTTON_CASES) {
      expect(resolveVisualDiffCase(caseId).status).toBe("ready");
      expect(actionButtonCase(caseId)).toBeDefined();
    }
  });

  it("records explicit per-variant state applicability and production provenance", () => {
    const actionButton = visualDiffComponentRegistry["action-button"];
    expect(actionButton.stateApplicability).toEqual({
      primary: ["compact-rest", "focus", "hover", "pressed", "rest"],
      secondary: ["compact-disabled", "compact-rest", "disabled", "focus", "hover", "pressed", "rest"],
      quiet: ["compact-rest", "focus", "hover", "pressed", "rest"],
      destructive: ["compact-rest", "focus", "hover", "pressed", "rest"],
    });
    expect(actionButton.fixtureAdapterId).toBe("action-button");
    expect(actionButton.productionComponent).toBe("gateway/webui/src/components/common/foundation.tsx#ActionButton");
  });

  it("returns typed failures instead of inventing an unapproved fixture", () => {
    expect(resolveVisualDiffCase("action-button--primary--disabled")).toEqual({
      status: "unsupported",
      caseId: "action-button--primary--disabled",
      componentId: "action-button",
      variantId: "primary",
      stateId: "disabled",
      reason: "state",
    });
    expect(resolveVisualDiffCase("icon-button--default--rest")).toEqual({
      status: "missing-authority",
      caseId: "icon-button--default--rest",
      componentId: "icon-button",
      variantId: "default",
      stateId: "rest",
    });
  });

  it("registers only the approved plate rest cases and production provenance", () => {
    const plate = visualDiffComponentRegistry.plate;
    expect(plate.fixtureAdapterId).toBe("plate");
    expect(plate.productionComponent).toBe("gateway/webui/src/components/common/foundation/surfaces.tsx#Plate");
    expect(plate.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(plate.stateApplicability).toEqual({ default: ["compact-rest", "rest"] });

    for (const caseId of CURRENT_PLATE_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("plate");
        expect(resolution.case.fixtureAdapterId).toBe("plate");
        expect(resolution.case.props).toEqual({ variant: "default" });
      }
    }
  });

  it("keeps unapproved plate interaction states unsupported", () => {
    for (const stateId of ["hover", "focus", "pressed", "selected", "elevated", "loading", "error"]) {
      expect(resolveVisualDiffCase(`plate--default--${stateId}`)).toEqual({
        status: "unsupported",
        caseId: `plate--default--${stateId}`,
        componentId: "plate",
        variantId: "default",
        stateId,
        reason: "state",
      });
    }
  });

  it("does not resolve inherited registry keys", () => {
    for (const variantId of ["__proto__", "constructor", "toString"]) {
      const caseId = `action-button--${variantId}--rest`;
      expect(resolveVisualDiffCase(caseId)).toEqual({
        status: "unsupported",
        caseId,
        componentId: "action-button",
        variantId,
        stateId: "rest",
        reason: "variant",
      });
      expect(actionButtonCase(caseId)).toBeUndefined();
    }

    for (const componentId of ["__proto__", "constructor", "toString"]) {
      const caseId = `${componentId}--default--rest`;
      expect(resolveVisualDiffCase(caseId)).toEqual({
        status: "missing-authority",
        caseId,
        componentId,
        variantId: "default",
        stateId: "rest",
      });
    }
  });
});
