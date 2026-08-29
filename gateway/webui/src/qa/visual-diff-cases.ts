import type { AvatarSize, AvatarTint } from "../components/common/avatar.tsx";
import type { IconName } from "../components/common/icon.tsx";
import type { SentientIdentityState } from "../components/common/sentient-identity.tsx";

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

export interface SearchFieldVariantProps {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
}

type SearchFieldVariantDefinition = VisualDiffVariantDefinition<SearchFieldVariantProps>;

export interface FilterBarVariantProps {
  readonly selected: "all" | "ready" | "shared" | "offline";
}

type FilterBarVariantDefinition = VisualDiffVariantDefinition<FilterBarVariantProps>;

export interface TextAreaVariantProps {
  readonly label: string;
  readonly value: string;
}

type TextAreaVariantDefinition = VisualDiffVariantDefinition<TextAreaVariantProps>;

export interface ValidatedFieldVariantProps {
  readonly label: string;
  readonly value: string;
  readonly status?: {
    readonly tone: "valid" | "error";
    readonly message: string;
  };
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly counter?: {
    readonly current: number;
    readonly max: number;
  };
}

type ValidatedFieldVariantDefinition = VisualDiffVariantDefinition<ValidatedFieldVariantProps>;

export interface RangeVariantProps {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

type RangeVariantDefinition = VisualDiffVariantDefinition<RangeVariantProps>;

export interface CheckboxVariantProps {
  readonly label: string;
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
}

type CheckboxVariantDefinition = VisualDiffVariantDefinition<CheckboxVariantProps>;

export interface ChipVariantProps {
  readonly label: string;
  readonly selected: boolean;
}

type ChipVariantDefinition = VisualDiffVariantDefinition<ChipVariantProps>;

export interface ToggleVariantProps {
  readonly label: string;
  readonly checked: boolean;
}

type ToggleVariantDefinition = VisualDiffVariantDefinition<ToggleVariantProps>;

export interface SettingRowVariantProps {
  readonly control: "toggle" | "segmented" | "select" | "range";
  readonly label: string;
  readonly hint: string;
}

type SettingRowVariantDefinition = VisualDiffVariantDefinition<SettingRowVariantProps>;

export interface SettingsGroupVariantProps {
  readonly label: "General";
}

type SettingsGroupVariantDefinition = VisualDiffVariantDefinition<SettingsGroupVariantProps>;

export interface SettingsEditorVariantProps {
  readonly title: string;
  readonly subtitle: string;
  readonly fieldLabel: string;
  readonly fieldValue: string;
  readonly textAreaLabel: string;
  readonly textAreaValue: string;
}

type SettingsEditorVariantDefinition = VisualDiffVariantDefinition<SettingsEditorVariantProps>;

export interface SegmentedControlOption {
  readonly value: string;
  readonly label: string;
}

export interface SegmentedControlVariantProps {
  readonly label: string;
  readonly initialValue: string;
  readonly options: readonly SegmentedControlOption[];
}

type SegmentedControlVariantDefinition = VisualDiffVariantDefinition<SegmentedControlVariantProps>;

export interface UserAvatarVariantProps {
  readonly initial?: string;
  readonly name: string;
  readonly tint?: AvatarTint;
  readonly size: AvatarSize;
}

type UserAvatarVariantDefinition = VisualDiffVariantDefinition<UserAvatarVariantProps>;

export interface NoticeVariantProps {
  readonly tone: "info" | "warning" | "error";
  readonly title: string;
  readonly message: string;
  readonly actionLabel?: string;
}

type NoticeVariantDefinition = VisualDiffVariantDefinition<NoticeVariantProps>;

export interface DisclosureVariantProps {
  readonly title: string;
  readonly description: string;
  readonly body: "toggle" | "paragraph";
}

type DisclosureVariantDefinition = VisualDiffVariantDefinition<DisclosureVariantProps>;

export interface SentientIdentityVariantProps {
  readonly state: SentientIdentityState;
  readonly transitionTo?: SentientIdentityState;
}

type SentientIdentityVariantDefinition = VisualDiffVariantDefinition<SentientIdentityVariantProps>;

export interface NoResultsStateVariantProps {
  readonly title: string;
  readonly message: string;
  readonly actionLabel: string;
}

type NoResultsStateVariantDefinition = VisualDiffVariantDefinition<NoResultsStateVariantProps>;

export interface InlineSecretEditorVariantProps {
  readonly label: string;
  readonly hasKey: boolean;
}

type InlineSecretEditorVariantDefinition = VisualDiffVariantDefinition<InlineSecretEditorVariantProps>;

const INLINE_SECRET_EDITOR_VARIANTS = {
  "access-key": { props: { label: "Access key", hasKey: true } },
} as const satisfies Readonly<Record<string, InlineSecretEditorVariantDefinition>>;

const USER_AVATAR_VARIANTS = {
  "terra-28": { props: { initial: "M", name: "Maya Chen", size: "sm" } },
  "terra-44": { props: { initial: "M", name: "Maya Chen", size: "lg" } },
  "terra-56": { props: { initial: "M", name: "Maya Chen", size: "xl" } },
  "sage-44": { props: { initial: "A", name: "Alex Chen", tint: "sage", size: "lg" } },
  "amber-44": { props: { initial: "J", name: "Jordan Chen", tint: "amber", size: "lg" } },
  "clay-44": { props: { initial: "R", name: "Riley Chen", tint: "clay", size: "lg" } },
  "fallback-44": { props: { name: "Unknown user", size: "lg" } },
} as const satisfies Readonly<Record<string, UserAvatarVariantDefinition>>;

const NOTICE_VARIANTS = {
  info: {
    props: {
      tone: "info",
      title: "Changes apply to this device",
      message: "Other household devices keep their current preference.",
    },
  },
  warning: {
    props: {
      tone: "warning",
      title: "Permission required",
      message: "Review the requested scope before continuing.",
      actionLabel: "Review",
    },
  },
  error: {
    props: {
      tone: "error",
      title: "Couldn’t save changes",
      message: "Your edits are still here. Try again when the connection returns.",
      actionLabel: "Retry",
    },
  },
} as const satisfies Readonly<Record<string, NoticeVariantDefinition>>;

export interface MediaActionCardVariantProps {
  readonly initial: string;
  readonly name: string;
  readonly tint: AvatarTint;
  readonly description: string;
}

type MediaActionCardVariantDefinition = VisualDiffVariantDefinition<MediaActionCardVariantProps>;

// Only user variants are registered: icon/image media loading, crop, and
// failure behavior have no production Web owner or defined contract yet.
const MEDIA_ACTION_CARD_VARIANTS = {
  "user-sage": { props: { initial: "A", name: "Alex", tint: "sage", description: "Household member" } },
  "user-terra": { props: { initial: "M", name: "Maya", tint: "terra", description: "Household owner" } },
} as const satisfies Readonly<Record<string, MediaActionCardVariantDefinition>>;

const TOGGLE_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0050ms",
  "frame-002--0100ms",
  "frame-003--0150ms",
  "frame-004--0200ms",
] as const;

