import { render } from "preact";
import { useEffect } from "preact/hooks";
import "../styles/tokens/design-foundation-v2.css";
import "../components/common/foundation.css";
import { ActionButton } from "../components/common/foundation.tsx";
import { actionButtonCase } from "./visual-diff-cases.ts";

const caseId = new URLSearchParams(location.search).get("case") ?? "";

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
