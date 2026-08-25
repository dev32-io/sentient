// gateway/webui/src/components/settings/settings-view.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ReadonlySignal } from "@preact/signals";
import { createLogger } from "@sentient/web-sdk";
import { useAuth } from "../../hooks/use-auth.tsx";
import {
  createProfileApi,
  type MemoryDoc,
  type MemorySlot,
  type ProfileV1,
  type SoulDoc,
} from "../../services/profile-api.js";
import { createProvidersApi } from "../../services/providers-api.ts";
import { SidebarNav } from "./sidebar/sidebar-nav.tsx";
import { SidebarStatus } from "./sidebar/sidebar-status.tsx";
import { ApplyBar } from "./apply-bar/apply-bar.tsx";
import type { ApplyDeps, PendingOpWithPayload } from "./apply-bar/apply-bar-machine.ts";
import { APPLY_BAR_KEYS, type SidebarKey } from "./sidebar/nav-config.ts";
import { MemoryPane } from "./panes/memory-pane.tsx";
import { SystemPromptPane } from "./panes/system-prompt-pane.tsx";
import { PersonalitiesPane } from "./panes/personalities-pane.tsx";
import { VoicesPanel } from "../voices/VoicesPanel.tsx";
import { AudioPane } from "./panes/audio-pane.tsx";
import { ModelPane } from "./panes/model-pane.tsx";
import { ToolsPane } from "./panes/tools-pane.tsx";
import { AdvancedPane } from "./panes/advanced-pane.tsx";
import { AccountPane } from "./panes/account-pane.tsx";
import { MembersPane } from "./panes/members-pane.tsx";
import { SecretsPane } from "./panes/secrets-pane.tsx";
import { GetAppPane } from "./panes/get-app-pane.tsx";
import { DiagnosticsPane } from "./panes/diagnostics-pane.tsx";
import { ActionButton } from "../common/foundation.tsx";
import { Icon } from "../common/icon.tsx";

const log = createLogger(["sentient", "webui", "settings", "view"]);

export interface SettingsViewProps {
  /** Initial sidebar tab. Defaults to "memory" — the first tab in the Soul group. */
  initialTab?: SidebarKey;
  /**
   * Called after a successful profile Apply when the audio sub-tree changed.
   * Use this to push a live WS preference patch so the session picks up the
   * new values without waiting for reconnect.
   */
  onAudioApplied?: (patch: { ttsEnabled: boolean; channel: "voice" | "text" }) => void;
  /** True while the assistant is mid-TTS playback — forwarded to the Voices
   *  pane so it can gate sample preview against the live reply's audio. */
  assistantSpeaking?: ReadonlySignal<boolean>;
}

