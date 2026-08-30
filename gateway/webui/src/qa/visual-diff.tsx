import { Rive } from "@rive-app/canvas";
import { render } from "preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import "../components/common/composites.css";
import "../components/settings/apply-bar/apply-bar.css";
import { AsyncState, Disclosure, DominantVisualCard, NoResultsState, Notice, PaneChrome, PinKeypad, SearchFilterBar, SettingsEditor, SettingsGroup, SettingsRow, ValidatedField } from "../components/common/composites.tsx";
import { ActionButton, CheckboxControl, ChipControl, Field, FoundationIconButton, Plate, SegmentedControl, SelectControl, SliderControl, ToggleControl } from "../components/common/foundation.tsx";
import { SelectMenu } from "../components/common/select-menu.tsx";
import { Avatar } from "../components/common/avatar.tsx";
import { SentientIdentity, type RiveFactory } from "../components/common/sentient-identity.tsx";
import { TextArea } from "../components/common/foundation/fields.tsx";
import { Icon } from "../components/common/icon.tsx";
import { StaleBanner } from "../components/sessions/stale-banner.tsx";
import { ApplyBar } from "../components/settings/apply-bar/apply-bar.tsx";
import type { ApplyDeps, PendingOpWithPayload } from "../components/settings/apply-bar/apply-bar-machine.ts";
import {
  type ActionButtonVariantProps,
  type ApplyBarVariantProps,
  type CheckboxVariantProps,
  type ChipVariantProps,
  type DisclosureVariantProps,
  type FilterBarVariantProps,
  type IconButtonVariantProps,
  type LoadingStateVariantProps,
  type MediaActionCardVariantProps,
  type NoResultsStateVariantProps,
  type NoticeVariantProps,
  type PaneHeaderVariantProps,
  type PinEntryVariantProps,
  type PlateVariantProps,
  type RangeVariantProps,
  type SearchFieldVariantProps,
  type SegmentedControlVariantProps,
  type SentientIdentityVariantProps,
  type SettingRowVariantProps,
  type SettingsEditorVariantProps,
  type SettingsGroupVariantProps,
  type StaleBannerVariantProps,
  type TextAreaVariantProps,
  type TextFieldVariantProps,
  type ToggleVariantProps,
  type UserAvatarVariantProps,
  type ValidatedFieldVariantProps,
  resolveVisualDiffCase,
  type VisualDiffCaseResolution,
  type VisualDiffResolvedCase,
} from "./visual-diff-cases.ts";

const caseId = new URLSearchParams(location.search).get("case") ?? "";

type InvalidVisualDiffCase = Exclude<VisualDiffCaseResolution, { status: "ready" }>;
interface VisualDiffFixtureAdapter {
  render(fixture: VisualDiffResolvedCase): JSX.Element;
}

interface VisualDiffTransitionWindow extends Window {
  __startVisualDiffTransition?: () => void;
  __visualDiffRive?: Pick<Rive, "stopRendering">;
}

type CheckboxTransitionDestination = "checked" | "mixed";

function CheckboxTransitionFixture({ destination }: { destination: CheckboxTransitionDestination }): JSX.Element {
  const [transitioned, setTransitioned] = useState(false);
  useEffect(() => {
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => setTransitioned(true);
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete document.documentElement.dataset.visualDiffTransitionReady;
    };
  }, []);
  return (
    <CheckboxControl
      label="Not selected"
      checked={destination === "checked" && transitioned}
      indeterminate={destination === "mixed" && transitioned}
      className="visual-diff-target"
      onChange={() => {}}
    />
  );
}

function ChipTransitionFixture({ label }: { label: string }): JSX.Element {
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => {
      const target = document.querySelector<HTMLButtonElement>(".snt-chip");
      if (!target) throw new Error("Visual diff chip target is not ready");
      target.click();
    };
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete document.documentElement.dataset.visualDiffTransitionReady;
    };
  }, []);
  return <ChipControl selected={selected} onClick={() => setSelected(true)}>{label}</ChipControl>;
}

function ToggleTransitionFixture({ label }: { label: string }): JSX.Element {
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => {
      const target = document.querySelector<HTMLButtonElement>(".snt-toggle");
      if (!target) throw new Error("Visual diff toggle target is not ready");
      target.click();
    };
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete document.documentElement.dataset.visualDiffTransitionReady;
    };
  }, []);
  return <ToggleControl label={label} checked={checked} onChange={setChecked} />;
}

