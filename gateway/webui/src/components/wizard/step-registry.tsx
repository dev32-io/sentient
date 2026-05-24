// gateway/webui/src/components/wizard/step-registry.tsx
import type { ComponentType } from "preact";
import type { WizardStepId } from "@sentient/wizard";
import { StepAdmin } from "./steps/step-admin.tsx";
import { StepBringup } from "./steps/step-bringup.tsx";
import { StepFinish } from "./steps/step-finish.tsx";
import { StepProvider } from "./steps/step-provider.tsx";
import { StepSecrets } from "./steps/step-secrets.tsx";
import { StepVoice } from "./steps/step-voice.tsx";

/** Unified prop contract for all wizard steps. */
export interface StepProps {
  onAdvance: () => Promise<void>;
  onBack?: () => Promise<void>;
}

export const STEP_COMPONENTS: Record<WizardStepId, ComponentType<StepProps>> = {
  provider: StepProvider as ComponentType<StepProps>,
  voice:    StepVoice    as ComponentType<StepProps>,
  secrets:  StepSecrets  as ComponentType<StepProps>,
  bringup:  StepBringup  as ComponentType<StepProps>,
  admin:    StepAdmin    as ComponentType<StepProps>,
  finish:   StepFinish   as ComponentType<StepProps>,
};
