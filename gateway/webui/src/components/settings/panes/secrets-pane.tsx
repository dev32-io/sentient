// gateway/webui/src/components/settings/panes/secrets-pane.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { createAdminApi } from "../../../services/admin-api.ts";
import type { LlmProvider, SecretsStatus } from "../../../services/admin-api.ts";
import type { PendingOpWithPayload } from "../apply-bar/apply-bar-machine.ts";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { CustomRow, SecretRow } from "./secret-row.tsx";
import type { EditingKey } from "./secret-row.tsx";

const log = createLogger(["sentient", "webui", "settings", "secrets"]);
const api = createAdminApi();

export interface SecretsPaneProps {
  /** Push a slow op into the settings-view imperative queue so the apply
   *  bar surfaces and the operator can restart the user's hermes worker
   *  to pick up the new secret. Single-shot key — repeat saves coalesce. */
  onMark: (op: PendingOpWithPayload) => void;
}

const RESTART_OP: PendingOpWithPayload = {
  key: "secrets.changed",
  kind: "slow",
  payload: null,
};

// --- SecretsPane -------------------------------------------------------------

export function SecretsPane({ onMark }: SecretsPaneProps): JSX.Element {
  const auth = useAuth();
  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const [data, setData] = useState<SecretsStatus | null>(null);
  const [editing, setEditing] = useState<EditingKey>(null);

  async function refresh() {
    const result = await api.getSecretsStatus(token);
    if (result.ok) {
      setData(result.value);
    } else {
      log.warn("secrets.load.failed", { status: result.error.status });
    }
  }

  if (!data && isAuthed) {
    void refresh();
  }

  async function saveLlmKey(provider: LlmProvider, newKey: string) {
    await api.setLlmProviderKey(token, provider, { api_key: newKey });
    setEditing(null);
    await refresh();
    onMark(RESTART_OP);
  }

  async function saveLlmBaseUrl(provider: LlmProvider, newUrl: string) {
    await api.setLlmProviderKey(token, provider, { base_url: newUrl });
    setEditing(null);
    await refresh();
    onMark(RESTART_OP);
  }

  async function saveFishKey(newKey: string) {
    await api.setFishAudioKey(token, newKey);
    setEditing(null);
    await refresh();
    onMark(RESTART_OP);
  }

  async function setActive(provider: LlmProvider) {
    await api.setActiveLlmProvider(token, provider);
    await refresh();
    onMark(RESTART_OP);
  }

  if (!isAuthed) return <PaneHead title="Provider keys" sub="Sign in to manage keys." />;
  if (!data) return <PaneHead title="Provider keys" sub="Loading…" />;

  const { llm, tts } = data;

  return (
    <>
      <PaneHead title="Provider keys" sub="Encrypted at rest. Shared by the household gateway." />
      <Card title="Active keys" sub="Update replaces the stored key.">
        <div class="lst">
          <SecretRow
            label="OpenRouter"
            providerKey="openrouter"
            status={llm.openrouter}
            isActive={llm.active === "openrouter"}
            onSetActive={() => void setActive("openrouter")}
            editing={editing === "openrouter"}
            onStartEdit={() => setEditing("openrouter")}
            onCancel={() => setEditing(null)}
            onSave={(k) => saveLlmKey("openrouter", k)}
          />
          <SecretRow
            label="Ollama Cloud"
            providerKey="ollama-cloud"
            status={llm.ollama_cloud}
            isActive={llm.active === "ollama-cloud"}
            onSetActive={() => void setActive("ollama-cloud")}
            editing={editing === "ollama-cloud"}
            onStartEdit={() => setEditing("ollama-cloud")}
            onCancel={() => setEditing(null)}
            onSave={(k) => saveLlmKey("ollama-cloud", k)}
          />
          <CustomRow
            status={llm.custom}
            isActive={llm.active === "custom"}
            onSetActive={() => void setActive("custom")}
            editingKey={editing}
            onStartEditKey={() => setEditing("custom")}
            onStartEditUrl={() => setEditing("custom-baseurl")}
            onCancel={() => setEditing(null)}
            onSaveKey={(k) => saveLlmKey("custom", k)}
            onSaveUrl={(u) => saveLlmBaseUrl("custom", u)}
          />
          <SecretRow
            label="Fish Audio"
            providerKey="fish-audio"
            status={tts.fish_audio}
            editing={editing === "fish-audio"}
            onStartEdit={() => setEditing("fish-audio")}
            onCancel={() => setEditing(null)}
            onSave={(k) => saveFishKey(k)}
          />
        </div>
      </Card>
    </>
  );
}
