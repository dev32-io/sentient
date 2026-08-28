import { render } from "preact";
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import { ActionButton } from "../components/common/foundation.tsx";
import {
  type ActionButtonVariantProps,
  resolveVisualDiffCase,
  type VisualDiffCaseResolution,
  type VisualDiffResolvedCase,
} from "./visual-diff-cases.ts";

const caseId = new URLSearchParams(location.search).get("case") ?? "";

type InvalidVisualDiffCase = Exclude<VisualDiffCaseResolution, { status: "ready" }>;
interface VisualDiffFixtureAdapter {
  render(fixture: VisualDiffResolvedCase): JSX.Element;
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
`;
document.head.append(style);

const root = document.getElementById("app");
if (!root) throw new Error("missing visual diff fixture root");
render(<VisualDiffFixture />, root);
