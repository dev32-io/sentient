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

const CURRENT_USER_AVATAR_CASES = [
  "user-avatar--terra-28--rest",
  "user-avatar--terra-44--rest",
  "user-avatar--terra-56--rest",
  "user-avatar--sage-44--rest",
  "user-avatar--amber-44--rest",
  "user-avatar--clay-44--rest",
  "user-avatar--fallback-44--rest",
  "user-avatar--terra-44--selected",
  "user-avatar--terra-44--disabled",
] as const;

const CURRENT_TEXT_FIELD_CASES = [
  "text-field--filled--focus",
  "text-field--filled--hover",
  "text-field--filled--rest",
] as const;

const CURRENT_SEARCH_FIELD_CASES = [
  "search-field--placeholder--focus",
  "search-field--placeholder--hover",
  "search-field--placeholder--rest",
] as const;

const CURRENT_TEXT_AREA_CASES = [
  "text-area--filled--focus",
  "text-area--filled--hover",
  "text-area--filled--rest",
] as const;

const CURRENT_RANGE_CASES = ["range--62--disabled", "range--62--focus", "range--62--hover", "range--62--rest"] as const;

const CURRENT_CHECKBOX_CASES = [
  "checkbox--checked--focus",
  "checkbox--checked--hover",
  "checkbox--checked--pressed",
  "checkbox--checked--rest",
  "checkbox--disabled--rest",
  "checkbox--mixed--focus",
  "checkbox--mixed--hover",
  "checkbox--mixed--pressed",
  "checkbox--mixed--rest",
  "checkbox--unchecked--focus",
  "checkbox--unchecked--hover",
  "checkbox--unchecked--pressed",
  "checkbox--unchecked--rest",
] as const;

const CURRENT_CHIP_CASES = [
  "chip--selected--compact-rest",
  "chip--selected--focus",
  "chip--selected--hover",
  "chip--selected--pressed",
  "chip--selected--rest",
  "chip--unselected--compact-rest",
  "chip--unselected--focus",
  "chip--unselected--hover",
  "chip--unselected--pressed",
  "chip--unselected--rest",
] as const;

const CHIP_TRANSITION_CASES = [
  "chip--unselected-to-selected--frame-000--0000ms",
  "chip--unselected-to-selected--frame-001--0040ms",
  "chip--unselected-to-selected--frame-002--0080ms",
  "chip--unselected-to-selected--frame-003--0120ms",
  "chip--unselected-to-selected--frame-004--0150ms",
] as const;

const CURRENT_TOGGLE_CASES = [
  "toggle--off--focus",
  "toggle--off--hover",
  "toggle--off--pressed",
  "toggle--off--rest",
  "toggle--on--focus",
  "toggle--on--hover",
  "toggle--on--pressed",
  "toggle--on--rest",
] as const;

