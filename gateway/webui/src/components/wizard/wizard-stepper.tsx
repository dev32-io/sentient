import type { JSX } from "preact";
import { WIZARD_STEPS, type WizardStepId } from "@sentient/wizard";

export interface WizardStepperProps {
  current: WizardStepId;
}

export function WizardStepper({ current }: WizardStepperProps): JSX.Element {
  const idx = WIZARD_STEPS.findIndex((s) => s.id === current);
  return (
    <ol class="wizard-stepper">
      {WIZARD_STEPS.map((s, i) => (
        <li
          key={s.id}
          class={`wizard-stepper__item ${i === idx ? "is-current" : i < idx ? "is-done" : ""}`}
        >
          <span class="wizard-stepper__dot" />
          <span class="wizard-stepper__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