function segmentedInitialValue(fixture: VisualDiffResolvedCase): string {
  if (fixture.variantId === "avatar-state") {
    if (fixture.stateId === "thinking-selected") return "thinking";
    if (fixture.stateId === "responding-selected") return "responding";
  }
  if (fixture.variantId === "density" && fixture.stateId === "compact-selected") return "compact";
  const props = fixture.props as SegmentedControlVariantProps;
  return props.initialValue;
}

function SegmentedControlFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const props = fixture.props as SegmentedControlVariantProps;
  const [value, setValue] = useState(() => segmentedInitialValue(fixture));

  useEffect(() => {
    if (fixture.variantId !== "comfortable-to-compact") return;
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => setValue("compact");
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete document.documentElement.dataset.visualDiffTransitionReady;
    };
  }, [fixture.variantId]);

  return <SegmentedControl label={props.label} value={value} options={props.options} onChange={(nextValue) => setValue(nextValue)} />;
}

function FilterBarFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const props = fixture.props as FilterBarVariantProps;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState(props.selected);

  const filters = ["all", "ready", "shared", "offline"] as const;
  return (
    <div class={`visual-diff-filter-bar-frame${fixture.compact ? " visual-diff-filter-bar-frame--compact" : ""}`}>
      <Plate className="visual-diff-target visual-diff-filter-bar">
        <SearchFilterBar
          value={query}
          onChange={setQuery}
          label="Search items"
          placeholder="Search items"
          filters={filters.map((filter) => (
            <ChipControl key={filter} selected={selected === filter} onClick={() => setSelected(filter)}>
              {filter[0]?.toUpperCase()}{filter.slice(1)}
            </ChipControl>
          ))}
        >
          <SelectMenu
            className="snt-filter-bar__sort"
            placeholder="Sort by"
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: "Recently used" },
              { value: "name", label: "Name" },
              { value: "status", label: "Status" },
            ]}
          />
        </SearchFilterBar>
      </Plate>
    </div>
  );
}

function SettingsGroupFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const group = fixture.props as SettingsGroupVariantProps;
  if (group.label !== "General") throw new Error(`Unsupported settings group: ${group.label}`);

  return (
    <Plate className="visual-diff-target visual-diff-settings-group">
      <SettingsGroup>
        <SettingsRow label="Automatic updates" hint="Install trusted updates when the household is idle.">
          <ToggleControl label="Automatic updates" checked onChange={() => {}} />
        </SettingsRow>
        <SettingsRow label="Language" hint="Used for interface labels and spoken responses.">
          <SelectControl
            label="Language"
            value="English"
            options={[{ value: "English", label: "English" }, { value: "Spanish", label: "Spanish" }, { value: "French", label: "French" }]}
            onChange={() => {}}
          />
        </SettingsRow>
        <SettingsRow label="Detail level" hint="Choose how much supporting information appears.">
          <SegmentedControl
            label="Detail level"
            value="default"
            options={[{ value: "default", label: "Default" }, { value: "expert", label: "Expert" }]}
            onChange={() => {}}
          />
        </SettingsRow>
        <SettingsRow label="Interface scale" hint="Preview changes before applying them.">
          <SliderControl label="Interface scale" value={62} min={0} max={100} step={1} format={(value) => `${Math.round(value)}%`} onChange={() => {}} />
        </SettingsRow>
      </SettingsGroup>
    </Plate>
  );
}

function SettingRowFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const row = fixture.props as SettingRowVariantProps;
  const control = row.control === "toggle"
    ? <ToggleControl label={row.label} checked={fixture.state === "on"} onChange={() => {}} />
    : row.control === "segmented"
      ? (
        <SegmentedControl
          label={row.label}
          value={fixture.state === "expert-selected" ? "expert" : "default"}
          options={[{ value: "default", label: "Default" }, { value: "expert", label: "Expert" }]}
          onChange={() => {}}
        />
      )
      : row.control === "select"
        ? (
          <SelectControl
            label={row.label}
            value={fixture.state === "spanish-selected" ? "Spanish" : "English"}
            options={[{ value: "English", label: "English" }, { value: "Spanish", label: "Spanish" }, { value: "French", label: "French" }]}
            onChange={() => {}}
          />
        )
        : (
          <SliderControl
            label={row.label}
            value={62}
            min={0}
            max={100}
            step={1}
            format={(value) => `${Math.round(value)}%`}
            onChange={() => {}}
          />
        );

  return (
    <div class="visual-diff-setting-row-frame">
      <Plate className="visual-diff-target visual-diff-setting-row">
        <div class="visual-diff-setting-row__list">
          <SettingsRow label={row.label} hint={row.hint}>{control}</SettingsRow>
        </div>
      </Plate>
    </div>
  );
}

function DisclosureFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const props = fixture.props as DisclosureVariantProps;
  const isTransition = fixture.variantId === "closed-to-open";
  const [open, setOpen] = useState(fixture.state === "open");

  useEffect(() => {
    if (!isTransition) return;
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => setOpen(true);
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete document.documentElement.dataset.visualDiffTransitionReady;
    };
  }, [isTransition]);

  const body = props.body === "toggle"
    ? (
      <div class="visual-diff-disclosure-setting">
        <div><strong>Detailed diagnostics</strong><span>Show sanitized identifiers and state transitions.</span></div>
        <ToggleControl label="Detailed diagnostics" checked={false} onChange={() => {}} />
      </div>
    )
    : <p class="visual-diff-disclosure-paragraph">Storage controls belong here when defined.</p>;

  return (
    <Plate className="visual-diff-target visual-diff-disclosure">
      <div class="snt-disclosures">
        <Disclosure title={props.title} description={props.description} open={open} onOpenChange={setOpen}>
          {body}
        </Disclosure>
      </div>
    </Plate>
  );
}

function pinEntryDigits(stateId: string): readonly string[] {
  if (stateId === "one-digit") return ["1"];
  if (stateId === "partial") return ["1", "2", "3"];
  if (stateId === "frame-001--0180ms") return ["1", "2"];
  if (stateId === "checking" || stateId === "checking-reduced-motion" || stateId === "success" || stateId === "frame-002--0360ms" || stateId === "frame-003--0700ms" || stateId === "frame-004--1060ms") return ["1", "2", "3", "4"];
  return [];
}

function PinEntryFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const pin = fixture.props as PinEntryVariantProps;
  const digits = pinEntryDigits(fixture.stateId).slice(0, pin.length);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const enter = (index: number): void => {
      if (cancelled) return;
      const digit = digits[index];
      if (digit === undefined) return;
      const button = document.querySelector<HTMLButtonElement>(`[aria-label="PIN digit ${digit}"]`);
      if (!button) {
        requestAnimationFrame(() => enter(index));
        return;
      }
      button.click();
      window.setTimeout(() => enter(index + 1), 0);
    };
    enter(0);
    return () => {
      cancelled = true;
    };
  }, [fixture.stateId]);

  return (
    <div class="visual-diff-pin-entry-frame">
      <Plate className="visual-diff-target visual-diff-pin-entry">
        <PinKeypad
          onSubmit={() => {
            if (fixture.stateId === "success" || fixture.stateId === "frame-004--1060ms") setSuccess(true);
          }}
          success={success ? "Pin accepted." : undefined}
        />
      </Plate>
    </div>
  );
}

const visualDiffRiveFactory: RiveFactory = (configuration) => {
  const rive = new Rive({
    ...configuration,
    onLoad: () => {
      const transitionWindow = window as VisualDiffTransitionWindow;
      transitionWindow.__visualDiffRive = rive;
      configuration.onLoad();
      queueMicrotask(() => {
        rive.stopRendering();
        document.documentElement.dataset.visualDiffRiveReady = "true";
      });
    },
    onLoadError: () => configuration.onLoadError(),
  });
  return rive;
};

function SentientIdentityFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const identity = fixture.props as SentientIdentityVariantProps;
  const [state, setState] = useState(identity.state);
  useEffect(() => {
    const transitionTo = identity.transitionTo;
    if (!transitionTo) return;
    const transitionWindow = window as VisualDiffTransitionWindow;
    transitionWindow.__startVisualDiffTransition = () => {
      setState(transitionTo);
      requestAnimationFrame(() => {
        document.documentElement.dataset.visualDiffTransitionStarted = "true";
      });
    };
    document.documentElement.dataset.visualDiffTransitionReady = "true";
    return () => {
      delete transitionWindow.__startVisualDiffTransition;
      delete transitionWindow.__visualDiffRive;
      delete document.documentElement.dataset.visualDiffTransitionReady;
      delete document.documentElement.dataset.visualDiffTransitionStarted;
      delete document.documentElement.dataset.visualDiffRiveReady;
    };
  }, [identity.transitionTo]);
  return <SentientIdentity state={state} size={56} className="visual-diff-target" riveFactory={visualDiffRiveFactory} />;
}

