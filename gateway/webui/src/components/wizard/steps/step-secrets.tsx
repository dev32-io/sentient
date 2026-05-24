import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "wizard", "step-secrets"]);

export interface StepSecretsProps { onAdvance: () => Promise<void>; }

export function StepSecrets({ onAdvance }: StepSecretsProps): JSX.Element {
  const [haUrl, setHaUrl] = useState("");
  const [haLocalIp, setHaLocalIp] = useState("");
  const [haObserve, setHaObserve] = useState("");
  const [haMcp, setHaMcp] = useState("");
  const [maUrl, setMaUrl] = useState("");
  const [maLocalIp, setMaLocalIp] = useState("");
  const [maToken, setMaToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function next() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        home_assistant: {
          url: haUrl,
          local_ip: haLocalIp,
          observe_token: haObserve,
          mcp_server_token: haMcp,
        },
        music_assistant: {
          url: maUrl,
          local_ip: maLocalIp,
          token: maToken,
        },
      };
      const finish = await fetch("/api/v1/wizard/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!finish.ok) {
        const payload = await finish.json().catch(() => null);
        setErr(payload?.error === "secrets-write-failed" ? "Could not save credentials. Check the gateway log." : "Failed to start services.");
        return;
      }

      log.info("step-secrets.advance", {});
      await onAdvance();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="step-secrets">
      <h2>Connect smart-home services (optional)</h2>
      <p>If you use Home Assistant or Music Assistant, give Sentient access here. Skip any field you don't use.</p>

      <fieldset>
        <legend>Home Assistant</legend>
        <label>
          URL
          <input
            type="text"
            placeholder="https://homeassistant.local:8123"
            value={haUrl}
            onInput={(e) => setHaUrl((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          LAN IP <span>(only if URL hostname is mDNS / not routable from docker)</span>
          <input
            type="text"
            placeholder="192.168.1.50"
            value={haLocalIp}
            onInput={(e) => setHaLocalIp((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Observer token <span>(read-only)</span>
          <input
            type="password"
            value={haObserve}
            onInput={(e) => setHaObserve((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          MCP token <span>(write access for tools)</span>
          <input
            type="password"
            value={haMcp}
            onInput={(e) => setHaMcp((e.target as HTMLInputElement).value)}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Music Assistant</legend>
        <label>
          URL
          <input
            type="text"
            placeholder="http://mass.local:8095"
            value={maUrl}
            onInput={(e) => setMaUrl((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          LAN IP <span>(required if URL hostname is mDNS / not routable from docker)</span>
          <input
            type="text"
            placeholder="192.168.1.50"
            value={maLocalIp}
            onInput={(e) => setMaLocalIp((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          Token
          <input
            type="password"
            value={maToken}
            onInput={(e) => setMaToken((e.target as HTMLInputElement).value)}
          />
        </label>
      </fieldset>

      {err && <p class="step-secrets__error">{err}</p>}

      <footer>
        <button type="button" disabled={busy} onClick={next}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </footer>
    </section>
  );
}