export function SettingsView({
  initialTab = "memory",
  onAudioApplied,
  assistantSpeaking,
}: SettingsViewProps = {}): JSX.Element {
  const auth = useAuth();
  const profileApi = useMemo(() => createProfileApi(), []);
  const providersApi = useMemo(() => createProvidersApi(), []);

  const [tab, setTab] = useState<SidebarKey>(initialTab);
  const [narrowPaneOpen, setNarrowPaneOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  // Personality create/delete/activate are imperative — they have no original
  // to diff against. Everything else is derived from draft↔original below.
  const [imperativeOps, setImperativeOps] = useState<PendingOpWithPayload[]>([]);
  const [profileDraft, setProfileDraft] = useState<ProfileV1 | null>(null);
  const [profileOriginal, setProfileOriginal] = useState<ProfileV1 | null>(null);
  const [soulOriginal, setSoulOriginal] = useState<SoulDoc | null>(null);
  const [soulDraft, setSoulDraft] = useState<string | null>(null);
  const [memoryOriginals, setMemoryOriginals] = useState<Record<MemorySlot, MemoryDoc | null>>({
    memory: null,
    user: null,
  });
  const [memoryDrafts, setMemoryDrafts] = useState<Record<MemorySlot, string | null>>({
    memory: null,
    user: null,
  });

  const isAuthed = auth.status === "authenticated";
  const token = isAuthed ? auth.token : "";
  // DERIVED from the record the gateway sent with this session's `auth.ok` /
  // `/me` — never latched, never stored, and re-derived on every sign-in. It
  // decides what the sidebar DRAWS; every admin call it leads to is still
  // resolved against the record server-side. Defaults to false when the view
  // renders before auth settles, so the admin surface appears only once the
  // record has actually said so.
  const isAdmin = isAuthed && auth.user.isAdmin;

  useEffect(() => {
    if (!isAuthed || profileOriginal) return;
    void (async () => {
      const r = await profileApi.getMe(token);
      if (r.ok) {
        setProfileOriginal(r.value);
        setProfileDraft(r.value);
      } else {
        log.warn("getMe.failed", { code: r.error.code });
      }
    })();
  }, [profileApi, isAuthed, token, profileOriginal]);

  const profileDiff = useMemo(() => {
    if (!profileDraft || !profileOriginal) {
      return { audio: false, memory: false, model: false, tools: false, advanced: false };
    }
    return {
      audio: !eq(profileDraft.audio, profileOriginal.audio),
      memory: !eq(profileDraft.memory, profileOriginal.memory),
      model: !eq(profileDraft.model, profileOriginal.model),
      tools: !eq(profileDraft.tools, profileOriginal.tools),
      advanced:
        !eq(profileDraft.compression, profileOriginal.compression) ||
        !eq(profileDraft.advanced, profileOriginal.advanced),
    };
  }, [profileDraft, profileOriginal]);

  const soulDirty =
    soulDraft !== null && soulOriginal !== null && soulDraft !== soulOriginal.content;

  const memoryDirty = useMemo<Record<MemorySlot, boolean>>(
    () => ({
      memory:
        memoryDrafts.memory !== null &&
        memoryOriginals.memory !== null &&
        memoryDrafts.memory !== memoryOriginals.memory.content,
      user:
        memoryDrafts.user !== null &&
        memoryOriginals.user !== null &&
        memoryDrafts.user !== memoryOriginals.user.content,
    }),
    [memoryDrafts, memoryOriginals],
  );

  // Profile sub-trees coalesce into one op so Apply does a single PUT.
  const derivedOps = useMemo<PendingOpWithPayload[]>(() => {
    const ops: PendingOpWithPayload[] = [];
    if (
      profileDraft &&
      (profileDiff.audio || profileDiff.memory || profileDiff.model || profileDiff.tools || profileDiff.advanced)
    ) {
      // Audio and memory toggles are gateway-side — neither touches the
      // Hermes profile render/write, so both stay "fast". Voice is no longer
      // part of this draft/apply flow at all (see VoicesPanel — immediate ops).
      const needsProfileRewrite = profileDiff.model || profileDiff.tools || profileDiff.advanced;
      ops.push({ key: "profile", kind: needsProfileRewrite ? "slow" : "fast", payload: profileDraft });
    }
    if (soulDirty && soulDraft !== null) {
      ops.push({ key: "systemPrompt.soul", kind: "slow", payload: soulDraft });
    }
    if (memoryDirty.memory && memoryDrafts.memory !== null) {
      ops.push({ key: "memory.memory", kind: "slow", payload: memoryDrafts.memory });
    }
    if (memoryDirty.user && memoryDrafts.user !== null) {
      ops.push({ key: "memory.user", kind: "slow", payload: memoryDrafts.user });
    }
    return ops;
  }, [profileDraft, profileDiff, soulDirty, soulDraft, memoryDirty, memoryDrafts]);

  const pending = useMemo<PendingOpWithPayload[]>(
    () => [...derivedOps, ...imperativeOps],
    [derivedOps, imperativeOps],
  );

  const dirtyKeys = useMemo<Set<SidebarKey>>(() => {
    const s = new Set<SidebarKey>();
    if (profileDiff.audio) s.add("audio");
    if (profileDiff.model) s.add("model");
    if (profileDiff.tools) s.add("tools");
    if (profileDiff.advanced) s.add("advanced");
    if (soulDirty) s.add("systemPrompt");
    if (profileDiff.memory || memoryDirty.memory || memoryDirty.user) s.add("memory");
    if (imperativeOps.some((op) => op.key.startsWith("personalities."))) s.add("personalities");
    if (imperativeOps.some((op) => op.key === "secrets.changed")) s.add("secrets");
    return s;
  }, [profileDiff, soulDirty, memoryDirty, imperativeOps]);

  if (!isAuthed) return <></>;

  const markImperative = (op: PendingOpWithPayload) => {
    setImperativeOps((arr) => {
      const filtered = arr.filter((x) => x.key !== op.key);
      return [...filtered, op];
    });
  };

  const onApplied = async () => {
    setImperativeOps([]);
    const r = await profileApi.getMe(token);
    if (r.ok) {
      setProfileOriginal(r.value);
      setProfileDraft(r.value);
    }
    const s = await profileApi.getSoul(token);
    if (s.ok) {
      setSoulOriginal(s.value);
      setSoulDraft(s.value.content);
    }
    // Re-fetch any memory slot the user touched so the editor reflects the
    // latest on-disk state (Hermes writes and prunes memory autonomously
    // between conversations, so the file may have changed since it was
    // last loaded here).
    for (const slot of ["memory", "user"] as const) {
      if (memoryOriginals[slot] === null) continue;
      const m = await profileApi.getMemoryDoc(token, slot);
      if (m.ok) {
        setMemoryOriginals((prev) => ({ ...prev, [slot]: m.value }));
        setMemoryDrafts((prev) => ({ ...prev, [slot]: m.value.content }));
      }
    }
  };

  const onDiscard = () => {
    setImperativeOps([]);
    if (profileOriginal) setProfileDraft(profileOriginal);
    if (soulOriginal) setSoulDraft(soulOriginal.content);
    setMemoryDrafts({
      memory: memoryOriginals.memory?.content ?? null,
      user: memoryOriginals.user?.content ?? null,
    });
  };

  const setMemoryOriginalSlot = (slot: MemorySlot, doc: MemoryDoc) => {
    setMemoryOriginals((prev) => ({ ...prev, [slot]: doc }));
  };
  const setMemoryDraftSlot = (slot: MemorySlot, content: string) => {
    setMemoryDrafts((prev) => ({ ...prev, [slot]: content }));
  };

  // Sync-only — voice is an immediate op (VoicesPanel persists it itself via
  // the voices REST API / profile PUT). This does NOT PUT anything; it only
  // keeps profileDraft/profileOriginal.voice in step so a later model/tools
  // Apply (which PUTs the whole profile) doesn't revert the user's pick back
  // to whatever voice.id happened to be in the draft at page-load time.
  const onActiveVoiceChanged = (voiceId: string) => {
    setProfileDraft((d) => d && { ...d, voice: { provider: "local-tts", id: voiceId } });
    setProfileOriginal((o) => o && { ...o, voice: { provider: "local-tts", id: voiceId } });
  };

  const deps = makeApplyDeps(profileApi, token, onAudioApplied);

  const openPane = (key: SidebarKey) => {
    setTab(key);
    setNarrowPaneOpen(true);
  };

  const closeNarrowPane = () => {
    setNarrowPaneOpen(false);
    requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>(`.s-nav-i[title^="${tab === "getApp" ? "Get the app" : tab === "systemPrompt" ? "System Prompt" : tab.charAt(0).toUpperCase() + tab.slice(1)}"]`)?.focus();
    });
  };

  return (
    <div class="settings-v2 snt-surface" data-narrow-pane-open={narrowPaneOpen ? "true" : "false"}>
      <aside ref={sidebarRef} class="s-side" aria-label="Settings navigation">
        <SidebarNav active={tab} onChange={openPane} dirtyKeys={dirtyKeys} isAdmin={isAdmin} />
        <SidebarStatus token={isAuthed ? auth.token : null} />
      </aside>

      <main class="s-main" id="settings-active-pane">
        <div class="s-narrow-back">
          <ActionButton variant="quiet" onClick={closeNarrowPane}>
            <Icon name="chevron" size={14} /> Settings
          </ActionButton>
        </div>
        <div class="s-pane" key={tab} tabIndex={-1}>
          {tab === "memory" && profileDraft && (
            <MemoryPane
              api={profileApi}
              token={token}
              drafts={memoryDrafts}
              originals={memoryOriginals}
              setOriginal={setMemoryOriginalSlot}
              setDraft={setMemoryDraftSlot}
              memoryToggles={profileDraft.memory}
              onDraftMemoryToggles={(memory) => setProfileDraft({ ...profileDraft, memory })}
            />
          )}
          {tab === "systemPrompt" && profileDraft && (
            <SystemPromptPane
              api={profileApi}
              token={token}
              onRestoreDefault={(body) => setSoulDraft(body)}
              draft={soulDraft}
              original={soulOriginal}
              setOriginal={setSoulOriginal}
              setDraft={setSoulDraft}
            />
          )}
          {tab === "personalities" && (
            <PersonalitiesPane api={profileApi} token={token} onMark={markImperative} />
          )}
          {tab === "voice" && (
            <VoicesPanel
              token={token}
              activeVoiceId={profileOriginal?.voice.id ?? "default"}
              onActiveVoiceChanged={onActiveVoiceChanged}
              {...(assistantSpeaking ? { assistantSpeaking } : {})}
            />
          )}
          {tab === "audio" && profileDraft && (
            <AudioPane
              draft={profileDraft}
              onDraftAudio={(audio) => setProfileDraft({ ...profileDraft, audio })}
            />
          )}
          {tab === "model" && profileDraft && (
            <ModelPane
              api={providersApi}
              token={token}
              draft={profileDraft}
              savedModel={profileOriginal?.model ?? null}
              onDraftModel={(model) => setProfileDraft({ ...profileDraft, model })}
            />
          )}
          {tab === "tools" && profileDraft && (
            <ToolsPane
              api={profileApi}
              token={token}
              draft={profileDraft}
              onDraftTools={(tools) => setProfileDraft({ ...profileDraft, tools })}
            />
          )}
          {tab === "advanced" && profileDraft && (
            <AdvancedPane
              draft={profileDraft}
              onDraftCompression={(compression) =>
                setProfileDraft({ ...profileDraft, compression })
              }
              onDraftAdvanced={(advanced) => setProfileDraft({ ...profileDraft, advanced })}
            />
          )}
          {tab === "account" && <AccountPane />}
          {tab === "members" && <MembersPane />}
          {tab === "secrets" && <SecretsPane onMark={markImperative} />}
          {tab === "getApp" && <GetAppPane />}
          {tab === "diagnostics" && <DiagnosticsPane token={token} />}
        </div>
      </main>

      {APPLY_BAR_KEYS.has(tab) && (
        <ApplyBar pending={pending} deps={deps} onApplied={onApplied} onDiscard={onDiscard} />
      )}
    </div>
  );
}