function applyBarTargetState(fixture: VisualDiffResolvedCase): "dirty" | "applying" | "done" {
  if (fixture.variantId === "applying" || fixture.stateId === "frame-001--0300ms") return "applying";
  if (fixture.variantId === "done" || fixture.stateId === "frame-002--0900ms") return "done";
  return "dirty";
}

function ApplyBarFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const props = fixture.props as ApplyBarVariantProps;
  const targetState = applyBarTargetState(fixture);
  const pending: PendingOpWithPayload[] = Array.from({ length: props.pendingCount }, (_, index) => ({
    key: `personalities.fixture-${index}`,
    kind: "slow" as const,
    payload: { body: "Visual review fixture" },
  }));
  const waitForRestart = targetState === "applying"
    ? () => new Promise<Awaited<ReturnType<ApplyDeps["waitForRestart"]>>>(() => {})
    : async () => ({ state: "ready" as const, elapsedMs: 900 });
  const deps: ApplyDeps = {
    saveSoul: async () => ({ ok: true }),
    saveMemoryDoc: async () => ({ ok: true }),
    saveProfile: async () => ({ ok: true }),
    savePersonalityActive: async () => ({ ok: true }),
    savePersonalityBody: async () => ({ ok: true }),
    savePersonalityCreate: async () => ({ ok: true }),
    savePersonalityDelete: async () => ({ ok: true }),
    waitForRestart,
  };

  useEffect(() => {
    if (targetState === "dirty") return;
    document.querySelector<HTMLButtonElement>(".visual-diff-apply-bar-frame .snt-button--primary")?.click();
  }, [targetState]);

  return (
    <div class="visual-diff-apply-bar-frame settings-v2">
      <ApplyBar pending={pending} deps={deps} onApplied={() => {}} onDiscard={() => {}} />
    </div>
  );
}

function PaneHeaderFixture({ fixture }: { fixture: VisualDiffResolvedCase }): JSX.Element {
  const header = fixture.props as PaneHeaderVariantProps;
  return (
    <div class="visual-diff-pane-header-frame">
      <Plate className="visual-diff-target visual-diff-pane-header">
        <PaneChrome
          eyebrow={header.eyebrow}
          title={header.title}
          subtitle={header.subtitle}
          action={<ActionButton variant="primary">{header.actionLabel}</ActionButton>}
        >
          {null}
        </PaneChrome>
      </Plate>
    </div>
  );
}

