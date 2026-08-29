import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { PersonalityList, ProfileApi } from "../../../services/profile-api.js";
import { ActionButton, ActionRow, AsyncState, Disclosure, Field, PaneChrome, SettingsCard, TextArea } from "../../common/index.ts";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "personalities-pane"]);
const NEW_KEY = "__new__";
const DESCRIPTION = "Switchable tone profiles. Activate one for the assistant to use.";

export interface PersonalitiesPaneProps {
  api: ProfileApi;
  token: string;
  onMark: (op: { key: string; kind: "fast" | "slow"; payload: unknown }) => void;
}

export function PersonalitiesPane({ api, token, onMark }: PersonalitiesPaneProps): JSX.Element {
  const [list, setList] = useState<PersonalityList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");

  useEffect(() => { void reload(); }, [api, token, loadAttempt]);
  async function reload(): Promise<void> {
    setLoadError(null);
    const result = await api.getPersonalities(token);
    if (!result.ok) {
      log.warn("list.failed", { code: result.error.code });
      setLoadError("Couldn't load personalities.");
      return;
    }
    setList(result.value);
  }

  const isNewOpen = openId === NEW_KEY;
  return (
    <PaneChrome title="Personalities" subtitle={DESCRIPTION}>
      {loadError ? (
        <AsyncState state="error" title={loadError} message="Your profiles were not changed." action={<ActionButton onClick={() => setLoadAttempt((value) => value + 1)}>Retry</ActionButton>} />
      ) : !list ? (
        <AsyncState state="loading" title="Loading personalities" />
      ) : (
        <SettingsCard title="All personalities" padded={false} action={<ActionButton variant="quiet" onClick={() => { setOpenId(isNewOpen ? null : NEW_KEY); setNewName(""); setNewBody(""); }}><Icon name="plus" size={14} /> New personality</ActionButton>}>
          <div class="lst">
            {isNewOpen && (
              <div class="lst-row lst-row-new">
                <div class="lst-edit">
                  <Field label="Name" value={newName} onInput={(event) => setNewName(event.currentTarget.value)} placeholder="For example: friendly or scientist" />
                  <TextArea label="Instructions" value={newBody} onInput={(event) => setNewBody(event.currentTarget.value)} rows={10} monospace placeholder="Instructions for this personality…" />
                  <ActionRow>
                    <ActionButton variant="primary" disabled={!validNewName(newName, list)} onClick={() => { onMark({ key: "personalities.new", kind: "slow", payload: { name: newName.trim(), body: newBody } }); setOpenId(null); }}>Create</ActionButton>
                    <ActionButton variant="quiet" onClick={() => setOpenId(null)}>Cancel</ActionButton>
                  </ActionRow>
                </div>
              </div>
            )}
            {!isNewOpen && list.personalities.length === 0 && <AsyncState state="empty" title="No personalities yet" message="Create one to give Sentient another tone or style." />}
            {list.personalities.map((personality) => {
              const isOpen = openId === personality.name;
              const isActive = personality.name === list.activeName;
              const draft = editDrafts[personality.name] ?? personality.body;
              return (
                <div key={personality.name} class={`lst-row${isActive ? " on" : ""}${isOpen ? " open" : ""}`}>
                  <div class="lst-row-main">
                    <Disclosure
                      className="lst-disclosure"
                      mode="button"
                      title={<>{personality.name}{isActive && <span class="tag tag-active">Active</span>}</>}
                      open={isOpen}
                      onOpenChange={(nextOpen) => setOpenId(nextOpen ? personality.name : null)}
                    >
                      <div class="lst-edit"><TextArea label={`${personality.name} instructions`} value={draft} rows={10} monospace dirty={draft !== personality.body} onInput={(event) => { const body = event.currentTarget.value; setEditDrafts((values) => ({ ...values, [personality.name]: body })); if (body !== personality.body) onMark({ key: `personalities.${personality.name}`, kind: "slow", payload: { body } }); }} /></div>
                    </Disclosure>
                    <ActionRow>
                      {!isActive && <ActionButton variant="quiet" onClick={() => onMark({ key: "personalities.active", kind: "fast", payload: { name: personality.name } })}>Activate</ActionButton>}
                      <ActionButton variant="destructive" onClick={() => onMark({ key: `personalities.delete:${personality.name}`, kind: "slow", payload: { name: personality.name } })}>Delete</ActionButton>
                    </ActionRow>
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsCard>
      )}
    </PaneChrome>
  );
}

function validNewName(name: string, list: PersonalityList): boolean {
  const trimmed = name.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) && !list.personalities.some((personality) => personality.name === trimmed);
}
