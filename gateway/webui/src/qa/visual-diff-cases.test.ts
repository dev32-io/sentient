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

const CURRENT_ICON_BUTTON_CASES = [
  "icon-button--default--compact-disabled",
  "icon-button--default--compact-rest",
  "icon-button--default--disabled",
  "icon-button--default--focus",
  "icon-button--default--hover",
  "icon-button--default--pressed",
  "icon-button--default--rest",
  "icon-button--destructive--compact-rest",
  "icon-button--destructive--focus",
  "icon-button--destructive--hover",
  "icon-button--destructive--pressed",
  "icon-button--destructive--rest",
  "icon-button--quiet--compact-rest",
  "icon-button--quiet--focus",
  "icon-button--quiet--hover",
  "icon-button--quiet--pressed",
  "icon-button--quiet--rest",
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

  it("registers the exact icon-button matrix and production provenance", () => {
    const iconButton = visualDiffComponentRegistry["icon-button"];
    expect(iconButton.stateApplicability).toEqual({
      default: ["compact-disabled", "compact-rest", "disabled", "focus", "hover", "pressed", "rest"],
      quiet: ["compact-rest", "focus", "hover", "pressed", "rest"],
      destructive: ["compact-rest", "focus", "hover", "pressed", "rest"],
    });
    expect(iconButton.fixtureAdapterId).toBe("icon-button");
    expect(iconButton.productionComponent).toBe(
      "gateway/webui/src/components/common/foundation/buttons.tsx#FoundationIconButton",
    );
    expect(iconButton.authority).toBe("design/prototype/foundation-components/handoff/static");

    for (const caseId of CURRENT_ICON_BUTTON_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("icon-button");
        expect(resolution.case.fixtureAdapterId).toBe("icon-button");
      }
    }
  });

  it("keeps action-button's existing non-applicable state failure unsupported", () => {
    expect(resolveVisualDiffCase("action-button--primary--disabled")).toEqual({
      status: "unsupported",
      caseId: "action-button--primary--disabled",
      componentId: "action-button",
      variantId: "primary",
      stateId: "disabled",
      reason: "state",
    });
  });

  it("resolves unapproved icon-button states to missing authority", () => {
    for (const caseId of [
      "icon-button--default--selected",
      "icon-button--default--loading",
      "icon-button--default--error",
      "icon-button--quiet--disabled",
      "icon-button--destructive--disabled",
    ]) {
      const [componentId, variantId, stateId] = caseId.split("--");
      expect(resolveVisualDiffCase(caseId)).toEqual({
        status: "missing-authority",
        caseId,
        componentId,
        variantId,
        stateId,
      });
    }
  });

  it("keeps unknown variants, components, and malformed IDs typed", () => {
    expect(resolveVisualDiffCase("icon-button--primary--rest")).toEqual({
      status: "unsupported",
      caseId: "icon-button--primary--rest",
      componentId: "icon-button",
      variantId: "primary",
      stateId: "rest",
      reason: "variant",
    });
    expect(resolveVisualDiffCase("future-component--default--rest")).toEqual({
      status: "missing-authority",
      caseId: "future-component--default--rest",
      componentId: "future-component",
      variantId: "default",
      stateId: "rest",
    });

    for (const caseId of ["", "action-button", "action-button--default", "action-button--default--"]) {
      expect(resolveVisualDiffCase(caseId)).toEqual({ status: "missing-authority", caseId });
    }
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

  it("resolves unapproved plate interaction states to missing authority", () => {
    for (const stateId of [
      "disabled",
      "compact-disabled",
      "hover",
      "focus",
      "pressed",
      "selected",
      "elevated",
      "loading",
      "error",
    ]) {
      expect(resolveVisualDiffCase(`plate--default--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `plate--default--${stateId}`,
        componentId: "plate",
        variantId: "default",
        stateId,
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
