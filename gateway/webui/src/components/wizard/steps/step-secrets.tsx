import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { ActionButton, Field, Plate } from "../../common/foundation.tsx";
import { Notice } from "../../common/composites.tsx";

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

      <Plate className="wizard-fieldset">
        <h3>Home Assistant</h3>
        <Field label="URL" placeholder="https://homeassistant.local:8123" value={haUrl} onInput={(event) => setHaUrl(event.currentTarget.value)} />
        <Field label="LAN IP" hint="Only needed when the hostname is not reachable from the assistant." placeholder="192.168.1.50" value={haLocalIp} onInput={(event) => setHaLocalIp(event.currentTarget.value)} />
        <Field label="Observer token" hint="Read-only access" type="password" value={haObserve} onInput={(event) => setHaObserve(event.currentTarget.value)} />
        <Field label="Tool access token" hint="Write access for approved actions" type="password" value={haMcp} onInput={(event) => setHaMcp(event.currentTarget.value)} />
      </Plate>

      <Plate className="wizard-fieldset">
        <h3>Music Assistant</h3>
        <Field label="URL" placeholder="http://mass.local:8095" value={maUrl} onInput={(event) => setMaUrl(event.currentTarget.value)} />
        <Field label="LAN IP" hint="Required when the hostname is not reachable from the assistant." placeholder="192.168.1.50" value={maLocalIp} onInput={(event) => setMaLocalIp(event.currentTarget.value)} />
        <Field label="Token" type="password" value={maToken} onInput={(event) => setMaToken(event.currentTarget.value)} />
      </Plate>

      {err && <Notice tone="error">{err}</Notice>}

      <footer>
        <ActionButton variant="primary" loading={busy} onClick={() => void next()}>Continue</ActionButton>
      </footer>
    </section>
  );
}
