// gateway/webui/src/components/wizard/steps/step-admin.tsx
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { AccountWizard } from "../../account-wizard/AccountWizard.tsx";
import type { StepProps } from "../step-registry.tsx";

const log = createLogger(["sentient", "webui", "wizard", "step-admin"]);

export function StepAdmin({ onAdvance }: StepProps): JSX.Element {
  log.debug("render");
  return (
    <AccountWizard
      mode="first-admin"
      nested={true}
      onComplete={() => void onAdvance()}
    />
  );
}
