// gateway/webui/src/components/account-wizard/step-voice.tsx
//
// Informational step: local-tts has no browseable prebuilt voice catalog.
// The account starts on the built-in default voice; users clone their own
// voice later in Settings → Voices (Task 16, web UI only cloning).
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileV1 } from "../../services/profile-api.ts";
import { Btn } from "../settings/primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "account-wizard", "step-voice"]);

export interface StepVoiceProps {
  draft: ProfileV1;
  onNext: () => void;
  onBack: () => void;
  onCancel?: () => void;
}

export function StepVoice({ draft, onNext, onBack, onCancel }: StepVoiceProps): JSX.Element {
  log.debug("render", { voiceId: draft.voice.id });

  return (
    <section class="aw-step aw-step-voice">
      <header class="aw-step-head">
        <h2 class="aw-step__title">Voice</h2>
        <p class="aw-step__sub">
          Your assistant will use its default voice. You can record or upload your own voice
          anytime in Settings → Voices.
        </p>
      </header>

      <footer class="aw-footer">
        {onCancel && <Btn kind="ghost" onClick={onCancel}>Cancel</Btn>}
        <span class="aw-footer__spacer" />
        <Btn kind="secondary" onClick={onBack}>Back</Btn>
        <Btn kind="primary" onClick={onNext}>Next</Btn>
      </footer>
    </section>
  );
}