const fixtureAdapters: Readonly<Record<string, VisualDiffFixtureAdapter>> = {
  "action-button": {
    // This adapter deliberately renders the production ActionButton, not a fixture substitute.
    render: (fixture) => {
      const button = fixture.props as ActionButtonVariantProps;
      const disabled = fixture.state === "disabled";
      return (
        <ActionButton variant={button.variant} disabled={disabled} className="visual-diff-target">
          {disabled ? "Unavailable" : button.label}
        </ActionButton>
      );
    },
  },
  "icon-button": {
    // This adapter deliberately renders the production FoundationIconButton,
    // including its native button semantics and production icon anatomy.
    render: (fixture) => {
      const button = fixture.props as IconButtonVariantProps;
      const disabled = fixture.state === "disabled";
      return (
        <FoundationIconButton
          label={disabled ? "Unavailable action" : button.label}
          variant={button.variant}
          disabled={disabled}
          className="visual-diff-target"
        >
          <Icon name={button.iconName} size={16} />
        </FoundationIconButton>
      );
    },
  },
  "user-avatar": {
    // This adapter deliberately renders the production Avatar user branch and its native image semantics.
    render: (fixture) => {
      const avatar = fixture.props as UserAvatarVariantProps;
      const name = fixture.state === "disabled" ? "Unavailable user" : avatar.name;
      return (
        <Avatar
          {...avatar}
          kind="user"
          name={name}
          selected={fixture.state === "selected"}
          disabled={fixture.state === "disabled"}
        />
      );
    },
  },
  "notice": {
    // This adapter keeps the approved notice artboard while mounting the production Notice and ActionButton.
    render: (fixture) => {
      const notice = fixture.props as NoticeVariantProps;
      const action = notice.actionLabel
        ? <ActionButton variant={notice.tone === "warning" ? "quiet" : "default"}>{notice.actionLabel}</ActionButton>
        : undefined;
      return (
        <Plate className={`visual-diff-target visual-diff-notice${fixture.compact ? " visual-diff-notice--compact" : ""}`}>
          <Notice tone={notice.tone} title={notice.title} action={action}>{notice.message}</Notice>
        </Plate>
      );
    },
  },
  "media-action-card": {
    // This adapter mounts the production card and avatar primitives with the
    // reference's fixed user data. Icon/image variants stay unresolved until
    // production media ownership and failure behavior are defined.
    render: (fixture) => {
      const card = fixture.props as MediaActionCardVariantProps;
      return (
        <DominantVisualCard
          className="visual-diff-target visual-diff-media-card"
          label={card.name}
          description={card.description}
          visual={<Avatar kind="user" initial={card.initial} name={card.name} tint={card.tint} size="xl" />}
          ariaLabel={`Continue as ${card.name}`}
          onActivate={() => {}}
        />
      );
    },
  },
  "sentient-identity": {
    // This adapter mounts the production Rive-backed identity. The factory only
    // records the real runtime for deterministic capture control.
    render: (fixture) => <SentientIdentityFixture fixture={fixture} />,
  },
  "text-field": {
    // This adapter deliberately renders the production Field and its native input.
    render: (fixture) => {
      const field = fixture.props as TextFieldVariantProps;
      return (
        <Field
          label={field.label}
          value={field.value}
          className="visual-diff-text-field"
          inputClassName="visual-diff-target"
        />
      );
    },
  },
  "filter-bar": {
    // Mount the production controlled search/filter shell and shared controls;
    // fixture state is driven through the same public callbacks and trigger action.
    render: (fixture) => <FilterBarFixture fixture={fixture} />,
  },
  "search-field": {
    // The handoff's labelled, icon-free search field is the reachable generic
    // Field seam; the icon-led SearchFilterBar is covered by its composite fixture.
    render: (fixture) => {
      const field = fixture.props as SearchFieldVariantProps;
      return (
        <Field
          label={field.label}
          type="search"
          value={field.value}
          placeholder={field.placeholder}
          className="visual-diff-search-field"
          inputClassName="visual-diff-target"
        />
      );
    },
  },
  "text-area": {
    // This adapter deliberately renders the production TextArea and its native textarea.
    render: (fixture) => {
      const field = fixture.props as TextAreaVariantProps;
      return (
        <TextArea
          label={field.label}
          value={field.value}
          className="visual-diff-text-area"
          inputClassName="visual-diff-target"
        />
      );
    },
  },
  "validated-field": {
    // This adapter deliberately renders the production ValidatedField and its native input/textarea.
    render: (fixture) => {
      const field = fixture.props as ValidatedFieldVariantProps;
      return <ValidatedField {...field} className="visual-diff-validated-field" inputClassName="visual-diff-target" />;
    },
  },
  range: {
    // This adapter deliberately renders the production SliderControl and its native range input.
    render: (fixture) => {
      const range = fixture.props as RangeVariantProps;
      return (
        <div class="visual-diff-range">
          <SliderControl
            {...range}
            disabled={fixture.state === "disabled"}
            format={(value) => `${Math.round(value)}%`}
            onChange={() => {}}
          />
        </div>
      );
    },
  },
  "checkbox": {
    // This adapter deliberately renders the production native checkbox and its indeterminate effect.
    render: (fixture) => {
      if (fixture.variantId === "unchecked-to-checked") return <CheckboxTransitionFixture destination="checked" />;
      if (fixture.variantId === "unchecked-to-mixed") return <CheckboxTransitionFixture destination="mixed" />;
      const checkbox = fixture.props as CheckboxVariantProps;
      return <CheckboxControl {...checkbox} className="visual-diff-target" onChange={() => {}} />;
    },
  },
  "chip": {
    // This adapter deliberately renders the production controlled native ChipControl.
    render: (fixture) => {
      const chip = fixture.props as ChipVariantProps;
      if (fixture.variantId === "unselected-to-selected") return <ChipTransitionFixture label={chip.label} />;
      return <ChipControl selected={chip.selected}>{chip.label}</ChipControl>;
    },
  },
  "toggle": {
    // This adapter deliberately renders the production controlled native ToggleControl.
    render: (fixture) => {
      const toggle = fixture.props as ToggleVariantProps;
      if (fixture.variantId === "off-to-on") return <ToggleTransitionFixture label={toggle.label} />;
      return <ToggleControl label={toggle.label} checked={toggle.checked} onChange={() => {}} />;
    },
  },
  "segmented-control": {
    // This adapter deliberately renders the production controlled SegmentedControl
    // and its native buttons for every approved static and motion case.
    render: (fixture) => <SegmentedControlFixture fixture={fixture} />,
  },
  "settings-group": {
    // This adapter composes the production SettingsGroup with its four native
    // row/control owners on the reviewed Plate surface.
    render: (fixture) => <SettingsGroupFixture fixture={fixture} />,
  },
  "settings-editor": {
    // The fixture supplies inert local actions to prove the approved generic
    // anatomy; production settings panes retain their global Apply owner.
    render: (fixture) => {
      const editor = fixture.props as SettingsEditorVariantProps;
      return (
        <SettingsEditor
          className="visual-diff-target visual-diff-settings-editor"
          title={editor.title}
          subtitle={editor.subtitle}
          dirty={fixture.state === "unsaved"}
          footer={<><ActionButton variant="quiet">Reset</ActionButton><ActionButton variant="primary">Save</ActionButton></>}
        >
          <Field label={editor.fieldLabel} value={editor.fieldValue} />
          <TextArea label={editor.textAreaLabel} value={editor.textAreaValue} />
        </SettingsEditor>
      );
    },
  },
  "setting-row": {
    // This adapter composes the production SettingsRow with its native control
    // owner; the open native select popup remains intentionally unregistered.
    render: (fixture) => <SettingRowFixture fixture={fixture} />,
  },
  "pane-header": {
    // This adapter deliberately renders the production PaneChrome with a real Plate and ActionButton.
    render: (fixture) => <PaneHeaderFixture fixture={fixture} />,
  },
  disclosure: {
    // This adapter deliberately renders the production Disclosure and its native
    // details/summary semantics for every approved static and motion case.
    render: (fixture) => <DisclosureFixture fixture={fixture} />,
  },
  "pin-entry": {
    // Drive the production keypad through its public digit-button semantics so
    // each approved state exercises the same entry path as a user.
    render: (fixture) => <PinEntryFixture fixture={fixture} />,
  },
  "plate": {
    // This adapter deliberately renders the production Plate and its public anatomy.
    render: (fixture) => {
      const plate = fixture.props as PlateVariantProps;
      if (plate.variant !== "default") throw new Error(`Unsupported plate variant: ${plate.variant}`);
      return (
        <Plate className="visual-diff-target visual-diff-plate">
          <header class="snt-plate__head">
            <div>
              <h3 class="snt-card-title">Foundation plate</h3>
              <p class="snt-card-subtitle">Stable low-elevation surface.</p>
            </div>
          </header>
          <div class="snt-plate__body">
            <p class="visual-diff-plate__copy">Grouped content rests on a quiet slate.</p>
          </div>
        </Plate>
      );
    },
  },
  "loading-state": {
    // The handoff retains the plate host around the loading composite. The
    // state itself remains the production AsyncState used by settings, gates,
    // sessions, and voice surfaces.
    render: (fixture) => {
      const loading = fixture.props as LoadingStateVariantProps;
      return (
        <Plate className="visual-diff-target visual-diff-loading-state">
          <AsyncState state="loading" title={loading.title} message={loading.message} />
        </Plate>
      );
    },
  },
  "no-results": {
    // This adapter deliberately renders the production no-match recovery.
    render: (fixture) => {
      const noResults = fixture.props as NoResultsStateVariantProps;
      return (
        <div class="visual-diff-no-results">
          <NoResultsState {...noResults} onClear={() => {}} />
        </div>
      );
    },
  },
  "stale-banner": {
    // This adapter deliberately renders the production stale-banner composite.
    render: (fixture) => {
      const banner = fixture.props as StaleBannerVariantProps;
      if (banner.title !== "Showing saved results" || banner.detail !== "Couldn’t refresh just now." || banner.actionLabel !== "Retry") {
        throw new Error("Unsupported stale-banner fixture copy");
      }
      return (
        <StaleBanner
          checking={fixture.state === "checking"}
          className="visual-diff-stale-banner visual-diff-target"
          onRetry={() => {}}
        />
      );
    },
  },
  "apply-bar": {
    // The fixture drives the production owner through its public pending/deps
    // contract; it does not replace the async state machine with specimen DOM.
    render: (fixture) => <ApplyBarFixture fixture={fixture} />,
  },
};

