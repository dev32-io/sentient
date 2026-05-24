# TTS Toggle Button + Consolidated User-Settings Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-08-tts-toggle-button-design.md`
**Branch:** `feature/tts-toggle-button` (already created)

**Goal:** Add a user-facing TTS mute toggle next to the mic button, persist the setting to the user profile, and consolidate model-side preference knobs into one `update_user_settings` MCP tool.

**Architecture:** Promote `channel` and a new `ttsEnabled` flag from session-only to ProfileV1-persisted. PreferenceManager seeds from the profile at session start. Single new MCP tool replaces `set_channel` and covers `ttsEnabled`/`channel`/`voice`/`model`. UI button writes via the existing profile REST route AND a new WS preference-patch frame so the running session reflects the change without a reconnect. **Pipeline gating is entry-only** — current cycle continues to play, next cycle respects the new value. No in-flight stop, no audio interruption.

**Tech Stack:** TypeScript (gateway + web SDK + web UI Preact), Bun runtime, Vitest, Zod, MCP server, supervisord-managed Hermes worker, WebSocket transport.

---

## File Structure

### New files

| Path | Purpose |
|------|---------|
| `shared/audio-prefs/schema.ts` | Single-source zod schema for `{ttsEnabled, channel}`; consumed by profile validator, MCP tool input, WS patch validator |
| `gateway/src/mcp-host/tools/update-user-settings.ts` | New MCP tool covering `ttsEnabled`/`channel`/`voice`/`model` |
| `gateway/src/mcp-host/tools/update-user-settings.test.ts` | Defensive tests: input validation, profile persistence, session sync |
| `gateway/src/session-handlers/handle-preferences-patch.ts` | Inbound `user.preferences.patch` handler |
| `gateway/src/session-handlers/handle-preferences-patch.test.ts` | Wire-protocol test: handler updates PreferenceManager |
| `shared/web-sdk/src/connectors/preferences-connector.ts` | SDK connector: subscribes to `session.preferences.changed`, exposes `patch()` |
| `shared/web-sdk/src/connectors/preferences-connector.test.ts` | Wire-protocol test: inbound + outbound shapes |
| `gateway/webui/src/components/common/icons/volume-2.tsx` | Lucide-style speaker icon (TTS on) |
| `gateway/webui/src/components/common/icons/volume-x.tsx` | Lucide-style speaker-with-X icon (TTS off) |
| `gateway/webui/src/components/dock/tts-button.tsx` | New button mirroring `MicButton` shape |
| `gateway/webui/src/components/settings/panes/audio-pane.tsx` | Settings tab pane mirroring the two audio fields |

### Modified files

| Path | Change |
|------|--------|
| `gateway/src/profile-store/profile-types.ts` | Add `audio` to `profileV1Schema` |
| `gateway/src/profile-store/profile-defaults.ts` | Inject `audio` default when absent |
| `gateway/src/profile-store/profile-defaults.test.ts` | Cover legacy-profile migration |
| `gateway/src/cerebrum/preferences.ts` | Add `ttsEnabled` to `SessionPreferences`, `PreferencePatch`, `update` |
| `gateway/src/cerebrum/preferences.test.ts` | Cover `ttsEnabled` in change-detection |
| `gateway/src/session-handlers/ws-session-configure.ts` | Seed prefs from profile; extend entry gate; swap log line; register new sessionControl method; register new WS handler; emit `session.preferences.changed` from PreferenceManager.onChange |
| `gateway/src/bootstrap/create-mcp-host.ts` | Swap `createSetChannelTool` → `createUpdateUserSettingsTool` |
| `gateway/src/mcp-host/tools/set-channel.ts` | Delete |
| `gateway/src/mcp-host/tools/set-channel.test.ts` | Delete |
| `shared/web-sdk/src/index.ts` | Export `PreferencesConnector` |
| `gateway/webui/src/services/profile-api.ts` | Mirror new `audio` field on `ProfileV1` |
| `gateway/webui/src/components/common/icon.tsx` | Register `volume-2` + `volume-x` icons |
| `gateway/webui/src/components/dock/composer.tsx` | Slot `TtsButton` between Mic and spacer |
| `gateway/webui/src/hooks/use-voice-client.ts` | Mount `PreferencesConnector`, expose `prefs` signal + `patchPreferences()` |
| `gateway/webui/src/app.tsx` | Wire button props to `client.prefs` + `client.patchPreferences` |
| `gateway/webui/src/styles/components.css` | Add `.icon-btn--tts-on/off` variants + mobile gap |
| `gateway/webui/src/components/common/icon-button.tsx` | Add `tts-on`/`tts-off` to `variant` enum |
| `gateway/webui/src/components/settings/sidebar/nav-config.ts` | Add `audio` `SidebarKey` + nav item + Soul-set membership |
| `gateway/webui/src/components/settings/settings-view.tsx` | Render `AudioPane` for the new tab |

### Files NOT touched (intentionally)

- `gateway/src/api/handlers/profile.ts` (PUT route) — already accepts the full validated profile
- `gateway/src/mcp-host/tools/audio-tools.ts` (`pause_audio`/`resume_audio`) — unrelated
- Mid-stream `gateByChannel` in `ws-session-configure.ts` — channel-only, untouched per spec

---

## Task 1: Shared zod schema for audio preferences

**Files:**
- Create: `shared/audio-prefs/schema.ts`

- [ ] **Step 1: Create the shared schema file**

```ts
// shared/audio-prefs/schema.ts
import { z } from "zod";

// Single source of truth for audio-related preferences. Consumed by:
//   - profile validator (gateway/src/profile-store/profile-types.ts)
//   - update_user_settings MCP tool input
//   - user.preferences.patch WS frame validator
// Keep this file dependency-free except for zod.

export const audioPrefsSchema = z.object({
  ttsEnabled: z.boolean(),
  channel: z.enum(["voice", "text"]),
});

export type AudioPrefs = z.output<typeof audioPrefsSchema>;

export const AUDIO_PREFS_DEFAULT: AudioPrefs = {
  ttsEnabled: true,
  channel: "voice",
};

// Partial form for tool input + WS patch. Allows omitting fields.
export const audioPrefsPatchSchema = audioPrefsSchema.partial();
export type AudioPrefsPatch = z.output<typeof audioPrefsPatchSchema>;
```

- [ ] **Step 2: Commit**

```bash
git add shared/audio-prefs/schema.ts
git commit -m "feat(shared): add audio-prefs zod schema (ttsEnabled, channel)"
```

---

## Task 2: Extend ProfileV1 schema with `audio` field

**Files:**
- Modify: `gateway/src/profile-store/profile-types.ts`
- Modify: `gateway/src/profile-store/profile-defaults.ts`
- Modify: `gateway/src/profile-store/profile-defaults.test.ts`

- [ ] **Step 1: Write the failing test for legacy-profile migration**

Append to `gateway/src/profile-store/profile-defaults.test.ts`:

