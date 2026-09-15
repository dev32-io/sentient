import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../../hooks/use-auth.tsx";
import { createAdminApi, type ApnsCredentialsInput, type ApnsCredentialsStatus, type LlmProvider, type SecretsStatus } from "../../../services/admin-api.ts";
import type { PendingOpWithPayload } from "../apply-bar/apply-bar-machine.ts";
import { ActionButton, AsyncState, PaneChrome, SettingsCard, SettingsGroup, SettingsRow } from "../../common/index.ts";
import { ApnsCredentialsDialog } from "./apns-credentials-dialog.tsx";
import { CustomRow, SecretRow, type EditingKey } from "./secret-row.tsx";

import { useSettingsBusyState } from "../navigation-state.ts";

const log = createLogger(["sentient", "webui", "settings", "secrets"]);
const APPLY_SECRETS_OP: PendingOpWithPayload = { key: "secrets.changed", kind: "slow", payload: null };
const EMPTY_APNS_STATUS: ApnsCredentialsStatus = { has_key: false, has_key_id: false, has_team_id: false };
type LoadState = "loading" | "ready" | "forbidden" | "error";

function apnsPresence(status: ApnsCredentialsStatus): string {
  if (status.has_key && status.has_key_id && status.has_team_id) return "Configured";
  if (status.has_key || status.has_key_id || status.has_team_id) return "Incomplete";
  return "Not configured";
}

export interface SecretsPaneProps { onMark: (op: PendingOpWithPayload) => void; }

export function SecretsPane({ onMark }: SecretsPaneProps): JSX.Element {
  const auth = useAuth();
  const [, setBusy] = useSettingsBusyState();
  const api = useMemo(() => createAdminApi(), []);
  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  const [data, setData] = useState<SecretsStatus | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [editing, setEditing] = useState<EditingKey>(null);
  const [apnsOpen, setApnsOpen] = useState(false);

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
    setBusy(true);
    try {
      await requireSuccess(api.setLlmProviderKey(token, provider, { api_key: newKey }));
      setEditing(null);
      await refresh();
      onMark(APPLY_SECRETS_OP);
    } finally { setBusy(false); }
  };
  const saveLlmBaseUrl = async (provider: LlmProvider, newUrl: string) => {
    setBusy(true);
    try {
      await requireSuccess(api.setLlmProviderKey(token, provider, { base_url: newUrl }));
      setEditing(null);
      await refresh();
      onMark(APPLY_SECRETS_OP);
    } finally { setBusy(false); }
  };
  const setActive = async (provider: LlmProvider) => {
    setBusy(true);
    try {
      const result = await api.setActiveLlmProvider(token, provider);
      if (!result.ok) {
        setLoadState(result.error.status === 403 ? "forbidden" : "error");
        return;
      }
      await refresh();
      onMark(APPLY_SECRETS_OP);
    } finally { setBusy(false); }
  };
  const saveApnsCredentials = async (input: ApnsCredentialsInput) => {
    const result = await api.setApnsCredentials(token, input);
    if (!result.ok) throw new Error(result.error.code);
  };
  const applyApnsCredentials = async () => {
    const result = await api.applyApnsCredentials(token);
    if (!result.ok) throw new Error(result.error.code);
  };
  const markApnsConfigured = () => setData((current) => current ? {
    ...current,
    push: { has_key: true, has_key_id: true, has_team_id: true },
  } : current);

  if (!isAuthed) return <PaneChrome title="Provider keys" subtitle="Sign in to manage keys." className="owned-pane">{null}</PaneChrome>;

  return (
    <PaneChrome title="Provider keys" subtitle="Stored securely. This page reports presence only and never retrieves stored values." className="owned-pane">
      {loadState === "loading" && <AsyncState state="loading" title="Loading key status" />}
      {loadState === "forbidden" && <AsyncState state="error" title="Admin access required" message="Your account no longer has permission to manage provider keys." action={<ActionButton onClick={() => void refresh()}>Try again</ActionButton>} />}
      {loadState === "error" && <AsyncState state="error" title="Key status unavailable" message="Stored key presence could not be loaded." action={<ActionButton onClick={() => void refresh()}>Try again</ActionButton>} />}
      {loadState === "ready" && data && (
        <SettingsCard title="Provider keys" subtitle="Updating a field replaces its stored value." padded={false}>
          <SettingsGroup>
            <SecretRow label="OpenRouter" status={data.llm.openrouter} isActive={data.llm.active === "openrouter"} onSetActive={() => void setActive("openrouter")} editing={editing === "openrouter"} onStartEdit={() => setEditing("openrouter")} onCancel={() => setEditing(null)} onSave={(key) => saveLlmKey("openrouter", key)} />
            <SecretRow label="Ollama Cloud" status={data.llm.ollama_cloud} isActive={data.llm.active === "ollama-cloud"} onSetActive={() => void setActive("ollama-cloud")} editing={editing === "ollama-cloud"} onStartEdit={() => setEditing("ollama-cloud")} onCancel={() => setEditing(null)} onSave={(key) => saveLlmKey("ollama-cloud", key)} />
            <CustomRow status={data.llm.custom} isActive={data.llm.active === "custom"} onSetActive={() => void setActive("custom")} editingKey={editing} onStartEditKey={() => setEditing("custom")} onStartEditUrl={() => setEditing("custom-baseurl")} onCancel={() => setEditing(null)} onSaveKey={(key) => saveLlmKey("custom", key)} onSaveUrl={(url) => saveLlmBaseUrl("custom", url)} />
            <SettingsRow label="Apple Push Notifications" hint={apnsPresence(data.push ?? EMPTY_APNS_STATUS)}>
              <ActionButton variant="quiet" onClick={() => setApnsOpen(true)}>Update</ActionButton>
            </SettingsRow>
          </SettingsGroup>
        </SettingsCard>
      )}
      {apnsOpen && data && (
        <ApnsCredentialsDialog
          status={data.push ?? EMPTY_APNS_STATUS}
          onSave={saveApnsCredentials}
          onApply={applyApnsCredentials}
          onCredentialsSaved={markApnsConfigured}
          onClose={() => setApnsOpen(false)}
        />
      )}
    </PaneChrome>
  );
}
