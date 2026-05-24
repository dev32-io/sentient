// gateway/webui/src/components/settings/panes/personalities-pane.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { PersonalityList, ProfileApi } from "../../../services/profile-api.js";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { TextField } from "../primitives/text-field.tsx";
import { Icon } from "../../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "personalities-pane"]);

const NEW_KEY = "__new__";

export interface PersonalitiesPaneProps {
  api: ProfileApi;
  token: string;
  onMark: (op: { key: string; kind: "fast" | "slow"; payload: unknown }) => void;
}

export function PersonalitiesPane({ api, token, onMark }: PersonalitiesPaneProps): JSX.Element {
  const [list, setList] = useState<PersonalityList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editDrafts, setEditDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, token]);

  async function reload() {
    const r = await api.getPersonalities(token);
    if (!r.ok) {
      log.warn("list.failed", { code: r.error.code });
      setLoadError("Couldn't load personalities.");
      return;
    }
    setList(r.value);
    setLoadError(null);
  }

  if (loadError) {
    return (
      <>
        <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!list) {
    return (
      <>
        <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />
        <div class="pane-skeleton" aria-hidden="true" />
      </>
    );
  }

  const isNewOpen = openId === NEW_KEY;

  return (
    <>
      <PaneHead title="Personalities" sub="Switchable tone profiles. Activate one for the assistant to wear." />

      <Card
        title="All personalities"
        action={
          <Btn
            kind="ghost"
            size="sm"
            icon={<Icon name="plus" size={11} />}
            onClick={() => {
              setOpenId(isNewOpen ? null : NEW_KEY);
              setNewName("");
              setNewBody("");
            }}
          >
            New
          </Btn>
        }
        padding={false}
      >
        <div class="lst">
          {isNewOpen && (
            <div class="lst-row open lst-row-new">
              <div class="lst-row-main">
                <label class="lst-field">
                  <span class="lst-field-l">Name</span>
                  <TextField
                    value={newName}
                    onChange={(e) => setNewName((e.target as HTMLInputElement).value)}
                    placeholder="e.g. friendly, terse, scientist"
                    fullWidth
                  />
                </label>
              </div>
              <div class="lst-edit">
                <label class="lst-field">
                  <span class="lst-field-l">Instructions</span>
                  <Textarea
                    value={newBody}
                    onChange={(e) => setNewBody((e.target as HTMLTextAreaElement).value)}
                    rows={10}
                    monospace
                    placeholder="System-prompt-style instructions for this personality…"
                  />
                </label>
                <div class="lst-edit-acts">
                  <Btn
                    kind="primary"
                    size="sm"
                    disabled={!validNewName(newName, list)}
                    onClick={() => {
                      onMark({
                        key: "personalities.new",
                        kind: "slow",
                        payload: { name: newName.trim(), body: newBody },
                      });
                      setOpenId(null);
                    }}
                  >
                    Create
                  </Btn>
                  <Btn kind="ghost" size="sm" onClick={() => setOpenId(null)}>Cancel</Btn>
                </div>
              </div>
            </div>
          )}

          {!isNewOpen && list.personalities.length === 0 && (
            <div class="empty-pad">
              No personalities yet. Click <strong>+ New</strong> to add one.
            </div>
          )}

          {list.personalities.map((p) => {
            const isOpen = openId === p.name;
            const isActive = p.name === list.activeName;
            const draft = editDrafts[p.name] ?? p.body;
            const isDirty = draft !== p.body;
            const toggleOpen = () => setOpenId(isOpen ? null : p.name);

            return (
              <div key={p.name} class={["lst-row", isActive && "on", isOpen && "open"].filter(Boolean).join(" ")}>
                <div
                  class="lst-row-main lst-row-btn"
                  role="button"
                  tabIndex={0}
                  onClick={toggleOpen}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleOpen();
                    }
                  }}
                >
                  <span class={["lst-chev", isOpen && "open"].filter(Boolean).join(" ")}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <div class="lst-body">
                    <div class="lst-title">
                      {p.name}
                      {isActive && <span class="tag tag-active">active</span>}
                    </div>
                  </div>
                  <div class="lst-acts" onClick={(e: MouseEvent) => e.stopPropagation()}>
                    {!isActive && (
                      <Btn
                        kind="ghost"
                        size="sm"
                        onClick={() => onMark({
                          key: "personalities.active",
                          kind: "fast",
                          payload: { name: p.name },
                        })}
                      >
                        Activate
                      </Btn>
                    )}
                    <Btn
                      kind="ghost"
                      size="sm"
                      danger
                      onClick={() => onMark({
                        key: `personalities.delete:${p.name}`,
                        kind: "slow",
                        payload: { name: p.name },
                      })}
                    >
                      Delete
                    </Btn>
                  </div>
                </div>

                {isOpen && (
                  <div class="lst-edit">
                    <Textarea
                      value={draft}
                      rows={10}
                      monospace
                      dirty={isDirty}
                      onChange={(e: Event) => {
                        const v = (e.target as HTMLTextAreaElement).value;
                        setEditDrafts((d) => ({ ...d, [p.name]: v }));
                        if (v !== p.body) {
                          onMark({
                            key: `personalities.${p.name}`,
                            kind: "slow",
                            payload: { body: v },
                          });
                        }
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}

function validNewName(name: string, list: PersonalityList): boolean {
  const t = name.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t)) return false;
  return !list.personalities.some((p) => p.name === t);
}
