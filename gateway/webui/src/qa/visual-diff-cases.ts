import type { IconName } from "../components/common/icon.tsx";

export interface ActionButtonCase {
  variant: "primary" | "default" | "quiet" | "destructive";
  label: string;
  disabled: boolean;
}

export type VisualDiffStateId = string;
export type VisualDiffCaseStatus = "ready" | "missing-authority" | "unsupported";

export interface VisualDiffVariantDefinition<TProps = unknown> {
  readonly props: TProps;
}

export interface VisualDiffComponentDefinition<
  TVariant extends VisualDiffVariantDefinition = VisualDiffVariantDefinition,
> {
  readonly id: string;
  readonly fixtureAdapterId: string;
  readonly productionComponent: string;
  readonly authority: string;
  readonly variants: Readonly<Record<string, TVariant>>;
  readonly stateApplicability: Readonly<Record<string, readonly VisualDiffStateId[]>>;
}

export interface VisualDiffResolvedCase<TProps = unknown> {
  readonly caseId: string;
  readonly componentId: string;
  readonly variantId: string;
  readonly stateId: VisualDiffStateId;
  readonly state: string;
  readonly compact: boolean;
  readonly fixtureAdapterId: string;
  readonly productionComponent: string;
  readonly authority: string;
  readonly props: TProps;
}

export interface VisualDiffMissingAuthority {
  readonly status: "missing-authority";
  readonly caseId: string;
  readonly componentId?: string;
  readonly variantId?: string;
  readonly stateId?: string;
}

export interface VisualDiffUnsupportedCase {
  readonly status: "unsupported";
  readonly caseId: string;
  readonly componentId: string;
  readonly variantId: string;
  readonly stateId: string;
  readonly reason: "variant" | "state";
}

export type VisualDiffCaseResolution =
  | { readonly status: "ready"; readonly case: VisualDiffResolvedCase }
  | VisualDiffMissingAuthority
  | VisualDiffUnsupportedCase;

export interface ActionButtonVariantProps {
  readonly variant: ActionButtonCase["variant"];
  readonly label: string;
}

type ActionButtonVariantDefinition = VisualDiffVariantDefinition<ActionButtonVariantProps>;

export interface IconButtonVariantProps {
  readonly variant: "default" | "quiet" | "destructive";
  readonly label: string;
  readonly iconName: Extract<IconName, "plus" | "more-horizontal" | "x">;
}

type IconButtonVariantDefinition = VisualDiffVariantDefinition<IconButtonVariantProps>;

export interface TextFieldVariantProps {
  readonly label: string;
  readonly value: string;
}

type TextFieldVariantDefinition = VisualDiffVariantDefinition<TextFieldVariantProps>;

const ACTION_BUTTON_VARIANTS = {
  primary: { props: { variant: "primary", label: "Allow once" } },
  secondary: { props: { variant: "default", label: "Always allow" } },
  quiet: { props: { variant: "quiet", label: "Not now" } },
  destructive: { props: { variant: "destructive", label: "Stop" } },
} as const satisfies Readonly<Record<string, ActionButtonVariantDefinition>>;

const ICON_BUTTON_VARIANTS = {
  default: { props: { variant: "default", label: "Add item", iconName: "plus" } },
  quiet: { props: { variant: "quiet", label: "More options", iconName: "more-horizontal" } },
  destructive: { props: { variant: "destructive", label: "Delete item", iconName: "x" } },
} as const satisfies Readonly<Record<string, IconButtonVariantDefinition>>;

const TEXT_FIELD_VARIANTS = {
  filled: { props: { label: "Display name", value: "Maya Chen" } },
} as const satisfies Readonly<Record<string, TextFieldVariantDefinition>>;

export interface PlateVariantProps {
  readonly variant: "default";
}

type PlateVariantDefinition = VisualDiffVariantDefinition<PlateVariantProps>;

const PLATE_VARIANTS = {
  default: { props: { variant: "default" } },
} as const satisfies Readonly<Record<string, PlateVariantDefinition>>;