```ts
import { profileV1Schema } from "./profile-types.js";
import { applyProfileDefaults } from "./profile-defaults.js";

describe("audio defaults", () => {
  it("injects {ttsEnabled:true, channel:'voice'} when audio is absent", () => {
    const legacy = {
      schemaVersion: 1,
      userId: "alice",
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      voice: { provider: "fish-audio", id: "default" },
      persona: { template: "default", overrides: "" },
      tools: { enabled: {} },
      compression: { threshold: 0.8 },
      advanced: { extraSystemPrompt: "", maxTokens: 4096 },
    };
    const parsed = profileV1Schema.parse(legacy);
    const withDefaults = applyProfileDefaults(parsed);
    expect(withDefaults.audio).toEqual({ ttsEnabled: true, channel: "voice" });
  });

  it("preserves existing audio values", () => {
    const profile = {
      schemaVersion: 1,
      userId: "alice",
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      voice: { provider: "fish-audio", id: "default" },
      persona: { template: "default", overrides: "" },
      tools: { enabled: {} },
      compression: { threshold: 0.8 },
      advanced: { extraSystemPrompt: "", maxTokens: 4096 },
      audio: { ttsEnabled: false, channel: "text" as const },
    };
    const parsed = profileV1Schema.parse(profile);
    const withDefaults = applyProfileDefaults(parsed);
    expect(withDefaults.audio).toEqual({ ttsEnabled: false, channel: "text" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
source scripts/env.sh
bun run test gateway/src/profile-store/profile-defaults.test.ts
```

Expected: FAIL — `audio` field not on schema.

- [ ] **Step 3: Add `audio` to profile schema**

In `gateway/src/profile-store/profile-types.ts`, add this import near the top with the other zod imports:

```ts
import { audioPrefsSchema } from "../../../shared/audio-prefs/schema.js";
```

Inside `profileV1Schema = z.object({...})`, add the `audio` field. Place it after `voice` for grouping — both are audio-adjacent. Use `.default()` so legacy profiles parse:

```ts
  voice: z.object({
    provider: voiceProviderSchema,
    id: z.string().min(1),
  }),
  audio: audioPrefsSchema.default({ ttsEnabled: true, channel: "voice" }),
  persona: z.object({
```

- [ ] **Step 4: Update `applyProfileDefaults` to inject audio defaults**

In `gateway/src/profile-store/profile-defaults.ts`, extend `applyProfileDefaults`:

```ts
import { AUDIO_PREFS_DEFAULT } from "../../../shared/audio-prefs/schema.js";

export function applyProfileDefaults(p: ProfileV1): ProfileV1 {
  const enabledIsEmpty = Object.keys(p.tools.enabled).length === 0;
  const toolsetsIsEmpty = !p.tools.toolsets || p.tools.toolsets.length === 0;
  // Audio defaults already applied by zod's .default(); applyProfileDefaults
  // only fills in fields that the schema can't default by itself (record types,
  // legacy upgrades). Audio is included here for parity with future expansion
  // and to explicitly assert the contract in one place.
  return {
    ...p,
    tools: {
      enabled: enabledIsEmpty ? { ...DEFAULT_TOOLS_ENABLED } : p.tools.enabled,
      toolsets: toolsetsIsEmpty ? [...DEFAULT_TOOLSETS] : p.tools.toolsets,
    },
    audio: p.audio ?? AUDIO_PREFS_DEFAULT,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun run test gateway/src/profile-store/profile-defaults.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/profile-store/profile-types.ts gateway/src/profile-store/profile-defaults.ts gateway/src/profile-store/profile-defaults.test.ts
git commit -m "feat(profile): add audio prefs to ProfileV1 with legacy default"
```

---

## Task 3: Extend `PreferenceManager` with `ttsEnabled`

**Files:**
- Modify: `gateway/src/cerebrum/preferences.ts`
- Modify: `gateway/src/cerebrum/preferences.test.ts` (or matching `*.test.ts`)

- [ ] **Step 1: Write the failing test**

In the existing preferences test file (find via `grep -l "createPreferenceManager" gateway/src/cerebrum/`), add:

```ts
it("update detects ttsEnabled change and notifies listener", () => {
  const pm = createPreferenceManager({
    initial: { language: "auto", channel: "voice", ttsEnabled: true },
  });
  const listener = vi.fn();
  pm.onChange(listener);
  pm.update({ ttsEnabled: false });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0][2]).toContain("ttsEnabled");
  expect(pm.get().ttsEnabled).toBe(false);
});

it("update is no-op when ttsEnabled value unchanged", () => {
  const pm = createPreferenceManager({
    initial: { language: "auto", channel: "voice", ttsEnabled: true },
  });
  const listener = vi.fn();
  pm.onChange(listener);
  pm.update({ ttsEnabled: true });
  expect(listener).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test gateway/src/cerebrum/preferences.test.ts
```

Expected: FAIL — `ttsEnabled` not on `SessionPreferences`.

- [ ] **Step 3: Extend types and update logic**

In `gateway/src/cerebrum/preferences.ts`:

Replace the `SessionPreferences`, `PreferencePatch`, and the `update` body. Keep the export surface identical otherwise:

```ts
export interface SessionPreferences {
  readonly language: PreferenceLanguage;
  readonly channel: PreferenceChannel;
  readonly ttsEnabled: boolean;
}

export interface PreferencePatch {
  readonly language?: PreferenceLanguage;
  readonly channel?: PreferenceChannel;
  readonly ttsEnabled?: boolean;
}
```

Inside `update(patch)`, expand `next` and `changed`:

```ts
update(patch: PreferencePatch): SessionPreferences {
  const prev = state;
  const next: SessionPreferences = {
    language: patch.language ?? prev.language,
    channel: patch.channel ?? prev.channel,
    ttsEnabled: patch.ttsEnabled ?? prev.ttsEnabled,
  };

  const changed: Array<keyof SessionPreferences> = [];
  if (next.language !== prev.language) changed.push("language");
  if (next.channel !== prev.channel) changed.push("channel");
  if (next.ttsEnabled !== prev.ttsEnabled) changed.push("ttsEnabled");

  if (changed.length === 0) {
    log.debug("update-noop", { current: prev });
    return prev;
  }

  state = next;
  log.info("preferences-changed", { changed, prev, next });
  notify(next, prev, changed);
  return next;
},
```

Update the init-log line to include `ttsEnabled`:

```ts
log.info("preferences-init", {
  language: state.language,
  channel: state.channel,
  ttsEnabled: state.ttsEnabled,
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test gateway/src/cerebrum/preferences.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/cerebrum/preferences.ts gateway/src/cerebrum/preferences.test.ts
git commit -m "feat(prefs): add ttsEnabled to SessionPreferences + update logic"
```

---

## Task 4: Seed PreferenceManager from profile + extend entry gate

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`

- [ ] **Step 1: Find the existing seed site**

Open `gateway/src/session-handlers/ws-session-configure.ts`. Around line 122 you'll find:

```ts
const preferenceManager = createPreferenceManager({
  initial: {
    language: "auto",
    channel: "voice",
  },
});
```

- [ ] **Step 2: Replace with profile-seeded init**

The profile is already attached to the PersonSession at this point (`personSession.profile`). Use it:

```ts
const preferenceManager = createPreferenceManager({
  initial: {
    language: "auto",
    channel: personSession.profile.audio.channel,
    ttsEnabled: personSession.profile.audio.ttsEnabled,
  },
});
```

If the variable shadowing creates a problem (PersonSession created later in the file), confirm by re-reading; if so, move the `createPreferenceManager` call to AFTER the `personSession = await services.personSessions.getOrCreate(...)` line. The existing `ws.data.preferenceManager = preferenceManager` assignment moves with it.

- [ ] **Step 3: Update the entry gate to also check `ttsEnabled`**

Find the `startTts` closure block (around line 304–333). Locate the entry gate (around line 318):

```ts
const initialChannel = preferenceManager.get().channel;
if (initialChannel !== "voice") {
  log.info("tts.skip.channel-text", {
    sessionId,
    cycleId,
    channel: initialChannel,
    when: "startTts-entry",
  });
  const drain = (async () => {
    for await (const _ of deltas) {
      /* drop */
    }
  })();
  return { done: drain, cancel: () => {} };
}
```

Replace with:

```ts
const initialPrefs = preferenceManager.get();
const skipReason: "channel-text" | "tts-disabled" | null =
  initialPrefs.channel !== "voice" ? "channel-text"
  : !initialPrefs.ttsEnabled ? "tts-disabled"
  : null;
