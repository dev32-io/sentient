import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { StepProps } from "../step-registry.tsx";

export function StepFinish({ onAdvance: _onAdvance }: StepProps): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function finish() {
    setBusy(true);
    try {
      const res = await fetch("/api/v1/wizard/finalize", { method: "POST" });
      if (res.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="step-finish">
      <h2>All set</h2>
      <ul>
        <li>✓ Provider configured</li>
        <li>✓ Voice configured</li>
        <li>✓ Setup complete</li>
      </ul>
      <button type="button" disabled={busy} onClick={finish}>
        {busy ? "Finalizing..." : "Take me in →"}
      </button>
    </section>
  );
}