const TOGGLE_VARIANTS = {
  off: { props: { label: "Automatic updates", checked: false } },
  on: { props: { label: "Automatic updates", checked: true } },
  "off-to-on": { props: { label: "Automatic updates", checked: false } },
} as const satisfies Readonly<Record<string, ToggleVariantDefinition>>;

const SETTINGS_GROUP_VARIANTS = {
  general: { props: { label: "General" } },
} as const satisfies Readonly<Record<string, SettingsGroupVariantDefinition>>;

const SETTINGS_EDITOR_VARIANTS = {
  vertical: {
    props: {
      title: "Vertical editor row",
      subtitle: "Use when the field needs the full measure.",
      fieldLabel: "Household label",
      fieldValue: "Home",
      textAreaLabel: "Description",
      textAreaValue: "A short explanation that helps people understand the effect of this setting.",
    },
  },
} as const satisfies Readonly<Record<string, SettingsEditorVariantDefinition>>;

const SETTING_ROW_VARIANTS = {
  toggle: {
    props: {
      control: "toggle",
      label: "Automatic updates",
      hint: "Install trusted updates when the household is idle.",
    },
  },
  segmented: {
    props: {
      control: "segmented",
      label: "Detail level",
      hint: "Choose how much supporting information appears.",
    },
  },
  select: {
    props: {
      control: "select",
      label: "Language",
      hint: "Used for interface labels and spoken responses.",
    },
  },
  range: {
    props: {
      control: "range",
      label: "Interface scale",
      hint: "Preview changes before applying them.",
    },
  },
} as const satisfies Readonly<Record<string, SettingRowVariantDefinition>>;