if (skipReason !== null) {
  log.info("tts.skip.audio-prefs", {
    sessionId,
    cycleId,
    when: "startTts-entry",
    reason: skipReason,
    channel: initialPrefs.channel,
    ttsEnabled: initialPrefs.ttsEnabled,
  });
  const drain = (async () => {
    for await (const _ of deltas) {
      /* drop */
    }
  })();
  return { done: drain, cancel: () => {} };
}
```

- [ ] **Step 4: Update the existing `set_channel` comment**

Around line 357–360 the `gateByChannel` comment mentions `mcp_gateway_set_channel`. Update to mention the new tool name AND clarify ttsEnabled does NOT use this gate:

```ts
// Mid-stream channel gate. Each chunk re-reads the preference
// so an update_user_settings({channel:"text"}) call between
// assistant.message frames immediately stops the rest of the
// cycle from being spoken. Already-queued audio drains past
// this point — to also kill in-flight playback the agent would
// call pause_audio (separate tool, separate path).
//
// NOTE: ttsEnabled is intentionally NOT checked here. Per spec,
// ttsEnabled is a "next time" setting — current cycle finishes,
// next cycle's entry gate enforces the new value.
```

- [ ] **Step 5: Run a smoke check on the gateway build**

```bash
bun run typecheck
```

Expected: clean. If type errors mention a missing `ttsEnabled` on initial-pref objects elsewhere, fix those — there should only be one or two seed sites.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(gateway): seed prefs from profile, extend entry gate for ttsEnabled"
```

---

## Task 5: Create `update_user_settings` MCP tool

**Files:**
- Create: `gateway/src/mcp-host/tools/update-user-settings.ts`
- Create: `gateway/src/mcp-host/tools/update-user-settings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/mcp-host/tools/update-user-settings.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SessionRouter } from "../../session-router.js";
import { createUpdateUserSettingsTool } from "./update-user-settings.js";

const fakeRouter = {
  bind: vi.fn(),
  release: vi.fn(),
  rebind: vi.fn(),
  get: vi.fn(),
  updateConversationId: vi.fn(),
  findActiveSessionFor: vi.fn(),
} as unknown as SessionRouter;

const ctx = {
  sessionId: null,
  userId: "alice",
  role: "user" as const,
  sessionChannel: "voice" as const,
};

describe("update_user_settings", () => {
  it("rejects empty patch (no fields)", async () => {
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({}, ctx);
    expect(r.isError).toBe(true);
  });

  it("rejects invalid channel value", async () => {
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({ channel: "bogus" }, ctx);
    expect(r.isError).toBe(true);
  });

  it("errors when no active session", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings: vi.fn() },
      router: fakeRouter,
    });
    const r = await t.run({ ttsEnabled: false }, ctx);
    expect(r.isError).toBe(true);
  });

  it("invokes controls with valid ttsEnabled", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const updateUserSettings = vi.fn(async () => {});
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings },
      router: fakeRouter,
    });
    const r = await t.run({ ttsEnabled: false, channel: "text" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(updateUserSettings).toHaveBeenCalledWith("s1", "alice", {
      ttsEnabled: false,
      channel: "text",
    });
  });

  it("accepts voice + model fields", async () => {
    (fakeRouter.findActiveSessionFor as ReturnType<typeof vi.fn>).mockReturnValue("s1");
    const updateUserSettings = vi.fn(async () => {});
    const t = createUpdateUserSettingsTool({
      controls: { updateUserSettings },
      router: fakeRouter,
    });
    await t.run(
      {
        voice: { provider: "fish-audio", id: "v123" },
        model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
      },
      ctx,
    );
    expect(updateUserSettings).toHaveBeenCalledWith("s1", "alice", {
      voice: { provider: "fish-audio", id: "v123" },
      model: { provider: "openrouter", id: "anthropic/claude-sonnet-4" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test gateway/src/mcp-host/tools/update-user-settings.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the tool**

```ts
// gateway/src/mcp-host/tools/update-user-settings.ts
import { z } from "zod";
import { audioPrefsPatchSchema } from "../../../../shared/audio-prefs/schema.js";
import { modelProviderSchema, voiceProviderSchema } from "../../profile-store/profile-types.js";
import type { SessionRouter } from "../../session-router.js";
import type { ToolHandler } from "../mcp-server.js";

// Validated patch shape. Matches profile-store fields the model is allowed to
// mutate. Mirrored on the WS user.preferences.patch handler.
const patchSchema = z
  .object({
    ttsEnabled: audioPrefsPatchSchema.shape.ttsEnabled,
    channel: audioPrefsPatchSchema.shape.channel,
    voice: z.object({ provider: voiceProviderSchema, id: z.string().min(1) }).optional(),
    model: z.object({ provider: modelProviderSchema, id: z.string().min(1) }).optional(),
  })
  .refine(
    (p) =>
      p.ttsEnabled !== undefined ||
      p.channel !== undefined ||
      p.voice !== undefined ||
      p.model !== undefined,
    { message: "at least one field required" },
  );

export type UpdateUserSettingsPatch = z.output<typeof patchSchema>;

export interface UserSettingsControls {
  updateUserSettings(
    sessionId: string,
    userId: string,
    patch: UpdateUserSettingsPatch,
  ): Promise<void>;
}

export interface UpdateUserSettingsDeps {
  controls: UserSettingsControls;
  router: SessionRouter;
}

export function createUpdateUserSettingsTool(deps: UpdateUserSettingsDeps): ToolHandler {
  return {
    def: {
      name: "update_user_settings",
      description:
        "Updates the user's persisted settings. Use to mute/unmute spoken responses (`ttsEnabled`), switch reply channel (`channel`), or change the user's preferred `voice`/`model`. " +
        "All fields are optional; pass only what you want to change. " +
        "`ttsEnabled` and `channel` take effect on the NEXT cycle (current cycle finishes naturally). " +
        "`voice` and `model` take effect on the next session.",
      inputSchema: {
        type: "object",
        properties: {
          ttsEnabled: { type: "boolean" },
          channel: { type: "string", enum: ["voice", "text"] },
          voice: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["fish-audio"] },
              id: { type: "string" },
            },
            required: ["provider", "id"],
          },
          model: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["openrouter", "ollama-cloud", "custom"] },
              id: { type: "string" },
            },
            required: ["provider", "id"],
          },
        },
      },
    },
    async run(args, ctx) {
      const parsed = patchSchema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `update_user_settings: invalid input — ${parsed.error.message}`,
            },
          ],
        };
      }
      const sessionId = ctx.userId ? deps.router.findActiveSessionFor(ctx.userId) : null;
      if (!sessionId || !ctx.userId) {
        return {
          isError: true,
          content: [
            { type: "text", text: "update_user_settings: no active session for user" },
          ],
        };
      }
      await deps.controls.updateUserSettings(sessionId, ctx.userId, parsed.data);
      const summary = Object.entries(parsed.data)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(", ");
      return { content: [{ type: "text", text: `updated: ${summary}` }] };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test gateway/src/mcp-host/tools/update-user-settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp-host/tools/update-user-settings.ts gateway/src/mcp-host/tools/update-user-settings.test.ts