const TOGGLE_TRANSITION_CASES = [
  "toggle--off-to-on--frame-000--0000ms",
  "toggle--off-to-on--frame-001--0050ms",
  "toggle--off-to-on--frame-002--0100ms",
  "toggle--off-to-on--frame-003--0150ms",
  "toggle--off-to-on--frame-004--0200ms",
] as const;

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

  it("registers the exact user-avatar matrix and canonical Avatar provenance", () => {
    const userAvatar = visualDiffComponentRegistry["user-avatar"];
    expect(userAvatar.stateApplicability).toEqual({
      "terra-28": ["rest"],
      "terra-44": ["disabled", "rest", "selected"],
      "terra-56": ["rest"],
      "sage-44": ["rest"],
      "amber-44": ["rest"],
      "clay-44": ["rest"],
      "fallback-44": ["rest"],
    });
    expect(userAvatar.fixtureAdapterId).toBe("user-avatar");
    expect(userAvatar.productionComponent).toBe("gateway/webui/src/components/common/avatar.tsx#Avatar");
    expect(userAvatar.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(userAvatar.variants["terra-28"].props).toEqual({ initial: "M", name: "Maya Chen", size: "sm" });
    expect(userAvatar.variants["sage-44"].props).toEqual({ initial: "A", name: "Alex Chen", tint: "sage", size: "lg" });
    expect(userAvatar.variants["fallback-44"].props).toEqual({ name: "Unknown user", size: "lg" });

    for (const caseId of CURRENT_USER_AVATAR_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("user-avatar");
        expect(resolution.case.fixtureAdapterId).toBe("user-avatar");
      }
    }
  });

  it("resolves unapproved user-avatar states to missing authority", () => {
    for (const stateId of [
      "image-loading",
      "crop",
      "privacy",
      "failure",
      "loading",
      "error",
      "hover",
      "focus",
      "pressed",
    ]) {
      expect(resolveVisualDiffCase(`user-avatar--terra-44--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `user-avatar--terra-44--${stateId}`,
        componentId: "user-avatar",
        variantId: "terra-44",
        stateId,
      });
    }
  });

  it("registers the exact text-field matrix and canonical Field provenance", () => {
    const textField = visualDiffComponentRegistry["text-field"];
    expect(textField.stateApplicability).toEqual({
      filled: ["focus", "hover", "rest"],
    });
    expect(textField.fixtureAdapterId).toBe("text-field");
    expect(textField.productionComponent).toBe("gateway/webui/src/components/common/foundation/fields.tsx#Field");
    expect(textField.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(textField.variants.filled.props).toEqual({ label: "Display name", value: "Maya Chen" });

    for (const caseId of CURRENT_TEXT_FIELD_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("text-field");
        expect(resolution.case.fixtureAdapterId).toBe("text-field");
        expect(resolution.case.props).toEqual({ label: "Display name", value: "Maya Chen" });
      }
    }
  });

  it("resolves unapproved text-field states to missing authority", () => {
    for (const stateId of ["empty", "error", "disabled", "loading", "pressed", "selected"]) {
      expect(resolveVisualDiffCase(`text-field--filled--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `text-field--filled--${stateId}`,
        componentId: "text-field",
        variantId: "filled",
        stateId,
      });
    }
  });

  it("registers search-field as the labelled generic Field alias", () => {
    const searchField = visualDiffComponentRegistry["search-field"];
    expect(searchField.stateApplicability).toEqual({
      placeholder: ["focus", "hover", "rest"],
    });
    expect(searchField.fixtureAdapterId).toBe("search-field");
    expect(searchField.productionComponent).toBe("gateway/webui/src/components/common/foundation/fields.tsx#Field");
    expect(searchField.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(searchField.variants.placeholder.props).toEqual({
      label: "Search",
      placeholder: "Search conversations",
      value: "",
    });

    for (const caseId of CURRENT_SEARCH_FIELD_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("search-field");
        expect(resolution.case.fixtureAdapterId).toBe("search-field");
        expect(resolution.case.props).toEqual(searchField.variants.placeholder.props);
      }
    }
  });

  it("resolves unapproved search-field states to missing authority", () => {
    for (const stateId of [
      "filled",
      "disabled",
      "error",
      "clear",
      "reduced-motion",
      "loading",
      "pressed",
      "selected",
    ]) {
      expect(resolveVisualDiffCase(`search-field--placeholder--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `search-field--placeholder--${stateId}`,
        componentId: "search-field",
        variantId: "placeholder",
        stateId,
      });
    }
  });

  it("registers the exact text-area matrix and canonical TextArea provenance", () => {
    const textArea = visualDiffComponentRegistry["text-area"];
    expect(textArea.stateApplicability).toEqual({
      filled: ["focus", "hover", "rest"],
    });
    expect(textArea.fixtureAdapterId).toBe("text-area");
    expect(textArea.productionComponent).toBe("gateway/webui/src/components/common/foundation/fields.tsx#TextArea");
    expect(textArea.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(textArea.variants.filled.props).toEqual({ label: "Description", value: "Add supporting details." });

    for (const caseId of CURRENT_TEXT_AREA_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("text-area");
        expect(resolution.case.fixtureAdapterId).toBe("text-area");
        expect(resolution.case.props).toEqual({ label: "Description", value: "Add supporting details." });
      }
    }
  });

  it("resolves unapproved text-area states to missing authority", () => {
    for (const stateId of [
      "empty",
      "placeholder",
      "error",
      "disabled",
      "dirty",
      "mono",
      "loading",
      "pressed",
      "selected",
    ]) {
      expect(resolveVisualDiffCase(`text-area--filled--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `text-area--filled--${stateId}`,
        componentId: "text-area",
        variantId: "filled",
        stateId,
      });
    }
  });

  it("registers the exact range matrix and native SliderControl provenance", () => {
    const range = visualDiffComponentRegistry.range;
    expect(range.stateApplicability).toEqual({
      "62": ["disabled", "focus", "hover", "rest"],
    });
    expect(range.fixtureAdapterId).toBe("range");
    expect(range.productionComponent).toBe("gateway/webui/src/components/common/foundation/controls.tsx#SliderControl");
    expect(range.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(range.variants["62"].props).toEqual({
      label: "Interface scale",
      value: 62,
      min: 0,
      max: 100,
      step: 1,
    });

    for (const caseId of CURRENT_RANGE_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("range");
        expect(resolution.case.fixtureAdapterId).toBe("range");
        expect(resolution.case.props).toEqual(range.variants["62"].props);
      }
    }
  });

  it("resolves unapproved range states to missing authority", () => {
    for (const stateId of ["pressed", "loading", "error", "motion", "selected"]) {
      expect(resolveVisualDiffCase(`range--62--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `range--62--${stateId}`,
        componentId: "range",
        variantId: "62",
        stateId,
      });
    }
  });

  it("registers the exact chip matrix and controlled native production provenance", () => {
    const chip = visualDiffComponentRegistry.chip;
    expect(chip.stateApplicability).toEqual({
      unselected: ["compact-rest", "focus", "hover", "pressed", "rest"],
      selected: ["compact-rest", "focus", "hover", "pressed", "rest"],
      "unselected-to-selected": [
        "frame-000--0000ms",
        "frame-001--0040ms",
        "frame-002--0080ms",
        "frame-003--0120ms",
        "frame-004--0150ms",
      ],
    });
    expect(chip.fixtureAdapterId).toBe("chip");
    expect(chip.productionComponent).toBe("gateway/webui/src/components/common/foundation/controls.tsx#ChipControl");
    expect(chip.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(chip.variants.unselected.props).toEqual({ label: "School", selected: false });
    expect(chip.variants.selected.props).toEqual({ label: "Family", selected: true });
    expect(chip.variants["unselected-to-selected"].props).toEqual({ label: "School", selected: false });

    for (const caseId of [...CURRENT_CHIP_CASES, ...CHIP_TRANSITION_CASES]) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("chip");
        expect(resolution.case.fixtureAdapterId).toBe("chip");
      }
    }
  });

  it("resolves unapproved chip states to missing authority", () => {
    for (const stateId of ["disabled", "selected", "loading", "error"]) {
      expect(resolveVisualDiffCase(`chip--unselected--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `chip--unselected--${stateId}`,
        componentId: "chip",
        variantId: "unselected",
        stateId,
      });
    }
  });

  it("registers the exact toggle matrix and controlled native production provenance", () => {
    const toggle = visualDiffComponentRegistry.toggle;
    expect(toggle.stateApplicability).toEqual({
      off: ["focus", "hover", "pressed", "rest"],
      on: ["focus", "hover", "pressed", "rest"],
      "off-to-on": [
        "frame-000--0000ms",
        "frame-001--0050ms",
        "frame-002--0100ms",
        "frame-003--0150ms",
        "frame-004--0200ms",
      ],
    });
    expect(toggle.fixtureAdapterId).toBe("toggle");
    expect(toggle.productionComponent).toBe(
      "gateway/webui/src/components/common/foundation/controls.tsx#ToggleControl",
    );
    expect(toggle.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(toggle.variants.off.props).toEqual({ label: "Automatic updates", checked: false });
    expect(toggle.variants.on.props).toEqual({ label: "Automatic updates", checked: true });
    expect(toggle.variants["off-to-on"].props).toEqual({ label: "Automatic updates", checked: false });

    for (const caseId of [...CURRENT_TOGGLE_CASES, ...TOGGLE_TRANSITION_CASES]) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("toggle");
        expect(resolution.case.fixtureAdapterId).toBe("toggle");
      }
    }
  });

  it("resolves unapproved toggle states to missing authority", () => {
    for (const variantId of ["off", "on"]) {
      for (const stateId of ["compact-rest", "disabled", "selected", "loading", "error"]) {
        expect(resolveVisualDiffCase(`toggle--${variantId}--${stateId}`)).toEqual({
          status: "missing-authority",
          caseId: `toggle--${variantId}--${stateId}`,
          componentId: "toggle",
          variantId,
          stateId,
        });
      }
    }
  });

  it("registers the exact checkbox matrix and native production provenance", () => {
    const checkbox = visualDiffComponentRegistry.checkbox;
    expect(checkbox.stateApplicability).toEqual({
      unchecked: ["focus", "hover", "pressed", "rest"],
      checked: ["focus", "hover", "pressed", "rest"],
      mixed: ["focus", "hover", "pressed", "rest"],
      disabled: ["rest"],
      "unchecked-to-checked": [
        "frame-000--0000ms",
        "frame-001--0050ms",
        "frame-002--0100ms",
        "frame-003--0150ms",
        "frame-004--0250ms",
      ],
      "unchecked-to-mixed": [
        "frame-000--0000ms",
        "frame-001--0050ms",
        "frame-002--0100ms",
        "frame-003--0150ms",
        "frame-004--0250ms",
      ],
    });
    expect(checkbox.fixtureAdapterId).toBe("checkbox");
    expect(checkbox.productionComponent).toBe(
      "gateway/webui/src/components/common/foundation/selection.tsx#CheckboxControl",
    );
    expect(checkbox.authority).toBe("design/prototype/foundation-components/handoff/static");
    expect(checkbox.variants.mixed.props).toEqual({ label: "Mixed", checked: false, indeterminate: true });

    for (const caseId of CURRENT_CHECKBOX_CASES) {
      const resolution = resolveVisualDiffCase(caseId);
      expect(resolution.status).toBe("ready");
      if (resolution.status === "ready") {
        expect(resolution.case.componentId).toBe("checkbox");
        expect(resolution.case.fixtureAdapterId).toBe("checkbox");
      }
    }
  });

  it("resolves every approved checkbox recording frame", () => {
    for (const variantId of ["unchecked-to-checked", "unchecked-to-mixed"]) {
      for (const stateId of [
        "frame-000--0000ms",
        "frame-001--0050ms",
        "frame-002--0100ms",
        "frame-003--0150ms",
        "frame-004--0250ms",
      ]) {
        const resolution = resolveVisualDiffCase(`checkbox--${variantId}--${stateId}`);
        expect(resolution.status).toBe("ready");
        if (resolution.status === "ready") {
          expect(resolution.case.variantId).toBe(variantId);
          expect(resolution.case.stateId).toBe(stateId);
        }
      }
    }
  });

  it("resolves unapproved checkbox states to missing authority", () => {
    for (const stateId of ["compact-rest", "hover", "focus", "pressed", "disabled", "selected", "loading", "error"]) {
      expect(resolveVisualDiffCase(`checkbox--disabled--${stateId}`)).toEqual({
        status: "missing-authority",
        caseId: `checkbox--disabled--${stateId}`,
        componentId: "checkbox",
        variantId: "disabled",
        stateId,
      });
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