const DISCLOSURE_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0062ms",
  "frame-002--0125ms",
  "frame-003--0188ms",
  "frame-004--0250ms",
] as const;

const DISCLOSURE_VARIANTS = {
  "advanced-options": {
    props: {
      title: "Advanced options",
      description: "Additional controls for experienced users",
      body: "toggle",
    },
  },
  "data-storage": {
    props: {
      title: "Data and storage",
      description: "Retention and local cache",
      body: "paragraph",
    },
  },
  "closed-to-open": {
    props: {
      title: "Data and storage",
      description: "Retention and local cache",
      body: "paragraph",
    },
  },
} as const satisfies Readonly<Record<string, DisclosureVariantDefinition>>;

const SEGMENTED_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0055ms",
  "frame-002--0110ms",
  "frame-003--0165ms",
  "frame-004--0220ms",
] as const;

const SEGMENTED_AVATAR_OPTIONS = [
  { value: "idle", label: "Idle" },
  { value: "thinking", label: "Thinking" },
  { value: "responding", label: "Responding" },
] as const;

const SEGMENTED_DENSITY_OPTIONS = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const;

const SEGMENTED_CONTROL_VARIANTS = {
  "avatar-state": {
    props: {
      label: "Sentient avatar state",
      initialValue: "idle",
      options: SEGMENTED_AVATAR_OPTIONS,
    },
  },
  density: {
    props: {
      label: "View density",
      initialValue: "comfortable",
      options: SEGMENTED_DENSITY_OPTIONS,
    },
  },
  "comfortable-to-compact": {
    props: {
      label: "View density",
      initialValue: "comfortable",
      options: SEGMENTED_DENSITY_OPTIONS,
    },
  },
} as const satisfies Readonly<Record<string, SegmentedControlVariantDefinition>>;

const CHIP_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0040ms",
  "frame-002--0080ms",
  "frame-003--0120ms",
  "frame-004--0150ms",
] as const;

const CHIP_VARIANTS = {
  unselected: { props: { label: "School", selected: false } },
  selected: { props: { label: "Family", selected: true } },
  "unselected-to-selected": { props: { label: "School", selected: false } },
} as const satisfies Readonly<Record<string, ChipVariantDefinition>>;

const CHECKBOX_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0050ms",
  "frame-002--0100ms",
  "frame-003--0150ms",
  "frame-004--0250ms",
] as const;

const CHECKBOX_VARIANTS = {
  unchecked: { props: { label: "Not selected", checked: false } },
  checked: { props: { label: "Selected", checked: true } },
  mixed: { props: { label: "Mixed", checked: false, indeterminate: true } },
  disabled: { props: { label: "Unavailable", checked: false, disabled: true } },
  "unchecked-to-checked": { props: { label: "Not selected", checked: false } },
  "unchecked-to-mixed": { props: { label: "Not selected", checked: false } },
} as const satisfies Readonly<Record<string, CheckboxVariantDefinition>>;

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

const SEARCH_FIELD_VARIANTS = {
  placeholder: { props: { label: "Search", placeholder: "Search conversations", value: "" } },
} as const satisfies Readonly<Record<string, SearchFieldVariantDefinition>>;

const TEXT_AREA_VARIANTS = {
  filled: { props: { label: "Description", value: "Add supporting details." } },
} as const satisfies Readonly<Record<string, TextAreaVariantDefinition>>;

const VALIDATED_FIELD_VARIANTS = {
  confirmation: {
    props: {
      label: "Confirmation",
      value: "warm emb",
      status: { tone: "error", message: "The values do not match." },
    },
  },
  "recovery-phrase": {
    props: {
      label: "Recovery phrase",
      value: "warm ember",
      status: { tone: "valid", message: "Available" },
    },
  },
  "supporting-note": {
    props: {
      label: "Supporting note",
      value: "A concise note that helps others understand this choice.",
      multiline: true,
      maxLength: 160,
      counter: { current: 58, max: 160 },
    },
  },
} as const satisfies Readonly<Record<string, ValidatedFieldVariantDefinition>>;