git commit -m "feat(mcp): add update_user_settings tool"
```

---

## Task 6: Wire the new tool's `controls`, register it, delete `set_channel`

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Modify: `gateway/src/bootstrap/create-mcp-host.ts`
- Delete: `gateway/src/mcp-host/tools/set-channel.ts`
- Delete: `gateway/src/mcp-host/tools/set-channel.test.ts`

- [ ] **Step 1: Add `updateUserSettings` to the session controls registration**

In `gateway/src/session-handlers/ws-session-configure.ts`, find the existing controls registration (around line 137):

```ts
services.sessionControls.register(sessionId, {
  setChannel(channel) {
    preferenceManager.update({ channel });
  },
});
```

Replace with:

```ts
services.sessionControls.register(sessionId, {
  async updateUserSettings(_sid, userId, patch) {
    // 1. Persist persistent fields to profile store. ttsEnabled + channel
    //    are persistent; voice/model are persistent too. All four go to
    //    the profile.
    if (
      patch.ttsEnabled !== undefined ||
      patch.channel !== undefined ||
      patch.voice !== undefined ||
      patch.model !== undefined
    ) {
      const cur = await services.profileStore.get(userId);
      if (cur.ok) {
        const nextProfile = {
          ...cur.value,
          audio: {
            ttsEnabled: patch.ttsEnabled ?? cur.value.audio.ttsEnabled,
            channel: patch.channel ?? cur.value.audio.channel,
          },
          voice: patch.voice ?? cur.value.voice,
          model: patch.model ?? cur.value.model,
        };
        await services.profileStore.save(nextProfile);
      } else {
        log.warn("update-user-settings.profile-read-failed", { userId, error: cur.error });
      }
    }
    // 2. Apply audio fields to the live PreferenceManager so the next cycle's
    //    entry gate sees them. voice/model do NOT hot-swap mid-session — they
    //    take effect on next session (PreferenceManager doesn't carry them).
    const prefPatch: { channel?: "voice" | "text"; ttsEnabled?: boolean } = {};
    if (patch.channel !== undefined) prefPatch.channel = patch.channel;
    if (patch.ttsEnabled !== undefined) prefPatch.ttsEnabled = patch.ttsEnabled;
    if (Object.keys(prefPatch).length > 0) {
      preferenceManager.update(prefPatch);
    }
  },
});
```

- [ ] **Step 2: Update the `SessionControls` interface**

Find `services.sessionControls` definition. It's likely under `gateway/src/services/` or `gateway/src/session-controls.ts`. Locate the `SessionControls` interface — it currently declares `setChannel`. Replace with:

```ts
export interface SessionControls {
  updateUserSettings(
    sessionId: string,
    userId: string,
    patch: UpdateUserSettingsPatch,
  ): Promise<void>;
}
```

Import `UpdateUserSettingsPatch` from `../mcp-host/tools/update-user-settings.js`. If the controls registry is generic (a Map keyed by sessionId), the only concrete change is the method name shift. Drop `setChannel` from any other callers (only `set-channel.ts` should reference it; that file is being deleted).

- [ ] **Step 3: Swap the tool registration**

In `gateway/src/bootstrap/create-mcp-host.ts` around line 46:

```ts
const registry = createToolRegistry([
  createIdentifyUserTool({ router, userStore }),
  createPauseAudioTool({ audio, router }),
  createResumeAudioTool({ audio, router }),
  createSetChannelTool({ controls: channel, router }),
]);
```

Replace with:

```ts
const registry = createToolRegistry([
  createIdentifyUserTool({ router, userStore }),
  createPauseAudioTool({ audio, router }),
  createResumeAudioTool({ audio, router }),
  createUpdateUserSettingsTool({ controls: userSettings, router }),
]);
```

Update the corresponding import:

```ts
// Remove
import { createSetChannelTool } from "../mcp-host/tools/set-channel.js";
// Add
import { createUpdateUserSettingsTool } from "../mcp-host/tools/update-user-settings.js";
```

The dependency name `channel` becomes `userSettings`. Trace back to where `channel` is constructed — likely the same file, a few lines above. Rename the variable. The shape changes from a `ChannelControls`-typed object to a `UserSettingsControls` adapter that proxies to the session-controls registry. Implement that adapter inline:

```ts
const userSettings: UserSettingsControls = {
  async updateUserSettings(sessionId, userId, patch) {
    const ctrl = sessionControls.get(sessionId);
    if (!ctrl) return;
    await ctrl.updateUserSettings(sessionId, userId, patch);
  },
};
```

(Adjust `sessionControls.get(...)` to whatever the existing accessor is. The existing channel-controls adapter shows the pattern.)

- [ ] **Step 4: Delete the old tool**

```bash
rm gateway/src/mcp-host/tools/set-channel.ts gateway/src/mcp-host/tools/set-channel.test.ts
```

- [ ] **Step 5: Verify build is clean**

```bash
bun run typecheck && bun run test gateway/src/mcp-host/tools/ gateway/src/session-handlers/
```

Expected: PASS. If there are stray `setChannel` references, hunt with `grep -rn "setChannel\|set_channel\|set-channel" gateway/src/` and fix.

- [ ] **Step 6: Commit**

```bash
git add -A gateway/src/
git commit -m "feat(mcp): swap set_channel for update_user_settings registration"
```

---

## Task 7: Inbound `user.preferences.patch` WS handler

**Files:**
- Create: `gateway/src/session-handlers/handle-preferences-patch.ts`
- Create: `gateway/src/session-handlers/handle-preferences-patch.test.ts`
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (register handler)

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/session-handlers/handle-preferences-patch.test.ts
import { describe, expect, it, vi } from "vitest";
import { handlePreferencesPatch } from "./handle-preferences-patch.js";
import { createPreferenceManager } from "../cerebrum/preferences.js";

function makePm() {
  return createPreferenceManager({
    initial: { language: "auto", channel: "voice", ttsEnabled: true },
  });
}

describe("handlePreferencesPatch", () => {
  it("applies a valid ttsEnabled patch", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: { ttsEnabled: false } },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(pm.get().ttsEnabled).toBe(false);
    expect(persist).toHaveBeenCalledWith("alice", { ttsEnabled: false });
  });

  it("rejects malformed payload silently", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: { ttsEnabled: "no" } },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(pm.get().ttsEnabled).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("ignores empty patch", async () => {
    const pm = makePm();
    const persist = vi.fn(async () => {});
    await handlePreferencesPatch({
      raw: { type: "user.preferences.patch", payload: {} },
      preferenceManager: pm,
      persistAudioPatch: persist,
      sessionId: "s1",
      userId: "alice",
    });
    expect(persist).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test gateway/src/session-handlers/handle-preferences-patch.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the handler**

```ts
// gateway/src/session-handlers/handle-preferences-patch.ts
import { audioPrefsPatchSchema } from "../../../shared/audio-prefs/schema.js";
import type { PreferenceManager } from "../cerebrum/preferences.js";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "session-handlers", "preferences-patch"]);