// Referential fast-path skips stringify when callers spread an updated draft
// (`{ ...profileDraft, audio }`): only the touched sub-tree gets a new
// reference, so the other sub-trees short-circuit.
function eq<T>(a: T, b: T): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function makeApplyDeps(
  profileApi: ReturnType<typeof createProfileApi>,
  token: string,
  onAudioApplied?: (patch: { ttsEnabled: boolean; channel: "voice" | "text" }) => void,
): ApplyDeps {
  return {
    saveSoul: async (body) => {
      const r = await profileApi.putSoul(token, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    saveMemoryDoc: async (slot, body) => {
      const r = await profileApi.putMemoryDoc(token, slot, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    saveProfile: async (draft) => {
      const r = await profileApi.updateMe(token, draft as ProfileV1);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityActive: async (name) => {
      const r = await profileApi.postActivePersonality(token, name);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityBody: async (name, body) => {
      const r = await profileApi.putPersonality(token, name, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityCreate: async (name, body) => {
      const r = await profileApi.postPersonality(token, name, body);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    savePersonalityDelete: async (name) => {
      const r = await profileApi.deletePersonality(token, name);
      if (!r.ok) return { ok: false, errorMessage: r.error.code };
      return { ok: true };
    },
    waitForRestart: async () => {
      // Trigger the gateway's apply pipeline: render config.yaml + SOUL.md
      // into the Hermes profile dir (gateway/src/apply/orchestrator.ts).
      // Hermes runs as a one-shot exec per delegation with that dir as its
      // cwd, so writing the file IS the entire operation — the next
      // delegation reads it, no restart or health-check involved. Without
      // this call, a model/tools/advanced change saves to profile.json but
      // never reaches the rendered Hermes config — silent stale config,
      // hard to debug.
      const r = await profileApi.apply(token);
      if (!r.ok) {
        return { state: r.error.code === "apply-in-progress" ? "already-applying" : "failed", elapsedMs: 0 };
      }
      return { state: "ready", elapsedMs: r.value.elapsedMs };
    },
    ...(onAudioApplied ? { patchLivePreferences: onAudioApplied } : {}),
  };
}