const RANGE_VARIANTS = {
  "62": { props: { label: "Interface scale", value: 62, min: 0, max: 100, step: 1 } },
} as const satisfies Readonly<Record<string, RangeVariantDefinition>>;

const SENTIENT_IDENTITY_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0120ms",
  "frame-002--0138ms",
  "frame-003--0250ms",
] as const;

const SENTIENT_IDENTITY_THINKING_LOOP_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0270ms",
  "frame-002--0540ms",
  "frame-003--0810ms",
  "frame-004--1080ms",
  "frame-005--1350ms",
] as const;

const SENTIENT_IDENTITY_RESPONDING_LOOP_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0310ms",
  "frame-002--0620ms",
  "frame-003--0930ms",
  "frame-004--1240ms",
  "frame-005--1550ms",
] as const;

const SENTIENT_IDENTITY_VARIANTS = {
  idle: { props: { state: "idle" } },
  thinking: { props: { state: "thinking" } },
  responding: { props: { state: "responding" } },
  "idle-to-thinking": { props: { state: "idle", transitionTo: "thinking" } },
  "thinking-to-responding": { props: { state: "thinking", transitionTo: "responding" } },
  "responding-to-idle": { props: { state: "responding", transitionTo: "idle" } },
  "thinking-loop": { props: { state: "thinking" } },
  "responding-loop": { props: { state: "responding" } },
} as const satisfies Readonly<Record<string, SentientIdentityVariantDefinition>>;

export interface PaneHeaderVariantProps {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly actionLabel: string;
}

type PaneHeaderVariantDefinition = VisualDiffVariantDefinition<PaneHeaderVariantProps>;

const PANE_HEADER_VARIANTS = {
  preferences: {
    props: {
      eyebrow: "Household",
      title: "Preferences",
      subtitle: "Control shared defaults and personal behavior.",
      actionLabel: "Save changes",
    },
  },
} as const satisfies Readonly<Record<string, PaneHeaderVariantDefinition>>;

export interface PinEntryVariantProps {
  readonly length: 4;
}

type PinEntryVariantDefinition = VisualDiffVariantDefinition<PinEntryVariantProps>;

const PIN_ENTRY_TRANSITION_FRAMES = [
  "frame-000--0000ms",
  "frame-001--0180ms",
  "frame-002--0360ms",
  "frame-003--0700ms",
  "frame-004--1060ms",
] as const;

const PIN_ENTRY_VARIANTS = {
  "4-digit": { props: { length: 4 } },
  "complete-to-success": { props: { length: 4 } },
} as const satisfies Readonly<Record<string, PinEntryVariantDefinition>>;

export interface PlateVariantProps {
  readonly variant: "default";
}

type PlateVariantDefinition = VisualDiffVariantDefinition<PlateVariantProps>;

const PLATE_VARIANTS = {
  default: { props: { variant: "default" } },
} as const satisfies Readonly<Record<string, PlateVariantDefinition>>;

export interface LoadingStateVariantProps {
  readonly title: string;
  readonly message: string;
}

type LoadingStateVariantDefinition = VisualDiffVariantDefinition<LoadingStateVariantProps>;

const LOADING_STATE_VARIANTS = {
  settings: { props: { title: "Loading", message: "Fetching current settings…" } },
} as const satisfies Readonly<Record<string, LoadingStateVariantDefinition>>;

const NO_RESULTS_VARIANTS = {
  default: {
    props: {
      title: "No matching results",
      message: "Try a broader term or clear one of the filters.",
      actionLabel: "Clear filters",
    },
  },
} as const satisfies Readonly<Record<string, NoResultsStateVariantDefinition>>;

export interface StaleBannerVariantProps {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
}

type StaleBannerVariantDefinition = VisualDiffVariantDefinition<StaleBannerVariantProps>;

export interface ApplyBarVariantProps {
  readonly pendingCount: number;
}

type ApplyBarVariantDefinition = VisualDiffVariantDefinition<ApplyBarVariantProps>;

const APPLY_BAR_TRANSITION_FRAMES = ["frame-000--0000ms", "frame-001--0300ms", "frame-002--0900ms"] as const;

