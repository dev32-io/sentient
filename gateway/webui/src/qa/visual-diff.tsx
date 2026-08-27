import { render } from "preact";
import { useEffect } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import { ActionButton } from "../components/common/foundation.tsx";

const caseId = new URLSearchParams(location.search).get("case") ?? "";

interface ActionButtonCase {
  variant: "primary" | "default" | "quiet" | "destructive";
  label: string;
  disabled: boolean;
}

function actionButtonCase(id: string): ActionButtonCase | undefined {
  const match = /^action-button--(primary|secondary|quiet|destructive)--(?:compact-)?(?:rest|hover|focus|pressed|disabled)$/.exec(id);
  if (!match) return undefined;
  const role = match[1] as "primary" | "secondary" | "quiet" | "destructive";
  return {
    variant: role === "secondary" ? "default" : role,
    label: role === "primary" ? "Allow once" : role === "secondary" ? "Always allow" : role === "quiet" ? "Not now" : "Stop",
    disabled: id.endsWith("--disabled"),
  };
}

function VisualDiffFixture() {
  const button = actionButtonCase(caseId);
  useEffect(() => {
    document.documentElement.dataset.visualDiffFixture = "sentient-v1";
    requestAnimationFrame(() => {
      document.documentElement.dataset.visualDiffReady = "true";
    });
  }, []);

  if (!button) {
    throw new Error(`Unsupported visual diff case: ${caseId}`);
  }

  return (
    <main class="visual-diff-canvas snt-surface" data-case-id={caseId}>
      <ActionButton variant={button.variant} disabled={button.disabled} className="visual-diff-target">
        {button.label}
      </ActionButton>
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