export const visualDiffComponentRegistry = {
  "action-button": {
    id: "action-button",
    fixtureAdapterId: "action-button",
    productionComponent: "gateway/webui/src/components/common/foundation.tsx#ActionButton",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: ACTION_BUTTON_VARIANTS,
    stateApplicability: {
      primary: ["compact-rest", "focus", "hover", "pressed", "rest"],
      secondary: ["compact-disabled", "compact-rest", "disabled", "focus", "hover", "pressed", "rest"],
      quiet: ["compact-rest", "focus", "hover", "pressed", "rest"],
      destructive: ["compact-rest", "focus", "hover", "pressed", "rest"],
    },
  },
  "icon-button": {
    id: "icon-button",
    fixtureAdapterId: "icon-button",
    productionComponent: "gateway/webui/src/components/common/foundation/buttons.tsx#FoundationIconButton",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: ICON_BUTTON_VARIANTS,
    stateApplicability: {
      default: ["compact-disabled", "compact-rest", "disabled", "focus", "hover", "pressed", "rest"],
      quiet: ["compact-rest", "focus", "hover", "pressed", "rest"],
      destructive: ["compact-rest", "focus", "hover", "pressed", "rest"],
    },
  },
  "text-field": {
    id: "text-field",
    fixtureAdapterId: "text-field",
    productionComponent: "gateway/webui/src/components/common/foundation/fields.tsx#Field",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: TEXT_FIELD_VARIANTS,
    stateApplicability: {
      filled: ["focus", "hover", "rest"],
    },
  },
  plate: {
    id: "plate",
    fixtureAdapterId: "plate",
    productionComponent: "gateway/webui/src/components/common/foundation/surfaces.tsx#Plate",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: PLATE_VARIANTS,
    stateApplicability: {
      default: ["compact-rest", "rest"],
    },
  },
} as const satisfies Readonly<Record<string, VisualDiffComponentDefinition>>;

// These components have no authority for states outside their approved handoff
// matrix. Keep action-button's established unsupported-state result unchanged.
const MISSING_AUTHORITY_STATE_COMPONENTS: ReadonlySet<string> = new Set(["icon-button", "plate", "text-field"]);

function ownRecordValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

interface ParsedVisualDiffCaseId {
  componentId: string;
  variantId: string;
  stateId: string;
}

function parseCaseId(id: string): ParsedVisualDiffCaseId | undefined {
  const variantSeparator = id.indexOf("--");
  if (variantSeparator <= 0) return undefined;
  const stateSeparator = id.indexOf("--", variantSeparator + 2);
  if (stateSeparator <= variantSeparator + 2 || stateSeparator + 2 >= id.length) return undefined;
  return {
    componentId: id.slice(0, variantSeparator),
    variantId: id.slice(variantSeparator + 2, stateSeparator),
    stateId: id.slice(stateSeparator + 2),
  };
}

function componentDefinition(id: string): VisualDiffComponentDefinition | undefined {
  return ownRecordValue(visualDiffComponentRegistry, id);
}

function stateDetails(stateId: string): { state: string; compact: boolean } | undefined {
  const compact = stateId.startsWith("compact-");
  const state = compact ? stateId.slice("compact-".length) : stateId;
  if (!state) return undefined;
  return { state, compact };
}

function stateResolutionFailure(
  componentId: string,
  caseId: string,
  variantId: string,
  stateId: string,
): VisualDiffCaseResolution {
  if (MISSING_AUTHORITY_STATE_COMPONENTS.has(componentId)) {
    return { status: "missing-authority", caseId, componentId, variantId, stateId };
  }
  return { status: "unsupported", caseId, componentId, variantId, stateId, reason: "state" };
}

export function resolveVisualDiffCase(id: string): VisualDiffCaseResolution {
  const parsed = parseCaseId(id);
  if (!parsed) return { status: "missing-authority", caseId: id };

  const component = componentDefinition(parsed.componentId);
  if (!component) {
    return {
      status: "missing-authority",
      caseId: id,
      componentId: parsed.componentId,
      variantId: parsed.variantId,
      stateId: parsed.stateId,
    };
  }

  const variant = ownRecordValue(component.variants, parsed.variantId);
  if (!variant) {
    return {
      status: "unsupported",
      caseId: id,
      componentId: parsed.componentId,
      variantId: parsed.variantId,
      stateId: parsed.stateId,
      reason: "variant",
    };
  }

  const applicableStates = ownRecordValue(component.stateApplicability, parsed.variantId);
  if (!applicableStates?.some((stateId) => stateId === parsed.stateId)) {
    return stateResolutionFailure(component.id, id, parsed.variantId, parsed.stateId);
  }

  const details = stateDetails(parsed.stateId);
  if (!details) {
    return stateResolutionFailure(component.id, id, parsed.variantId, parsed.stateId);
  }

  return {
    status: "ready",
    case: {
      caseId: id,
      componentId: component.id,
      variantId: parsed.variantId,
      stateId: parsed.stateId,
      state: details.state,
      compact: details.compact,
      fixtureAdapterId: component.fixtureAdapterId,
      productionComponent: component.productionComponent,
      authority: component.authority,
      props: variant.props,
    },
  };
}

/** Compatibility lookup for existing action-button callers. */
export function actionButtonCase(id: string): ActionButtonCase | undefined {
  const resolution = resolveVisualDiffCase(id);
  if (resolution.status !== "ready" || resolution.case.componentId !== "action-button") return undefined;
  const props = resolution.case.props as ActionButtonVariantProps;
  return {
    variant: props.variant,
    label: resolution.case.state === "disabled" ? "Unavailable" : props.label,
    disabled: resolution.case.state === "disabled",
  };
}
