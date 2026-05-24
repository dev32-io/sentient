import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface StepVoiceProps { onAdvance: () => Promise<void>; }

export function StepVoice({ onAdvance }: StepVoiceProps): JSX.Element {
  const [mode, setMode] = useState<"setup" | "skip">("setup");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function continueStep() {
    setBusy(true);
    try {
      const body = mode === "skip" ? { skip: true } : { api_key: apiKey };
      const res = await fetch("/api/v1/wizard/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) await onAdvance();
    } finally { setBusy(false); }
  }

  const canContinue = !busy && (mode === "skip" || apiKey.length > 0);

  return (
    <section class="step-voice">
      <h2>Voice replies</h2>
      <p>Sentient uses Fish Audio for spoken responses. Skip if you want text-only — you can add it later in Secrets.</p>
      <fieldset>
        <label><input type="radio" checked={mode === "setup"} onChange={() => setMode("setup")} /> Set up Fish Audio</label>
        <input
          type="password"
          placeholder="fa-..."
          value={apiKey}
          disabled={mode === "skip"}
          onInput={e => setApiKey((e.target as HTMLInputElement).value)}
        />
        <label><input type="radio" checked={mode === "skip"} onChange={() => setMode("skip")} /> Skip — text only for now</label>
      </fieldset>
      <footer>
        <button type="button" disabled={!canContinue} onClick={continueStep}>{busy ? "Saving..." : "Continue"}</button>
      </footer>
    </section>
  );
}