function failFixture(resolution: InvalidVisualDiffCase): never {
  document.documentElement.dataset.visualDiffError = resolution.status;
  if (resolution.status === "missing-authority") {
    throw new Error(`Unsupported visual diff case: ${resolution.caseId} [missing-authority]`);
  }
  throw new Error(`Unsupported visual diff case: ${resolution.caseId} [unsupported:${resolution.reason}]`);
}

function requireReadyCase(resolution: VisualDiffCaseResolution): VisualDiffResolvedCase {
  if (resolution.status !== "ready") return failFixture(resolution);
  return resolution.case;
}

const fixture = requireReadyCase(resolveVisualDiffCase(caseId));

function requireFixtureAdapter(fixtureCase: VisualDiffResolvedCase): VisualDiffFixtureAdapter {
  const adapter = Object.hasOwn(fixtureAdapters, fixtureCase.fixtureAdapterId)
    ? fixtureAdapters[fixtureCase.fixtureAdapterId]
    : undefined;
  if (!adapter) {
    return failFixture({
      status: "missing-authority",
      caseId: fixtureCase.caseId,
      componentId: fixtureCase.componentId,
      variantId: fixtureCase.variantId,
      stateId: fixtureCase.stateId,
    });
  }
  return adapter;
}

const fixtureAdapter = requireFixtureAdapter(fixture);