export interface HandlePreferencesPatchDeps {
  raw: unknown;
  preferenceManager: PreferenceManager;
  persistAudioPatch: (userId: string, patch: { ttsEnabled?: boolean; channel?: "voice" | "text" }) => Promise<void>;
  sessionId: string;
  userId: string;
}

export async function handlePreferencesPatch(
  deps: HandlePreferencesPatchDeps,
): Promise<void> {
  const r = deps.raw as { type?: string; payload?: unknown };
  if (r?.type !== "user.preferences.patch") return;
  const parsed = audioPrefsPatchSchema.safeParse(r.payload);
  if (!parsed.success) {
    log.warn("invalid-payload", {
      sessionId: deps.sessionId,
      userId: deps.userId,
      reason: parsed.error.message,
    });
    return;
  }
  const patch = parsed.data;
  if (patch.ttsEnabled === undefined && patch.channel === undefined) {
    log.debug("empty-patch", { sessionId: deps.sessionId });
    return;
  }
  await deps.persistAudioPatch(deps.userId, patch);
  deps.preferenceManager.update(patch);
  log.info("applied", {
    sessionId: deps.sessionId,
    userId: deps.userId,
    patch,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test gateway/src/session-handlers/handle-preferences-patch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Register the handler in `ws-session-configure.ts`**

Find the WS message dispatch site. There's an `ws.on("message", ...)` or `wireMessage(type, handler)` style routing. Search:

```bash
grep -n 'on("message"\|registerHandler\|switch.*type' gateway/src/session-handlers/ws-session-configure.ts | head
```

Add a case/handler for `user.preferences.patch` that calls `handlePreferencesPatch`:

```ts
import { handlePreferencesPatch } from "./handle-preferences-patch.js";

// inside the message dispatcher, alongside other type cases:
case "user.preferences.patch":
  await handlePreferencesPatch({
    raw: parsed,
    preferenceManager,
    persistAudioPatch: async (uid, p) => {
      const cur = await services.profileStore.get(uid);
      if (!cur.ok) return;
      await services.profileStore.save({
        ...cur.value,
        audio: {
          ttsEnabled: p.ttsEnabled ?? cur.value.audio.ttsEnabled,
          channel: p.channel ?? cur.value.audio.channel,
        },
      });
    },
    sessionId,
    userId: initialBinding.userId,
  });
  break;
```

If the file uses an object-map of handlers instead of a switch, add the same key. Mirror the pattern of an existing handler (the one for `audio.start`, `set_voice_mode`, or similar — find via the same grep).

- [ ] **Step 6: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/session-handlers/handle-preferences-patch.ts gateway/src/session-handlers/handle-preferences-patch.test.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(gateway): handle user.preferences.patch WS frame"
```

---

## Task 8: Outbound `session.preferences.changed` emission

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`

- [ ] **Step 1: Hook `PreferenceManager.onChange` to emit a frame**

After the `preferenceManager` is created and `ws.data.preferenceManager = preferenceManager` is set (around line 128), add:

```ts
preferenceManager.onChange((next, _prev, changed) => {
  // Only emit when audio-related fields change. Language is internal.
  const audioChanged =
    changed.includes("ttsEnabled") || changed.includes("channel");
  if (!audioChanged) return;
  ws.send(
    JSON.stringify({
      type: "session.preferences.changed",
      preferences: {
        ttsEnabled: next.ttsEnabled,
        channel: next.channel,
      },
    }),
  );
  log.debug("preferences-emit", {
    sessionId,
    ttsEnabled: next.ttsEnabled,
    channel: next.channel,
  });
});
```

The existing `wsSend` helper (used elsewhere in this file) may be the better wrapper — match the surrounding style. If `wsSend` automatically stringifies, drop the `JSON.stringify`.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(gateway): emit session.preferences.changed on audio pref change"
```

---

## Task 9: Web SDK `PreferencesConnector`

**Files:**
- Create: `shared/web-sdk/src/connectors/preferences-connector.ts`
- Create: `shared/web-sdk/src/connectors/preferences-connector.test.ts`
- Modify: `shared/web-sdk/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// shared/web-sdk/src/connectors/preferences-connector.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SentientSDKInternal } from "../connector-types.ts";
import { PreferencesConnector, type AudioPreferences } from "./preferences-connector.ts";

function createMockInternal(): SentientSDKInternal & {
  messageHandlers: Map<string, (msg: unknown) => void>;
  sentMessages: unknown[];
} {
  const messageHandlers = new Map<string, (msg: unknown) => void>();
  const sentMessages: unknown[] = [];
  return {
    messageHandlers,
    sentMessages,
    send(m) {
      sentMessages.push(m);
    },
    sendBinary() {},
    onMessage(type, handler) {
      messageHandlers.set(type, handler);
      return () => {
        messageHandlers.delete(type);
      };
    },
    onBinary() {
      return () => {};
    },
  };
}

describe("PreferencesConnector", () => {
  it("has capability session.preferences", () => {
    const c = new PreferencesConnector();
    expect(c.capability).toBe("session.preferences");
  });

  it("starts at default {ttsEnabled:true, channel:'voice'}", () => {
    const c = new PreferencesConnector();
    expect(c.current()).toEqual({ ttsEnabled: true, channel: "voice" });
  });

  it("updates state on session.preferences.changed", () => {
    const onChange = vi.fn<(next: AudioPreferences) => void>();
    const c = new PreferencesConnector({ onChange });
    const sdk = createMockInternal();
    c.attach(sdk);
    sdk.messageHandlers.get("session.preferences.changed")?.({
      type: "session.preferences.changed",
      preferences: { ttsEnabled: false, channel: "text" },
    });
    expect(c.current()).toEqual({ ttsEnabled: false, channel: "text" });
    expect(onChange).toHaveBeenCalledWith({ ttsEnabled: false, channel: "text" });
  });

  it("emits user.preferences.patch on patch()", () => {
    const c = new PreferencesConnector();
    const sdk = createMockInternal();
    c.attach(sdk);
    c.patch({ ttsEnabled: false });
    expect(sdk.sentMessages).toEqual([
      { type: "user.preferences.patch", payload: { ttsEnabled: false } },
    ]);
  });

  it("seed() sets current without sending", () => {
    const c = new PreferencesConnector();
    const sdk = createMockInternal();
    c.attach(sdk);
    c.seed({ ttsEnabled: false, channel: "voice" });
    expect(c.current()).toEqual({ ttsEnabled: false, channel: "voice" });
    expect(sdk.sentMessages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test shared/web-sdk/src/connectors/preferences-connector.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the connector**

```ts
// shared/web-sdk/src/connectors/preferences-connector.ts
import type { Connector, SentientSDKInternal } from "../connector-types.ts";

export interface AudioPreferences {
  ttsEnabled: boolean;
  channel: "voice" | "text";
}

export interface AudioPreferencesPatch {
  ttsEnabled?: boolean;
  channel?: "voice" | "text";
}

const DEFAULT_PREFS: AudioPreferences = { ttsEnabled: true, channel: "voice" };

export interface PreferencesConnectorConfig {
  onChange?: (next: AudioPreferences) => void;
}

// ---------------------------------------------------------------------------
// PreferencesConnector — observes server-driven audio preference changes
// (e.g. model called update_user_settings) and lets the app push patches up
// to the gateway.
//
// Capability: "session.preferences"
// Direction: status (observes), but also sends user.preferences.patch when
// the app calls patch(). Mirrors the dual nature of UserAudioInputConnector.
// ---------------------------------------------------------------------------

export class PreferencesConnector implements Connector {
  readonly capability = "session.preferences";
  readonly kind = "status" as const;

  private readonly config: PreferencesConnectorConfig;
  private sdk: SentientSDKInternal | null = null;
  private unsub: (() => void) | null = null;
  private state: AudioPreferences = { ...DEFAULT_PREFS };

  constructor(config: PreferencesConnectorConfig = {}) {
    this.config = config;
  }

  attach(sdk: SentientSDKInternal): void {
    this.sdk = sdk;
    this.unsub = sdk.onMessage("session.preferences.changed", (msg: unknown) => {
      const m = msg as { preferences?: Partial<AudioPreferences> };
      const next: AudioPreferences = {
        ttsEnabled: m.preferences?.ttsEnabled ?? this.state.ttsEnabled,
        channel: m.preferences?.channel ?? this.state.channel,
      };
      const changed =
        next.ttsEnabled !== this.state.ttsEnabled || next.channel !== this.state.channel;
      this.state = next;
      if (changed) this.config.onChange?.(next);
    });
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.sdk = null;
    this.state = { ...DEFAULT_PREFS };
  }

  /** Current snapshot of audio preferences. */
  current(): AudioPreferences {
    return this.state;
  }

  /** Seed the current state from external storage (e.g. profile) without
   *  emitting a frame. Use when the app loads the profile before the SDK
   *  has received any server-driven preference updates. */
  seed(prefs: AudioPreferences): void {
    this.state = prefs;
  }

  /** Send a patch to the gateway. Server will echo via session.preferences.changed. */
  patch(p: AudioPreferencesPatch): void {
    if (this.sdk === null) return;
    this.sdk.send({ type: "user.preferences.patch", payload: p });
  }
}
```

- [ ] **Step 4: Export from `index.ts`**

In `shared/web-sdk/src/index.ts`, add near the other connector exports (around line 28):

```ts
export { PreferencesConnector } from "./connectors/preferences-connector.ts";
export type {
  AudioPreferences,
  AudioPreferencesPatch,
  PreferencesConnectorConfig,
} from "./connectors/preferences-connector.ts";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun run test shared/web-sdk/src/connectors/preferences-connector.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/connectors/preferences-connector.ts shared/web-sdk/src/connectors/preferences-connector.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): add PreferencesConnector"
```

---

## Task 10: Add `volume-2` and `volume-x` icons

**Files:**
- Create: `gateway/webui/src/components/common/icons/volume-2.tsx`
- Create: `gateway/webui/src/components/common/icons/volume-x.tsx`
- Modify: `gateway/webui/src/components/common/icon.tsx`

- [ ] **Step 1: Add `volume-2` icon**

```tsx
// gateway/webui/src/components/common/icons/volume-2.tsx
import type { JSX } from "preact";

export function Volume2Icon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}
```

- [ ] **Step 2: Add `volume-x` icon**

```tsx
// gateway/webui/src/components/common/icons/volume-x.tsx
import type { JSX } from "preact";

export function VolumeXIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}
```

- [ ] **Step 3: Register both icons in `icon.tsx`**

In `gateway/webui/src/components/common/icon.tsx`:

Add imports near the others:

```ts
import { Volume2Icon } from "./icons/volume-2.tsx";
import { VolumeXIcon } from "./icons/volume-x.tsx";
```

Add to the `IconName` union (alphabetical with the others):

```ts
export type IconName =
  | "mic" | "mic-off" | "send" | "chat" | "bell" | "settings"
  | "x" | "sliders" | "chevron" | "lamp" | "thermo" | "spark"
  | "globe" | "music" | "check" | "phone" | "plus"
  | "key" | "play" | "pause" | "trash"
  | "book-open" | "brain" | "drama" | "waveform" | "cpu" | "wrench"
  | "sliders-h" | "user-circle" | "users-group" | "menu"
  | "more-horizontal" | "pencil" | "search"
  | "volume-2" | "volume-x";
```

Add cases to the icon switch/registry (find the existing pattern around the `Icon` component body — there's likely a `switch (name)` or a registry object). Add:

```tsx
case "volume-2": return <Volume2Icon size={size} />;
case "volume-x": return <VolumeXIcon size={size} />;
```

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/components/common/icons/volume-2.tsx gateway/webui/src/components/common/icons/volume-x.tsx gateway/webui/src/components/common/icon.tsx
git commit -m "feat(webui): add volume-2 + volume-x icons"
```

---

## Task 11: Create `TtsButton` component

**Files:**
- Create: `gateway/webui/src/components/dock/tts-button.tsx`
- Modify: `gateway/webui/src/components/common/icon-button.tsx` (variant enum)

- [ ] **Step 1: Add `tts-on` and `tts-off` to the IconButton variant union**

Open `gateway/webui/src/components/common/icon-button.tsx` and locate the `variant` prop type (around line 8). Add the two new values:

```ts
variant?: "default" | "primary" | "mic-on" | "mic-off" | "tts-on" | "tts-off";
```

(Match whatever existing values are present — don't overwrite.) The CSS class is generated as `icon-btn--${variant}`. Task 14 adds the corresponding CSS.

- [ ] **Step 2: Create `TtsButton`**

```tsx
// gateway/webui/src/components/dock/tts-button.tsx
import type { JSX } from "preact";
import { IconButton } from "../common/icon-button.tsx";

export interface TtsButtonProps {
  enabled: boolean;
  onToggle(): void;
}

export function TtsButton({ enabled, onToggle }: TtsButtonProps): JSX.Element {
  return (
    <IconButton
      iconName={enabled ? "volume-2" : "volume-x"}
      title={enabled ? "Mute assistant voice" : "Unmute assistant voice"}
      variant={enabled ? "tts-on" : "tts-off"}
      active={enabled}
      onClick={onToggle}
    />
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/dock/tts-button.tsx gateway/webui/src/components/common/icon-button.tsx
git commit -m "feat(webui): add TtsButton component"
```

---

## Task 12: Wire `PreferencesConnector` into the voice-client hook

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`

- [ ] **Step 1: Find the right insertion points**

Open `gateway/webui/src/hooks/use-voice-client.ts`. Two reference points:
- The `voiceMode` signal declaration (around line 80) — add a `prefs` signal nearby.
- The connector mount section (look for `new UserAudioInputConnector` or similar `new ...Connector`) — register `PreferencesConnector` next to it.
- The return object at the bottom (around line 573) — add `prefs` and `patchPreferences`.

- [ ] **Step 2: Add the signal**

Near `voiceMode = useSignal(...)`:

```ts
import type { AudioPreferences } from "@sentient/web-sdk";
import { PreferencesConnector } from "@sentient/web-sdk";
// ...
const prefs = useSignal<AudioPreferences>({ ttsEnabled: true, channel: "voice" });
```

- [ ] **Step 3: Mount the connector**

In the connector-mount block:

```ts
const preferencesConnector = useRef<PreferencesConnector | null>(null);
if (preferencesConnector.current === null) {
  preferencesConnector.current = new PreferencesConnector({
    onChange: (next) => {
      prefs.value = next;
    },
  });
  client.registerConnector(preferencesConnector.current); // match how other connectors are attached
}
```

(Adapt to the existing connector-registration pattern in the same file — look for how `UserAudioInputConnector` or `CognitionStatusConnector` is wired.)

When the profile loads (find the `profile-api` fetch — likely a `useEffect` that fetches the profile on mount), seed the connector so the button's initial state matches the persisted profile:

```ts
preferencesConnector.current?.seed({
  ttsEnabled: profile.audio.ttsEnabled,
  channel: profile.audio.channel,
});
prefs.value = { ttsEnabled: profile.audio.ttsEnabled, channel: profile.audio.channel };
```

- [ ] **Step 4: Expose `patchPreferences`**

In the hook's return object:

```ts
return {
  // ... existing fields ...
  voiceMode,
  prefs,
  startVoiceMode: async () => { /* ... */ },
  stopVoiceMode: async () => { /* ... */ },
  patchPreferences: (patch: { ttsEnabled?: boolean; channel?: "voice" | "text" }) => {
    preferencesConnector.current?.patch(patch);
  },
};
```

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts
git commit -m "feat(webui): wire PreferencesConnector into use-voice-client"
```

---

## Task 13: Slot `TtsButton` into `Composer` and wire from `app.tsx`

**Files:**
- Modify: `gateway/webui/src/components/dock/composer.tsx`
- Modify: `gateway/webui/src/app.tsx`

- [ ] **Step 1: Extend `ComposerProps` with TTS state and handler**

In `gateway/webui/src/components/dock/composer.tsx`, add to `ComposerProps`:

```ts
ttsEnabled: boolean;
onTtsToggle(): void;
```

Destructure them at the top of the function:

```ts
const { cycleStatus, voiceMode, canInterrupt, connectionReady, suggestions, ttsEnabled } = props;
const { onSendText, onMicToggle, onInterrupt, onSuggestionClick, onTtsToggle } = props;
```

- [ ] **Step 2: Slot the button between Mic and the spacer**

Find the bottom-row JSX:

```tsx
<div class="composer__bottom-row">
  <MicButton active={voiceActive} onToggle={onMicToggle} />
  <span class="composer__spacer" />
  <SendButton disabled={sendDisabled} onSend={submit} />
  {canInterrupt && <InterruptButton onInterrupt={onInterrupt} />}
</div>
```

Replace with:

```tsx
<div class="composer__bottom-row">
  <MicButton active={voiceActive} onToggle={onMicToggle} />
  <TtsButton enabled={ttsEnabled} onToggle={onTtsToggle} />
  <span class="composer__spacer" />
  <SendButton disabled={sendDisabled} onSend={submit} />
  {canInterrupt && <InterruptButton onInterrupt={onInterrupt} />}
</div>
```

Add the import at the top:

```ts
import { TtsButton } from "./tts-button.tsx";
```

- [ ] **Step 3: Wire from `app.tsx`**

Find the `<Composer ... />` render in `gateway/webui/src/app.tsx` (around line 235). Add the new props:

```tsx
<Composer
  cycleStatus={...}
  voiceMode={client.voiceMode.value}
  canInterrupt={...}
  connectionReady={...}
  suggestions={...}
  ttsEnabled={client.prefs.value.ttsEnabled}
  onSendText={...}
  onMicToggle={...}
  onTtsToggle={() => {
    const next = !client.prefs.value.ttsEnabled;
    // Optimistic flip
    client.prefs.value = { ...client.prefs.value, ttsEnabled: next };
    // Persist via existing profile PUT — fire-and-forget; on failure revert
    profileApi
      .patchAudio({ ttsEnabled: next })
      .then(() => {
        client.patchPreferences({ ttsEnabled: next });
      })
      .catch((err) => {
        log.warn("tts-toggle-failed", { error: err });
        client.prefs.value = { ...client.prefs.value, ttsEnabled: !next };
        // surface a toast — match existing toast pattern in app.tsx
      });
  }}
  onInterrupt={...}
  onSuggestionClick={...}
/>
```

- [ ] **Step 4: Add `patchAudio` helper to profile-api**

In `gateway/webui/src/services/profile-api.ts`, add a helper that does the read-modify-write against `/api/v1/profile/me` (the existing PUT route accepts the full profile):

```ts
export async function patchAudio(
  patch: { ttsEnabled?: boolean; channel?: "voice" | "text" },
): Promise<Result<ProfileV1>> {
  const cur = await fetchProfile();
  if (!cur.ok) return cur;
  const next: ProfileV1 = {
    ...cur.value,
    audio: {
      ttsEnabled: patch.ttsEnabled ?? cur.value.audio.ttsEnabled,
      channel: patch.channel ?? cur.value.audio.channel,
    },
  };
  return saveProfile(next);
}
```

(Use the existing `fetchProfile` / `saveProfile` helpers in the file. Match their signatures exactly.)

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add gateway/webui/src/components/dock/composer.tsx gateway/webui/src/app.tsx gateway/webui/src/services/profile-api.ts
git commit -m "feat(webui): slot TTS button in Composer + wire from app"
```

---

## Task 14: Mirror `audio` field in webui `ProfileV1`

**Files:**
- Modify: `gateway/webui/src/services/profile-api.ts`

- [ ] **Step 1: Add `audio` to the local `ProfileV1` interface**

```ts
export interface ProfileV1 {
  schemaVersion: 1;
  userId: string;
  model: { provider: ModelProvider; id: string };
  voice: { provider: VoiceProvider; id: string };
  audio: { ttsEnabled: boolean; channel: "voice" | "text" };
  persona: { template: string; overrides: string };
  tools: { enabled: Record<string, string[]> };
  compression: { threshold: number };
  advanced: { extraSystemPrompt: string; maxTokens: number };
}
```

(`patchAudio` from Task 13 already references `cur.value.audio` — adding the type here completes the contract.)

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/services/profile-api.ts
git commit -m "chore(webui): mirror profile.audio field on ProfileV1 interface"
```

---

## Task 15: CSS variants + mobile gap

**Files:**
- Modify: `gateway/webui/src/styles/components.css`

- [ ] **Step 1: Add `tts-on` / `tts-off` variants**

After the existing `.icon-btn--mic-off` block (around line 864), append:

```css
.composer__bottom-row .icon-btn--tts-on {
  color: var(--color-accent);
  background: color-mix(in oklab, var(--color-accent) 14%, var(--color-paper));
  border-color: color-mix(in oklab, var(--color-accent) 35%, var(--color-line));
}
.composer__bottom-row .icon-btn--tts-off {
  color: var(--color-ink-3);
  background: var(--color-bg-sunk);
  border-color: var(--color-line);
}
```

- [ ] **Step 2: Tighten the bottom-row gap on narrow viewports**

Find the existing `.composer__bottom-row` rule (search for `.composer__bottom-row` in the same file). Inside or after it, add a media query that ensures the two-icon left cluster stays comfortable at 390px width. If the row already has `gap`, override it inside the media query; otherwise add:

```css
.composer__bottom-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
@media (max-width: 620px) {
  .composer__bottom-row {
    gap: 6px;
  }
}
```

(Adapt to whatever the existing rule already specifies — only add what's missing.)

- [ ] **Step 3: Visual sanity check (manual)**

```bash
bun run dev
```

Open `http://localhost:5173` (or whatever port the dev server logs). Verify in browser:
- Both buttons visible on desktop
- Both buttons visible at 390×844 (use DevTools mobile emulation)
- 44px tap target on each
- TTS-on and TTS-off colors look intentional

Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add gateway/webui/src/styles/components.css
git commit -m "feat(webui): TTS button variants + mobile bottom-row gap"
```

---

## Task 16: Settings page Audio pane + tab

**Files:**
- Create: `gateway/webui/src/components/settings/panes/audio-pane.tsx`
- Modify: `gateway/webui/src/components/settings/sidebar/nav-config.ts`
- Modify: `gateway/webui/src/components/settings/settings-view.tsx`

- [ ] **Step 1: Create the Audio pane**

```tsx
// gateway/webui/src/components/settings/panes/audio-pane.tsx
import type { JSX } from "preact";
import type { ProfileV1 } from "../../../services/profile-api.ts";

export interface AudioPaneProps {
  profile: ProfileV1;
  onChange(next: ProfileV1): void;
}

export function AudioPane({ profile, onChange }: AudioPaneProps): JSX.Element {
  function setAudio(patch: Partial<ProfileV1["audio"]>) {
    onChange({ ...profile, audio: { ...profile.audio, ...patch } });
  }

  return (
    <div class="settings-pane">
      <h2 class="settings-pane__title">Audio</h2>

      <label class="settings-pane__row">
        <span class="settings-pane__label">Speak responses (TTS)</span>
        <input
          type="checkbox"
          checked={profile.audio.ttsEnabled}
          onChange={(e) =>
            setAudio({ ttsEnabled: (e.target as HTMLInputElement).checked })
          }
        />
      </label>

      <label class="settings-pane__row">
        <span class="settings-pane__label">Reply channel</span>
        <select
          value={profile.audio.channel}
          onChange={(e) =>
            setAudio({
              channel: (e.target as HTMLSelectElement).value as "voice" | "text",
            })
          }
        >
          <option value="voice">Voice (audio + chat)</option>
          <option value="text">Text only (suppress audio)</option>
        </select>
      </label>

      <p class="settings-pane__hint">
        Both settings take effect on the next reply. Settings persist across
        sessions and devices.
      </p>
    </div>
  );
}
```

(Match the styling primitives the existing panes use — find one nearby, e.g. `voice-pane.tsx`, and mirror class names. The above uses placeholder class names; replace with the existing pane's conventions if they differ.)

- [ ] **Step 2: Register the `audio` tab**

In `gateway/webui/src/components/settings/sidebar/nav-config.ts`:

```ts
export type SidebarKey = "memory" | "personalities" | "voice" | "audio" | "model" | "tools" | "systemPrompt" | "advanced" | "account" | "members" | "secrets";

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    group: "Soul",
    items: [
      { key: "memory", label: "Memory", icon: "brain" },
      { key: "personalities", label: "Personalities", icon: "drama" },
      { key: "voice", label: "Voice", icon: "waveform" },
      { key: "audio", label: "Audio", icon: "volume-2" },
      // ... keep existing items unchanged
    ],
  },
  // ... rest unchanged
];

export const SOUL_KEYS = new Set(["memory", "personalities", "voice", "audio", "model", "tools", "systemPrompt", "advanced"]);
export const APPLY_BAR_KEYS = new Set([...SOUL_KEYS, "secrets"]);
```

(Add `audio` to whatever existing membership sets the existing `voice` key has. Don't drop existing keys — these are illustrative.)

- [ ] **Step 3: Render the pane in `settings-view.tsx`**

Find the switch / map that selects which pane component to render based on the active sidebar key. Add a case for `audio`:

```tsx
import { AudioPane } from "./panes/audio-pane.tsx";

// inside the pane-selector:
case "audio":
  return <AudioPane profile={profile} onChange={setProfile} />;
```

(Match the existing `case "voice": return <VoicePane ... />` shape exactly — same prop names, same handler.)

- [ ] **Step 4: Run typecheck + visual check**

```bash
bun run typecheck
bun run dev
```

Open settings → click "Audio" tab. Toggle the checkbox; the change should reflect optimistically. Save (whatever the existing settings save flow does) — verify it persists by reloading.

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/settings/panes/audio-pane.tsx gateway/webui/src/components/settings/sidebar/nav-config.ts gateway/webui/src/components/settings/settings-view.tsx
git commit -m "feat(webui): add Audio settings pane"
```

---

## Task 17: End-to-end smoke matrix via Playwright MCP

**Files:**
- Evidence: `.playwright-mcp/tts-button-{desktop,mobile}.png`
- Optional: append findings to `agents/docs/learnings.md` if anything surprising surfaces

- [ ] **Step 1: Run quality gate**

```bash
bun run ci
```

All green before proceeding to smoke.

- [ ] **Step 2: Bring up the local Docker stack**

```bash
cd deploy/macos && docker compose up -d --build
```

Wait for `gateway` + `hermes` + `local-stt` containers to be healthy. Verify:

```bash
docker compose ps
```

- [ ] **Step 3: Sign into the web UI in Playwright**

Use the project's free credentials (the `agents/docs/testing-knowledge.md` file documents the local test account). Drive Playwright MCP to:

- Navigate to the dev URL (per local stack config)
- Complete the auth handshake
- Reach the main composer view at desktop 1280×900

- [ ] **Step 4: Run the smoke matrix from the spec**

For each of cases 1–9 in the spec, drive Playwright to perform the action and assert the verification surface. Capture a screenshot at the decision point of each case under `.playwright-mcp/`.

For container-side log assertions, use:

```bash
docker exec sentient-gateway tail -f /app/gateway/logs/$(date -u +%Y-%m-%d).log | grep -E 'tts\.|preferences-'
```

For profile.json inspection:

```bash
docker exec sentient-gateway cat /home/sentient/.sentient/profiles/<userId>/profile.json | jq '.audio'
```

- [ ] **Step 5: Resize to mobile and re-run cases 1, 2, 8 at 390×844**

```
browser_resize(390, 844)
```

Capture `tts-button-mobile.png`. Confirm both buttons fit, tap targets are 44px, no overflow.

- [ ] **Step 6: Document smoke results**

Append the smoke run output to the bottom of the spec file (or create a sibling `*-smoke-notes.md`) with: case number, pass/fail, evidence file path, any deviations.

- [ ] **Step 7: Tear down and commit evidence**

```bash
cd deploy/macos && docker compose down
git add .playwright-mcp/
git commit -m "test(smoke): TTS toggle button — full matrix green"
```

---

## Self-Review

Spec coverage check (each spec section → task):
- Goal / non-goals → captured in plan header
- State model (audio field) → Task 2
- Pipeline gating (entry only, two flags) → Task 4
- MCP tool consolidation → Tasks 5 + 6
- UI button + icons + layout → Tasks 10 + 11 + 13 + 15
- Wire path (PUT + WS) → Tasks 7 + 13
- Observability (model-driven flips → button) → Tasks 8 + 9 + 12
- Shared validation → Task 1
- Migration (legacy profile, set_channel removal, settings pane same PR) → Tasks 2 + 6 + 16
- Smoke matrix → Task 17
- Open Q1 (voice/model hot-swap) → resolved in Task 6 (voice/model only persisted, not applied to live PreferenceManager)
- Open Q2 (tool discoverability) → tool description in Task 5 lists all settable fields
- Open Q3 (settings pane in same PR) → Task 16

Placeholder scan: clean — no TBD/TODO; every code-bearing step has actual code.

Type consistency: `AudioPrefs` from `shared/audio-prefs/schema.ts` is used everywhere prefs cross a boundary; `AudioPreferences` (web SDK) is the same shape; `UpdateUserSettingsPatch` is the patch shape with `voice`/`model` added. `ttsEnabled`/`channel` names match across all layers.
