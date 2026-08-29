import { render } from "preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import { ActionButton, CheckboxControl, ChipControl, Field, FoundationIconButton, Plate } from "../components/common/foundation.tsx";
import { TextArea } from "../components/common/foundation/fields.tsx";
import { Icon } from "../components/common/icon.tsx";
import {
  type ActionButtonVariantProps,
  type CheckboxVariantProps,
  type ChipVariantProps,
  type IconButtonVariantProps,
  type PlateVariantProps,
  type TextAreaVariantProps,
  type TextFieldVariantProps,
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
    <main class="visual-diff-canvas snt-surface" data-case-id={caseId}>
      {fixtureAdapter.render(fixture)}
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
  :root, body, #app { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
  .visual-diff-canvas { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: transparent; }
  .visual-diff-plate { width: min(360px, 100%); }
  .visual-diff-text-field { width: min(320px, 100%); }
  .visual-diff-text-area { width: min(320px, 100%); }
  .visual-diff-plate__copy { margin: 0; color: var(--color-ink-2); font-size: var(--font-size-base); line-height: var(--line-height-normal); }
`;
document.head.append(style);

const root = document.getElementById("app");
if (!root) throw new Error("missing visual diff fixture root");
render(<VisualDiffFixture />, root);