function applyBarFixtureReady(fixtureCase: VisualDiffResolvedCase): boolean {
  const applyBar = document.querySelector<HTMLElement>(".visual-diff-apply-bar-frame .apply-bar");
  return applyBar?.dataset.state === applyBarTargetState(fixtureCase);
}

function pinEntryFixtureReady(stateId: string): boolean {
  const expected = stateId === "empty" || stateId === "frame-000--0000ms"
    ? { state: "idle", filled: 0 }
    : stateId === "one-digit"
      ? { state: "active", filled: 1 }
      : stateId === "partial" || stateId === "frame-001--0180ms"
        ? { state: "active", filled: stateId === "partial" ? 3 : 2 }
        : stateId === "success" || stateId === "frame-004--1060ms"
          ? { state: "success", filled: 4 }
          : { state: "checking", filled: 4 };
  const keypad = document.querySelector<HTMLElement>(".snt-pin-keypad");
  return keypad?.dataset.state === expected.state
    && keypad.querySelectorAll('[data-filled="true"]').length === expected.filled;
}

function VisualDiffFixture() {
  useEffect(() => {
    document.documentElement.dataset.visualDiffFixture = "sentient-v1";
    const markReady = () => {
      if (
        (fixture.componentId === "pin-entry" && !pinEntryFixtureReady(fixture.stateId))
        || (fixture.componentId === "apply-bar" && !applyBarFixtureReady(fixture))
      ) {
        requestAnimationFrame(markReady);
        return;
      }
      document.documentElement.dataset.visualDiffReady = "true";
    };
    requestAnimationFrame(markReady);
  }, []);

  return (
    <main class={`visual-diff-canvas visual-diff-canvas--${fixture.componentId}${fixture.componentId === "disclosure" ? " visual-diff-canvas--disclosure" : ""} snt-surface`} data-case-id={caseId} data-component-id={fixture.componentId}>
      {fixtureAdapter.render(fixture)}
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root, body, #app { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
  .visual-diff-canvas { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: transparent; box-sizing: border-box; }
  /* Common-composite handoff canvases retain their source specimen gutter. */
  .visual-diff-canvas--stale-banner { padding: 0 24px 24px 0; }
  .visual-diff-canvas--disclosure { display: block; padding: 52px 52px 0; }
  .visual-diff-plate { width: min(360px, 100%); }
  .visual-diff-stale-banner { width: min(480px, 100%); }
  .visual-diff-canvas--apply-bar { align-items: flex-start; justify-content: flex-start; padding: 52px; }
  .visual-diff-apply-bar-frame { width: 680px; min-height: 74px; display: block; }
  .visual-diff-apply-bar-frame.settings-v2 .apply-bar {
    position: static;
    width: 100%;
    transform: none;
  }
  .visual-diff-pin-entry-frame { width: min(384px, 100%); height: 496px; display: flex; align-items: flex-start; justify-content: flex-start; }
  .visual-diff-pin-entry { width: 360px; }
  /* Preserve the handoff artboard's lower breathing room around the source margin. */
  .visual-diff-no-results { width: min(468px, 100%); margin-bottom: 10px; }
  .visual-diff-text-field { width: min(320px, 100%); }
  .visual-diff-search-field { width: min(320px, 100%); }
  .visual-diff-filter-bar-frame { width: 100%; height: 100%; padding: 52px; }
  .visual-diff-filter-bar { width: 680px; overflow: visible; }
  .visual-diff-filter-bar-frame--compact { padding: 52px 76px 0 52px; }
  .visual-diff-filter-bar-frame--compact .visual-diff-filter-bar { width: 390px; }
  .visual-diff-text-area { width: min(320px, 100%); }
  .visual-diff-validated-field { width: min(320px, 100%); }
  .visual-diff-range { width: min(360px, 100%); }
  .visual-diff-notice { width: 100%; }
  .visual-diff-canvas[data-case-id^="notice--"] {
    align-items: flex-start;
    justify-content: flex-start;
    padding: 52px 76px 75px 52px;
  }
  .visual-diff-pane-header-frame {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 24px 24px 0;
  }
  .visual-diff-pane-header { width: min(620px, 100%); }
  .visual-diff-canvas[data-component-id="settings-group"],
  .visual-diff-canvas[data-component-id="setting-row"] {
    align-items: flex-start;
    justify-content: flex-start;
    padding: 52px 76px 0 52px;
  }
  .visual-diff-settings-group { width: min(650px, 100%); }
  .visual-diff-setting-row { width: 600px; }
  .visual-diff-setting-row__list { padding: 0 16px; }
  .visual-diff-canvas[data-component-id="settings-editor"] {
    align-items: flex-start;
    justify-content: flex-start;
    padding: 52px;
  }
  .visual-diff-settings-editor { width: 440px; }
  .visual-diff-media-card { width: 260px; }
  /* Composite references retain a 52px logical frame around the card. */
  .visual-diff-canvas[data-case-id^="media-action-card--"] {
    align-items: flex-start;
    justify-content: flex-start;
    box-sizing: border-box;
    padding: 52px;
  }
  .visual-diff-plate__copy { margin: 0; color: var(--color-ink-2); font-size: var(--font-size-base); line-height: var(--line-height-normal); }
  .visual-diff-canvas[data-component-id="loading-state"] { display: block; }
  .visual-diff-loading-state { width: min(260px, 100%); margin: 52px; }
  .visual-diff-disclosure { width: min(540px, 100%); }
  .visual-diff-disclosure-setting,
  .visual-diff-disclosure-paragraph {
    border: 1px solid var(--color-line-soft);
    border-radius: var(--radius-sm);
    background: var(--slate-face);
    box-shadow: var(--plate-shadow);
  }
  .visual-diff-disclosure-setting {
    min-height: 68px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 18px;
    padding: 12px 14px;
  }
  .visual-diff-disclosure-setting > div { min-width: 0; }
  .visual-diff-disclosure-setting strong { display: block; color: var(--color-ink); font-size: 14px; font-weight: 500; }
  .visual-diff-disclosure-setting span { display: block; margin-top: 3px; color: var(--color-ink-2); font-size: var(--font-size-sm); line-height: 1.5; }
  .visual-diff-disclosure-paragraph { margin: 0; padding: 14px; color: var(--color-ink-2); font-size: var(--font-size-sm); line-height: 1.5; }
`;
document.head.append(style);

const root = document.getElementById("app");
if (!root) throw new Error("missing visual diff fixture root");
render(<VisualDiffFixture />, root);
