import { Rive } from "@rive-app/canvas";
import { render } from "preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import "../components/common/composites.css";
import { ActionButton, CheckboxControl, ChipControl, Field, FoundationIconButton, Plate, SegmentedControl, SliderControl, ToggleControl } from "../components/common/foundation.tsx";
import { AsyncState } from "../components/common/composites.tsx";
import { Avatar } from "../components/common/avatar.tsx";
import { SentientIdentity, type RiveFactory } from "../components/common/sentient-identity.tsx";
import { TextArea } from "../components/common/foundation/fields.tsx";
import { Icon } from "../components/common/icon.tsx";
import { Notice } from "../components/common/composites.tsx";
import {
  type ActionButtonVariantProps,
  type CheckboxVariantProps,
  type ChipVariantProps,
  type IconButtonVariantProps,
  type LoadingStateVariantProps,
  type NoticeVariantProps,
  type PlateVariantProps,
  type RangeVariantProps,
  type SearchFieldVariantProps,
  type SegmentedControlVariantProps,
  type SentientIdentityVariantProps,
  type TextAreaVariantProps,
  type TextFieldVariantProps,
  type ToggleVariantProps,
  type UserAvatarVariantProps,
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
  "search-field": {
    // The handoff's labelled, icon-free search field is the reachable generic
    // Field seam; the unused icon-led SearchField/SearchFilterBar wrapper is not mounted.
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

function VisualDiffFixture() {
  useEffect(() => {
    document.documentElement.dataset.visualDiffFixture = "sentient-v1";
    requestAnimationFrame(() => {
      document.documentElement.dataset.visualDiffReady = "true";
    });
  }, []);

  return (
    <main class="visual-diff-canvas snt-surface" data-case-id={caseId} data-component-id={fixture.componentId}>
      {fixtureAdapter.render(fixture)}
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root, body, #app { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
  .visual-diff-canvas { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: transparent; box-sizing: border-box; }
  .visual-diff-plate { width: min(360px, 100%); }
  .visual-diff-text-field { width: min(320px, 100%); }
  .visual-diff-search-field { width: min(320px, 100%); }
  .visual-diff-text-area { width: min(320px, 100%); }
  .visual-diff-range { width: min(360px, 100%); }
  .visual-diff-notice { width: 100%; }
  .visual-diff-canvas[data-case-id^="notice--"] {
    align-items: flex-start;
    justify-content: flex-start;
    padding: 52px 76px 75px 52px;
  }
  .visual-diff-plate__copy { margin: 0; color: var(--color-ink-2); font-size: var(--font-size-base); line-height: var(--line-height-normal); }
  .visual-diff-canvas[data-component-id="loading-state"] { display: block; }
  .visual-diff-loading-state { width: min(260px, 100%); margin: 52px; }
`;
document.head.append(style);

const root = document.getElementById("app");
if (!root) throw new Error("missing visual diff fixture root");
render(<VisualDiffFixture />, root);
