import { useState } from "preact/hooks";
import type { JSX } from "preact";

export interface UnlockGateProps {
  onUnlocked: () => void;
}

export function UnlockGate({ onUnlocked }: UnlockGateProps): JSX.Element {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/wizard/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        onUnlocked();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error === "wrong-code" ? "Wrong code." : "Unlock failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="wizard-unlock">
      <h1>Verify it&apos;s you</h1>
      <p>An unlock code was printed to the gateway logs on first boot. Find it in:</p>
      <pre><code>docker compose logs sentient-gateway</code></pre>
      <p>Or run on the host:</p>
      <pre><code>cat ~/.sentient/.bootstrap-unlock</code></pre>
      <input
        type="text"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoFocus
        value={code}
        onInput={e => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
        placeholder="6-digit code"
      />
      {error && <p class="wizard-unlock__error">{error}</p>}
      <button
        type="button"
        disabled={busy || code.length !== 6}
        onClick={submit}
      >
        {busy ? "Verifying..." : "Verify and start"}
      </button>
    </section>
  );
}