const APPLY_BAR_VARIANTS = {
  dirty: { props: { pendingCount: 3 } },
  applying: { props: { pendingCount: 3 } },
  done: { props: { pendingCount: 3 } },
  "dirty-to-done": { props: { pendingCount: 3 } },
} as const satisfies Readonly<Record<string, ApplyBarVariantDefinition>>;

const FILTER_BAR_VARIANTS = {
  default: { props: { selected: "all" } },
  ready: { props: { selected: "ready" } },
  shared: { props: { selected: "shared" } },
  offline: { props: { selected: "offline" } },
  sort: { props: { selected: "all" } },
} as const satisfies Readonly<Record<string, FilterBarVariantDefinition>>;

const STALE_BANNER_VARIANTS = {
  "saved-results": {
    props: {
      title: "Showing saved results",
      detail: "Couldn’t refresh just now.",
      actionLabel: "Retry",
    },
  },
} as const satisfies Readonly<Record<string, StaleBannerVariantDefinition>>;

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
  "user-avatar": {
    id: "user-avatar",
    fixtureAdapterId: "user-avatar",
    productionComponent: "gateway/webui/src/components/common/avatar.tsx#Avatar",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: USER_AVATAR_VARIANTS,
    stateApplicability: {
      "terra-28": ["rest"],
      "terra-44": ["disabled", "rest", "selected"],
      "terra-56": ["rest"],
      "sage-44": ["rest"],
      "amber-44": ["rest"],
      "clay-44": ["rest"],
      "fallback-44": ["rest"],
    },
  },
  notice: {
    id: "notice",
    fixtureAdapterId: "notice",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#Notice",
    authority: "design/prototype/common-composites/handoff/static",
    variants: NOTICE_VARIANTS,
    stateApplicability: {
      info: ["rest"],
      warning: ["compact", "rest"],
      error: ["compact", "rest"],
    },
  },
  "media-action-card": {
    id: "media-action-card",
    fixtureAdapterId: "media-action-card",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#DominantVisualCard",
    authority: "design/prototype/common-composites/handoff/static",
    variants: MEDIA_ACTION_CARD_VARIANTS,
    stateApplicability: {
      "user-sage": ["focus", "hover", "rest"],
      "user-terra": ["focus", "hover", "rest"],
    },
  },
  "sentient-identity": {
    id: "sentient-identity",
    fixtureAdapterId: "sentient-identity",
    productionComponent: "gateway/webui/src/components/common/sentient-identity.tsx#SentientIdentity",
    authority: "design/prototype/foundation-components/handoff",
    variants: SENTIENT_IDENTITY_VARIANTS,
    stateApplicability: {
      idle: ["reduced-motion", "rest"],
      thinking: ["reduced-motion", "rest"],
      responding: ["reduced-motion", "rest"],
      "idle-to-thinking": SENTIENT_IDENTITY_TRANSITION_FRAMES,
      "thinking-to-responding": SENTIENT_IDENTITY_TRANSITION_FRAMES,
      "responding-to-idle": SENTIENT_IDENTITY_TRANSITION_FRAMES,
      "thinking-loop": SENTIENT_IDENTITY_THINKING_LOOP_FRAMES,
      "responding-loop": SENTIENT_IDENTITY_RESPONDING_LOOP_FRAMES,
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
  "search-field": {
    id: "search-field",
    fixtureAdapterId: "search-field",
    productionComponent: "gateway/webui/src/components/common/foundation/fields.tsx#Field",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: SEARCH_FIELD_VARIANTS,
    stateApplicability: {
      placeholder: ["focus", "hover", "rest"],
    },
  },
  "filter-bar": {
    id: "filter-bar",
    fixtureAdapterId: "filter-bar",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#SearchFilterBar",
    authority: "design/prototype/common-composites/handoff/static",
    variants: FILTER_BAR_VARIANTS,
    stateApplicability: {
      default: ["compact", "rest"],
      ready: ["selected"],
      shared: ["selected"],
      offline: ["selected"],
      sort: ["open"],
    },
  },
  "text-area": {
    id: "text-area",
    fixtureAdapterId: "text-area",
    productionComponent: "gateway/webui/src/components/common/foundation/fields.tsx#TextArea",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: TEXT_AREA_VARIANTS,
    stateApplicability: {
      filled: ["focus", "hover", "rest"],
    },
  },
  "validated-field": {
    id: "validated-field",
    fixtureAdapterId: "validated-field",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#ValidatedField",
    authority: "design/prototype/common-composites/handoff/static",
    variants: VALIDATED_FIELD_VARIANTS,
    stateApplicability: {
      confirmation: ["error"],
      "recovery-phrase": ["valid"],
      "supporting-note": ["counter"],
    },
  },
  range: {
    id: "range",
    fixtureAdapterId: "range",
    productionComponent: "gateway/webui/src/components/common/foundation/controls.tsx#SliderControl",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: RANGE_VARIANTS,
    stateApplicability: {
      "62": ["disabled", "focus", "hover", "rest"],
    },
  },
  chip: {
    id: "chip",
    fixtureAdapterId: "chip",
    productionComponent: "gateway/webui/src/components/common/foundation/controls.tsx#ChipControl",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: CHIP_VARIANTS,
    stateApplicability: {
      unselected: ["compact-rest", "focus", "hover", "pressed", "rest"],
      selected: ["compact-rest", "focus", "hover", "pressed", "rest"],
      "unselected-to-selected": CHIP_TRANSITION_FRAMES,
    },
  },
  toggle: {
    id: "toggle",
    fixtureAdapterId: "toggle",
    productionComponent: "gateway/webui/src/components/common/foundation/controls.tsx#ToggleControl",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: TOGGLE_VARIANTS,
    stateApplicability: {
      off: ["focus", "hover", "pressed", "rest"],
      on: ["focus", "hover", "pressed", "rest"],
      "off-to-on": TOGGLE_TRANSITION_FRAMES,
    },
  },
  "settings-group": {
    id: "settings-group",
    fixtureAdapterId: "settings-group",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#SettingsGroup",
    authority: "design/prototype/common-composites/handoff/static/settings-group--general--rest.png",
    variants: SETTINGS_GROUP_VARIANTS,
    stateApplicability: {
      general: ["rest"],
    },
  },
  "settings-editor": {
    id: "settings-editor",
    fixtureAdapterId: "settings-editor",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#SettingsEditor",
    authority: "design/prototype/common-composites/handoff/static",
    variants: SETTINGS_EDITOR_VARIANTS,
    stateApplicability: {
      vertical: ["saved", "unsaved"],
    },
  },
  "setting-row": {
    id: "setting-row",
    fixtureAdapterId: "setting-row",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#SettingsRow",
    authority: "design/prototype/common-composites/handoff/static",
    variants: SETTING_ROW_VARIANTS,
    stateApplicability: {
      toggle: ["off", "on"],
      segmented: ["default-selected", "expert-selected"],
      select: ["english-closed", "spanish-selected"],
      range: ["62"],
    },
  },
  "segmented-control": {
    id: "segmented-control",
    fixtureAdapterId: "segmented-control",
    productionComponent: "gateway/webui/src/components/common/foundation/controls.tsx#SegmentedControl",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: SEGMENTED_CONTROL_VARIANTS,
    stateApplicability: {
      "avatar-state": ["compact-layout", "idle-selected", "responding-selected", "thinking-selected"],
      density: [
        "comfortable-selected",
        "compact-focus",
        "compact-hover",
        "compact-layout",
        "compact-pressed",
        "compact-selected",
      ],
      "comfortable-to-compact": SEGMENTED_TRANSITION_FRAMES,
    },
  },
  disclosure: {
    id: "disclosure",
    fixtureAdapterId: "disclosure",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#Disclosure",
    authority: "design/prototype/common-composites/handoff",
    variants: DISCLOSURE_VARIANTS,
    stateApplicability: {
      "advanced-options": ["closed", "open"],
      "data-storage": ["closed", "open"],
      "closed-to-open": DISCLOSURE_TRANSITION_FRAMES,
    },
  },
  checkbox: {
    id: "checkbox",
    fixtureAdapterId: "checkbox",
    productionComponent: "gateway/webui/src/components/common/foundation/selection.tsx#CheckboxControl",
    authority: "design/prototype/foundation-components/handoff/static",
    variants: CHECKBOX_VARIANTS,
    stateApplicability: {
      unchecked: ["focus", "hover", "pressed", "rest"],
      checked: ["focus", "hover", "pressed", "rest"],
      mixed: ["focus", "hover", "pressed", "rest"],
      disabled: ["rest"],
      "unchecked-to-checked": CHECKBOX_TRANSITION_FRAMES,
      "unchecked-to-mixed": CHECKBOX_TRANSITION_FRAMES,
    },
  },
  "pane-header": {
    id: "pane-header",
    fixtureAdapterId: "pane-header",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#PaneChrome",
    authority: "design/prototype/common-composites/handoff/static/pane-header--preferences--rest.png",
    variants: PANE_HEADER_VARIANTS,
    stateApplicability: {
      preferences: ["rest"],
    },
  },
  "pin-entry": {
    id: "pin-entry",
    fixtureAdapterId: "pin-entry",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#PinKeypad",
    authority: "design/prototype/common-composites/handoff.md",
    variants: PIN_ENTRY_VARIANTS,
    stateApplicability: {
      "4-digit": ["checking", "checking-reduced-motion", "empty", "one-digit", "partial", "success"],
      "complete-to-success": PIN_ENTRY_TRANSITION_FRAMES,
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
  "loading-state": {
    id: "loading-state",
    fixtureAdapterId: "loading-state",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#AsyncState",
    authority: "design/prototype/common-composites/handoff/static",
    variants: LOADING_STATE_VARIANTS,
    stateApplicability: {
      settings: ["active", "reduced-motion"],
    },
  },
  "no-results": {
    id: "no-results",
    fixtureAdapterId: "no-results",
    productionComponent: "gateway/webui/src/components/common/composites.tsx#NoResultsState",
    authority: "design/prototype/common-composites/handoff/static",
    variants: NO_RESULTS_VARIANTS,
    stateApplicability: {
      default: ["empty"],
    },
  },
  "stale-banner": {
    id: "stale-banner",
    fixtureAdapterId: "stale-banner",
    productionComponent: "gateway/webui/src/components/sessions/stale-banner.tsx#StaleBanner",
    authority: "design/prototype/common-composites/handoff/static",
    variants: STALE_BANNER_VARIANTS,
    stateApplicability: {
      "saved-results": ["checking", "rest"],
    },
  },
  "apply-bar": {
    id: "apply-bar",
    fixtureAdapterId: "apply-bar",
    productionComponent: "gateway/webui/src/components/settings/apply-bar/apply-bar.tsx#ApplyBar",
    authority: "design/prototype/common-composites/handoff.md",
    variants: APPLY_BAR_VARIANTS,
    stateApplicability: {
      dirty: ["rest"],
      applying: ["active"],
      done: ["success"],
      "dirty-to-done": APPLY_BAR_TRANSITION_FRAMES,
    },
  },
  "inline-secret-editor": {
    id: "inline-secret-editor",
    fixtureAdapterId: "inline-secret-editor",
    productionComponent: "gateway/webui/src/components/settings/panes/secret-row.tsx#SecretRow",
    authority: "design/prototype/common-composites/handoff/static",
    variants: INLINE_SECRET_EDITOR_VARIANTS,
    stateApplicability: {
      "access-key": ["editing", "read"],
    },
  },
} as const satisfies Readonly<Record<string, VisualDiffComponentDefinition>>;

// These components have no authority for states outside their approved handoff
// matrix. Keep action-button's established unsupported-state result unchanged.
const MISSING_AUTHORITY_STATE_COMPONENTS: ReadonlySet<string> = new Set([
  "icon-button",
  "plate",
  "text-field",
  "search-field",
  "filter-bar",
  "text-area",
  "validated-field",
  "range",
  "checkbox",
  "chip",
  "toggle",
  "segmented-control",
  "user-avatar",
  "media-action-card",
  "sentient-identity",
  "notice",
  "no-results",
  "stale-banner",
  "pane-header",
  "disclosure",
  "pin-entry",
  "setting-row",
  "apply-bar",
  "settings-group",
  "settings-editor",
  "inline-secret-editor",
]);

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
  const compact = stateId === "compact" || stateId.startsWith("compact-");
  const state = stateId === "compact" ? "rest" : compact ? stateId.slice("compact-".length) : stateId;
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
