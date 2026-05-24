// gateway/webui/src/components/wizard/wizard-shell.tsx
import type { JSX } from "preact";
import { findStep, type WizardStepId } from "@sentient/wizard";
import { createLogger } from "@sentient/web-sdk";
import type { InstallState } from "../../hooks/use-install-state.ts";
import { WizardStepper } from "./wizard-stepper.tsx";
import { UnlockGate } from "./unlock-gate.tsx";
import { STEP_COMPONENTS } from "./step-registry.tsx";

const log = createLogger(["sentient", "webui", "wizard", "shell"]);

export interface WizardShellProps {
  state: InstallState;
  onChange: () => Promise<void>;
}

async function postBack(from: WizardStepId): Promise<boolean> {
  const res = await fetch("/api/v1/wizard/back", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from }),
  });
  return res.ok;
}

export function WizardShell({ state, onChange }: WizardShellProps): JSX.Element {
  if (!state.unlock_verified) {
    return (
      <div class="wizard-page">
        <div class="wizard-box">
          <UnlockGate onUnlocked={onChange} />
        </div>
      </div>
    );
  }

  const def = findStep(state.wizard_cursor);
  const Step = STEP_COMPONENTS[state.wizard_cursor];

  async function handleBack(): Promise<void> {
    if (!def?.backTo) return;
    const ok = await postBack(def.id);
    if (!ok) log.warn("back.failed", { from: def.id });
    await onChange();
  }

  return (
    <div class="wizard-page">
      <div class="wizard-box">
        <header class="wizard-box__header">
          <h1>Welcome to Sentient</h1>
          <WizardStepper current={state.wizard_cursor} />
        </header>
        <div class="wizard-box__content">
          <Step
            onAdvance={onChange}
            {...(def?.backTo ? { onBack: handleBack } : {})}
          />
        </div>
      </div>
    </div>
  );
}
