import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { ActionButton } from "../../common/foundation.tsx";

export interface StepVoiceProps {
  onAdvance: () => Promise<void>;
}

// Informational step: local-tts has no setup requirement (no API key). The
// account starts on the built-in default voice; users clone their own voice
// later in Settings → Voices (web UI only, Task 16). This step just
// acknowledges and advances the wizard cursor — see
// gateway/src/api/wizard/steps/voice.ts.
export function StepVoice({ onAdvance }: StepVoiceProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function continueStep(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wizard/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) await onAdvance();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="step-voice">
      <h2>Voice replies</h2>
      <p>
        Sentient uses a local, on-device voice model for spoken responses — no API key needed. You
        can record or upload your own voice later in Settings → Voices.
      </p>
      <footer>
        <ActionButton variant="primary" loading={busy} onClick={() => void continueStep()}>Continue</ActionButton>
      </footer>
    </section>
  );
}
