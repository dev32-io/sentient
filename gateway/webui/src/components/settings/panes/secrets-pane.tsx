import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { createAdminApi, type LlmProvider, type SecretsStatus } from "../../../services/admin-api.ts";
import type { PendingOpWithPayload } from "../apply-bar/apply-bar-machine.ts";
import { ActionButton, AsyncState, PaneChrome, SettingsCard } from "../../common/index.ts";
import { CustomRow, SecretRow, type EditingKey } from "./secret-row.tsx";

const log = createLogger(["sentient", "webui", "settings", "secrets"]);
const APPLY_SECRETS_OP: PendingOpWithPayload = { key: "secrets.changed", kind: "slow", payload: null };
type LoadState = "loading" | "ready" | "forbidden" | "error";

export interface SecretsPaneProps { onMark: (op: PendingOpWithPayload) => void; }

export function SecretsPane({ onMark }: SecretsPaneProps): JSX.Element {
  const auth = useAuth();
  const api = useMemo(() => createAdminApi(), []);
  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const [data, setData] = useState<SecretsStatus | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [editing, setEditing] = useState<EditingKey>(null);

  const refresh = useCallback(async () => {
    if (!isAuthed) return;
    setLoadState("loading");
    const result = await api.getSecretsStatus(token);
    if (result.ok) {
      setData(result.value);
      setLoadState("ready");
    } else {
      log.warn("secrets.load.failed", { status: result.error.status, code: result.error.code });
      setData(null);
      setLoadState(result.error.status === 403 ? "forbidden" : "error");
    }
  }, [api, isAuthed, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const requireSuccess = async (operation: Promise<{ ok: boolean; error?: { status?: number; code?: string } }>) => {
    const result = await operation;
    if (result.ok) return;
    if (result.error?.status === 403) setLoadState("forbidden");
    throw new Error(result.error?.code ?? "save-failed");
  };

  const saveLlmKey = async (provider: LlmProvider, newKey: string) => {
    await requireSuccess(api.setLlmProviderKey(token, provider, { api_key: newKey }));
    setEditing(null);
    await refresh();
    onMark(APPLY_SECRETS_OP);
  };
  const saveLlmBaseUrl = async (provider: LlmProvider, newUrl: string) => {
    await requireSuccess(api.setLlmProviderKey(token, provider, { base_url: newUrl }));
    setEditing(null);
    await refresh();
    onMark(APPLY_SECRETS_OP);
  };
  const setActive = async (provider: LlmProvider) => {
    const result = await api.setActiveLlmProvider(token, provider);
    if (!result.ok) {
      setLoadState(result.error.status === 403 ? "forbidden" : "error");
      return;
    }
    await refresh();
    onMark(APPLY_SECRETS_OP);
  };

  if (!isAuthed) return <PaneChrome title="Provider keys" subtitle="Sign in to manage keys." className="owned-pane">{null}</PaneChrome>;

  return (
    <PaneChrome title="Provider keys" subtitle="Stored securely. This page reports presence only and never retrieves stored values." className="owned-pane">
      {loadState === "loading" && <AsyncState state="loading" title="Loading key status" />}
      {loadState === "forbidden" && <AsyncState state="error" title="Admin access required" message="Your account no longer has permission to manage provider keys." action={<ActionButton onClick={() => void refresh()}>Try again</ActionButton>} />}
      {loadState === "error" && <AsyncState state="error" title="Key status unavailable" message="Stored key presence could not be loaded." action={<ActionButton onClick={() => void refresh()}>Try again</ActionButton>} />}
      {loadState === "ready" && data && (
        <SettingsCard title="Provider keys" subtitle="Updating a field replaces its stored value.">
          <SecretRow label="OpenRouter" status={data.llm.openrouter} isActive={data.llm.active === "openrouter"} onSetActive={() => void setActive("openrouter")} editing={editing === "openrouter"} onStartEdit={() => setEditing("openrouter")} onCancel={() => setEditing(null)} onSave={(key) => saveLlmKey("openrouter", key)} />
          <SecretRow label="Ollama Cloud" status={data.llm.ollama_cloud} isActive={data.llm.active === "ollama-cloud"} onSetActive={() => void setActive("ollama-cloud")} editing={editing === "ollama-cloud"} onStartEdit={() => setEditing("ollama-cloud")} onCancel={() => setEditing(null)} onSave={(key) => saveLlmKey("ollama-cloud", key)} />
          <CustomRow status={data.llm.custom} isActive={data.llm.active === "custom"} onSetActive={() => void setActive("custom")} editingKey={editing} onStartEditKey={() => setEditing("custom")} onStartEditUrl={() => setEditing("custom-baseurl")} onCancel={() => setEditing(null)} onSaveKey={(key) => saveLlmKey("custom", key)} onSaveUrl={(url) => saveLlmBaseUrl("custom", url)} />
        </SettingsCard>
      )}
    </PaneChrome>
  );
}
