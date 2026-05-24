# TTS Toggle Button + Consolidated User-Settings Tool

**Status:** design approved, pending plan
**Branch target:** `feature/tts-toggle-button` off `develop`

## Goal

Add a user-facing button next to the existing mic toggle that turns assistant TTS on/off. Persist the setting to the user profile so it survives reconnects. Consolidate the model-side knobs (`set_channel`) into a single `update_user_settings` MCP tool that covers all profile-persistent settings the model is allowed to mutate.

## Non-goals

- Building the full Settings-page Audio pane UI beyond a minimal mirror of the two new fields. Deeper settings (eq, voice variants, etc.) are deferred.
- Restructuring `voice` / `model` profile fields. They become legal arguments to the new tool but their shape is unchanged.
- Mobile-native (Android/iOS) clients. Web only this PR.

## Background

Today:

- `MicButton` (`gateway/webui/src/components/dock/mic-button.tsx`) toggles "voice mode" — mic on/off via `client.startVoiceMode()` / `stopVoiceMode()`.
- `set_channel` MCP tool (`gateway/src/mcp-host/tools/set-channel.ts`) lets the model flip a per-session `channel` preference (`"voice" | "text"`). `channel === "text"` suppresses TTS.
- `PreferenceManager` (`gateway/src/cerebrum/preferences.ts`) holds session-scoped `{language, channel}`. Resets on reconnect.
- TTS dispatch site at `gateway/src/session-handlers/ws-session-configure.ts:220, 236` gates on `channel === "voice"`.
- `ProfileV1` (`gateway/src/profile-store/profile-types.ts`) holds `model`, `voice`, `persona`, `tools`, `compression`, `advanced`. No audio fields. Persisted via `PUT /api/v1/profile/me`.
- Settings page (`gateway/webui/src/components/settings/settings-view.tsx`) exists; voice pane covers voice selection only.

## Design

### State model — promote channel to profile

`ProfileV1` gains:

```ts
audio: {
  ttsEnabled: boolean;        // default true
  channel: "voice" | "text";  // default "voice"
}
```

Zod `.default({ttsEnabled: true, channel: "voice"})` on the `audio` field handles legacy profiles missing it. No schema-version bump.

`SessionPreferences` gains `ttsEnabled: boolean` alongside existing `language`/`channel`. `PreferenceManager` seeds from `profile.audio` at session start instead of defaulting to `"voice"`.

### TTS pipeline gating — entry only

`ttsEnabled` is a plain "next time" setting. **No in-flight stop, no mid-stream re-check, no client audio interruption.** The current cycle finishes naturally; the next TTS dispatch respects the new value.

Single edit at the existing entry gate in `startTts` (`ws-session-configure.ts:318`):

```ts
// Before
const initialChannel = preferenceManager.get().channel;
if (initialChannel !== "voice") {
  log.info("tts.skip.channel-text", { ... when: "startTts-entry" });
  // drain + skip
}

// After
const prefs = preferenceManager.get();
if (prefs.channel !== "voice" || !prefs.ttsEnabled) {
  log.info("tts.skip.audio-prefs", {
    when: "startTts-entry",
    reason: prefs.ttsEnabled ? "channel-text" : "tts-disabled",
    channel: prefs.channel,
    ttsEnabled: prefs.ttsEnabled,
    sessionId, cycleId,
  });
  // drain + skip — same as today
}
```

The mid-stream `gateByChannel` (`ws-session-configure.ts:365`) is **untouched** — channel-only, existing behavior preserved. No rename, no second flag.

Existing log lines (`tts.start`, `tts.cancel`, `tts.skip.channel-text` mid-stream variant) stay as-is. Only the entry-gate skip log changes shape, and is renamed to `tts.skip.audio-prefs` to disambiguate the two flags via the `reason` field.

### MCP tool — `update_user_settings`

New file: `gateway/src/mcp-host/tools/update-user-settings.ts`. Replaces `set-channel.ts` (deleted in same commit).

```
update_user_settings({
  ttsEnabled?: boolean,
  channel?:    "voice" | "text",
  voice?:      { provider: VoiceProvider, id: string },
  model?:      { provider: ModelProvider, id: string }
})
```

Handler steps:

1. Resolve session via `router.findActiveSessionFor(ctx.userId)`. Error if none.
2. Validate patch against shared zod schema (see "Shared validation" below).
3. Persist patch to profile store (Hermes-backed write through existing profile-store API).
4. Apply audio-related fields to `PreferenceManager.update(...)` for immediate session effect. (`voice` / `model` take effect on next session unless we want hot-swap — see open question Q1.)
5. Return a single text content describing what changed (e.g. `"updated: ttsEnabled=false, channel=text"`).

### UI — TTS button

New file: `gateway/webui/src/components/dock/tts-button.tsx`. Same shape as `MicButton`:

```tsx
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

New icons under `gateway/webui/src/components/common/icons/`:
- `volume-2.tsx` — speaker with two arc lines (lucide `volume-2` shape)
- `volume-x.tsx` — speaker with X (lucide `volume-x` shape)

Add both to the `IconName` union and `iconRegistry` in `icon.tsx`.

CSS variants `tts-on` / `tts-off` mirror `mic-on` / `mic-off` color tokens — same active treatment, same disabled state.

### Composer layout

Updated bottom row in `gateway/webui/src/components/dock/composer.tsx`:

```
[Mic] [TTS] [spacer] [Send] [Interrupt?]
```

Both audio I/O toggles cluster left, separated from primary actions on the right by the existing flex spacer. Adjacency communicates "audio control group" — no border, just the existing `composer__bottom-row` gap.

Mobile (≤620px, `prefers-reduced-data` not applicable here): the existing CSS already handles narrow layouts. Add a `gap` adjustment so the two-icon cluster stays comfortable on the narrow viewport. Each button stays at the existing 44×44 touch target; total left cluster = 88px + gap, fits within the typical 320–390px composer width with room for Send.

### Wire path

**User clicks button (browser):**

1. Optimistic flip local `ttsEnabled` signal.
2. `PUT /api/v1/profile/me` with patched profile. Existing `profile-api.ts` route, no new endpoint.
3. On 200 → send WS control frame `{type: "user.preferences.patch", payload: {ttsEnabled}}` so the current session's `PreferenceManager` updates without a reconnect.
4. On non-2xx → revert signal, show toast.

**Why both PUT + WS:** `profile.audio` is read once at session start to seed `PreferenceManager`. Without the WS frame, the user would have to reconnect to feel the change. PUT alone leaves session state stale; WS alone leaves the next session stale. Both — same as how the existing settings UI patterns work.

**Gateway side:** new `user.preferences.patch` handler in the session-handler set. Validates payload against shared zod schema. Calls `preferenceManager.update(patch)`. No profile write — the browser already did that via the REST route. No side-effects beyond the preference update — the entry gate naturally picks up the new value on the next cycle.

### Observability — model-driven flips visible to UI

`PreferenceManager.onChange` already exists. Wire a gateway → SDK push: when prefs change server-side (model called `update_user_settings`), emit `{type: "session.preferences.changed", payload: SessionPreferences}` over WS.

SDK exposes a new signal `client.preferences` (mirrors current session prefs). Browser button reads `client.preferences.value.ttsEnabled` instead of a local-only signal. Same signal also drives optimistic-revert on PUT failure (the authoritative state from the server wins).

### Shared validation

Move the audio schema and the `update_user_settings` arg schema into `shared/` (or wherever the project keeps cross-process zod schemas — confirm during plan). One schema source for: profile validator, MCP tool input, WS preference patch. Avoids the three forms drifting.

### Migration

- Existing `profile.json` files lack `audio`. Zod `.default()` seeds `{ttsEnabled: true, channel: "voice"}` on read. No migration script, no schema-version bump.
- `set_channel` deleted in the same commit. The model's tool catalog regenerates per conversation; loss of `set_channel` references is acceptable. Mention the rename in commit body.
- Settings page gets an "Audio" pane in the same PR that mirrors the two new fields. Keeps button + settings consistent from day one.

## Smoke matrix

Driven by the agent via Playwright MCP against the local Docker stack (`deploy/macos/`). No Fish Audio key → verify the **gate**, not audio output.

Verification surfaces:
- **Browser:** button icon, network tab (PUT `/profile/me` status), WS frames (`user.preferences.patch`, `session.preferences.changed`), console.
- **Container:** `docker exec ... cat ~/.sentient/profiles/<userId>/profile.json` for persistence; `gateway/logs/YYYY-MM-DD.log` for gate-decision lines.
- **Existing log lines reused:** `preferences-init`, `preferences-changed`, `tts.start`, `tts.skip.channel-text` (mid-stream variant — kept as-is).
- **New log lines added by this work:**
  - `tts.skip.audio-prefs` (INFO) at the **entry gate only**. Fields: `when: "startTts-entry"`, `reason: "channel-text" | "tts-disabled"`, plus `channel`, `ttsEnabled`, `sessionId`, `cycleId`. Replaces the existing entry-gate `tts.skip.channel-text` line.

| # | Case | Verify (no audio output asserted) |
|---|------|-----------------------------------|
| 1 | Click TTS on→off **before** sending turn, voice mode active, then send | Icon = `volume-x`. PUT 200. WS preference patch sent. Send turn. Container log: `tts.skip.audio-prefs when=startTts-entry reason=tts-disabled` for that cycle. `profile.json` on disk: `audio.ttsEnabled=false`. NO `tts.start` for that cycle. |
| 2 | Click off→on, send turn | Icon `volume-2`. Log: `tts.start` for cycle (Fish call then fails without key — irrelevant; gate-passed is the assert). |
| 3 | **Next-cycle gating via MCP tool** — start a long turn, model calls `update_user_settings({ttsEnabled:false})` partway through assistant streaming | Logs in order: `tts.start` for current cycle → cycle continues to completion (audio frames keep flowing — current cycle unaffected) → `preferences-changed`. Button icon flips without click (browser received `session.preferences.changed`). Send a SECOND turn → log `tts.skip.audio-prefs when=startTts-entry reason=tts-disabled`. |
| 4 | **Next-cycle gating via UI button** — same as #3 but UI button instead of MCP tool | Same log sequence: current cycle finishes naturally; next cycle gated. Asserts UI button + MCP tool both funnel through `preferenceManager.update`. |
| 5 | Toggle TTS while mic off (text-only mode, no active cycle) | PUT persists. `profile.json` updated. Button functional. |
| 6 | Reconnect (close + reopen WS) | New session log: `preferences-init channel=… ttsEnabled=…` seeded from profile. Button reflects seeded state. |
| 7 | PUT fails (force 500 by killing profile route) | Browser: optimistic revert + toast. WS preference patch NOT sent (bail before WS step). `profile.json` unchanged. No log changes server-side. |
| 8 | Visual: desktop 1280×900 + mobile 390×844 | Both buttons fit; 44px touch targets; no overflow on either viewport. Screenshots saved under `.playwright-mcp/tts-button-{desktop,mobile}.png`. |
| 9 | Settings page Audio pane two-way sync | Toggle in settings → button updates. Toggle button → settings updates. Both write the same profile field. |

iOS Safari real-device behavior — flagged for operator follow-up. Out of agent scope.

## Open questions

**Q1 — Voice / model hot-swap.** When the model calls `update_user_settings({voice})` mid-session, does the change take effect on the next TTS call in the current session, or only on the next session? Mid-session swap means the TTS pipeline needs to handle a voice-id change between cycles. **Recommendation for v1:** disallow `voice`/`model` hot-swap — persist to profile only, apply on next session. Document in tool description. Revisit when the user cares.

**Q2 — Tool discoverability.** The model previously had `set_channel` as a discrete, easy-to-find action. Folding it into `update_user_settings` may make the model less likely to use it spontaneously. Mitigate via a clear tool description that lists all settable fields and a few example invocations. Re-evaluate after a week of real use.

**Q3 — Settings-page mirror.** Build the Audio pane as part of this PR (recommended), or land button + tool first and add the pane in a follow-up? PR scope: small enough to keep together; the pane is a thin two-toggle wrapper using existing settings primitives.

## Files touched

**Gateway (TS):**
- `gateway/src/profile-store/profile-types.ts` — add `audio` to schema with default
- `gateway/src/cerebrum/preferences.ts` — add `ttsEnabled` to `SessionPreferences` + patch
- `gateway/src/session-handlers/ws-session-configure.ts` — seed prefs from profile, extend the entry gate (line 318) to also check `ttsEnabled`, swap entry-gate skip log to `tts.skip.audio-prefs` with `reason` field. Mid-stream `gateByChannel` untouched. Update the existing `set_channel`-referring comment to mention `update_user_settings`.
- `gateway/src/session-handlers/` — new `user.preferences.patch` handler, gateway → SDK push for `session.preferences.changed`
- `gateway/src/mcp-host/tools/update-user-settings.ts` — new file
- `gateway/src/mcp-host/tools/set-channel.ts` — delete
- `gateway/src/mcp-host/tools/set-channel.test.ts` — delete
- `gateway/src/mcp-host/tools/update-user-settings.test.ts` — new file (defensive coverage of validation + persistence + session sync)
- MCP server registration site — swap `createSetChannelTool` → `createUpdateUserSettingsTool`

**Web UI:**
- `gateway/webui/src/components/dock/tts-button.tsx` — new
- `gateway/webui/src/components/dock/composer.tsx` — slot in TTS button
- `gateway/webui/src/components/common/icons/volume-2.tsx` — new
- `gateway/webui/src/components/common/icons/volume-x.tsx` — new
- `gateway/webui/src/components/common/icon.tsx` — register two new icons
- `gateway/webui/src/services/profile-api.ts` — extend `ProfileV1` to mirror gateway change
- `gateway/webui/src/components/settings/panes/audio-pane.tsx` — new (small)
- `gateway/webui/src/components/settings/settings-view.tsx` — register Audio tab
- `gateway/webui/src/app.tsx` — wire button to client preference signal + PUT/WS path

**Web SDK:**
- expose `client.preferences` signal, `client.patchPreferences(patch)` method, handler for `session.preferences.changed` inbound frame
- handler for outbound `user.preferences.patch` frame

**Shared:**
- `shared/` (or chosen location) — single zod schema for audio fields, used by profile validator + MCP tool input + WS patch validator

**CSS:**
- composer bottom-row gap tweak for narrow viewport
- `.icon-button--tts-on` / `--tts-off` variants alongside existing `--mic-on` / `--mic-off`

## Smoke run 2026-05-08

**Driver:** Playwright MCP against local Docker stack (`deploy/macos/docker-compose.yml`), profile `u_8c866990` (Kevin), Fish Audio key intentionally absent — TTS dispatch verified at the gate via logs, no audio output asserted.

**Stack startup note:** initial bring-up failed because `~/.sentient/run/sentient/mcp-u_8c866990.sock` was a leftover from a previous run on the virtiofs bind mount; `unlinkSync` in `unix-socket-listener.ts` could not clear it cleanly so `Bun.listen` errored with `ENOTSUP`. Removing the stale socket and restarting let the gateway come up healthy. Worth a tiny defensive log + retry in the listener if that path ever leaves a leftover under operator-visible conditions.

**Overall: 8 of 9 cases green, 1 FAIL with a real PR-level bug found.**

| # | Case | Result | Evidence | Log line(s) |
|---|------|--------|----------|-------------|
| 1 | Click TTS on→off, send turn | ✅ PASS | `.playwright-mcp/tts-button-case-1-desktop.png` | `tts.skip.audio-prefs sessionId="s-moxgi9gl-qpgru9f8" cycleId="cycle-1" when="startTts-entry" reason="tts-disabled" channel="voice" ttsEnabled=false` — no `tts.start` for that cycle. PUT 200, WS TX `user.preferences.patch {ttsEnabled:false}`, WS RX `session.preferences.changed`, `profile.json#audio.ttsEnabled=false`. |
| 2 | Toggle off→on, send turn | ✅ PASS | `.playwright-mcp/tts-button-case-2-desktop.png` | `tts.start sessionId="s-moxgi9gl-qpgru9f8" cycleId="cycle-2"` — gate passed. Fish drain WARN expected with no key. |
| 3 | Mid-cycle MCP flip via `update_user_settings` | ❌ FAIL | n/a — see bug below | Model never reached `update_user_settings`. Attempted bash terminal, search, list_resources, etc. and finally responded "I'm sorry, I don't see a tool called `update_user_settings` in my current system." Hermes log: `MCP server 'gateway' (stdio): registered 7 tool(s): mcp_gateway_identify_user, mcp_gateway_pause_audio, mcp_gateway_resume_audio, mcp_gateway_list_resources, mcp_gateway_read_resource, mcp_gateway_list_prompts, mcp_gateway_get_prompt` — `update_user_settings` is **missing from the wire-level catalog Hermes sees**. |
| 4 | Mid-cycle UI button flip | ✅ PASS | `.playwright-mcp/tts-button-case-4-desktop.png` | Cycle-4 ran to completion (`done sawError=false`); button click during the tail produced `preferences-changed`; next turn (`cycle-5`) gated: `tts.skip.audio-prefs ... reason=tts-disabled`. |
| 5 | Toggle TTS while mic off (text mode) | ✅ PASS | `.playwright-mcp/tts-button-case-5-desktop.png` | `preferences-changed changed=ttsEnabled` fired; WS TX `user.preferences.patch {ttsEnabled:true}`; profile.json reflects `audio.ttsEnabled=true`. |
| 6 | Reconnect (close + reopen WS) | ✅ PASS | `.playwright-mcp/tts-button-case-6-desktop.png` | New session `s-moxgr9wc-fqr2922k`: `preferences-init language="en" channel="voice" ttsEnabled=true` seeded from profile; button rendered "Mute assistant voice" (TTS on), matching seeded state. |
| 7 | PUT fails (forced 500 via Playwright route) | ✅ PASS | `.playwright-mcp/tts-button-case-7-desktop.png` | Browser optimistic revert (button stayed on "Mute"), toast surfaced ("Couldn't update voice setting. Please try again."), WS preference patch NOT sent (delta = 0), profile.json unchanged on disk. |
| 8 | Visual desktop 1280×900 + mobile 390×844 | ✅ PASS (with note) | `.playwright-mcp/tts-button-case-8-desktop.png`, `tts-button-case-8-mobile.png` | Desktop: mic at x=295, tts at x=335, both 32×32, no overflow. Mobile: mic at x=21, tts at x=59, both 32×32, no overflow. **Note**: spec text mentioned "44×44 touch targets" but the new TtsButton matches the existing MicButton size (32×32). Consistent with current UI pattern, not a regression — but if 44px was a hard requirement, it's not yet met. |
| 9 | Settings Audio pane two-way sync | ✅ PASS | `.playwright-mcp/tts-button-case-9-desktop.png` | Settings toggle → Apply → WS TX `user.preferences.patch {ttsEnabled:false,channel:"voice"}`, profile updated, `preferences-changed` fired. Reverse direction: clicked composer TTS button (Unmute → Mute), reopened settings Audio pane, toggle reflects `aria-pressed="true"`. Both surfaces write the same `profile.audio` field. |

**Mobile re-runs (390×844):**
- Case 1 mobile: ✅ PASS — `tts.skip.audio-prefs sessionId="s-moxgugz7-n7mimhyb" cycleId="cycle-1" reason="tts-disabled"` (`tts-button-case-1-mobile.png`).
- Case 2 mobile: ✅ PASS — `tts.start sessionId="s-moxgugz7-n7mimhyb" cycleId="cycle-2"` (`tts-button-case-2-mobile.png`).

**Case 3 follow-up (after fix ddf15a3):** ✅ PASS — model successfully calls update_user_settings, button flips, log emits preferences-changed. Evidence: .playwright-mcp/tts-button-case-3-rerun.png

### Bug found — `update_user_settings` invisible to the model

Root cause is in `gateway/config.yaml#mcp_catalog.gateway.tools.include` (around line 414):

```yaml
gateway:
  ...
  tools:
    include:
      - identify_user
      - pause_audio
      - resume_audio
      - set_channel       # <-- still here, but tool was deleted
                          # <-- update_user_settings missing
```

The gateway's MCP host correctly registers four tool handlers including `update_user_settings` (verified via `bootstrap:mcp-host mcp-host-created users=u_8c866990 toolCount=4`). But the per-user Hermes profile config at `~/.sentient/gateway/data/u_8c866990/profiles/u_8c866990/config.yaml` is rendered from this catalog and inherits the include allow-list — so Hermes only ever requests + advertises `identify_user, pause_audio, resume_audio` from the gateway MCP server. `set_channel` silently no-ops (handler removed); `update_user_settings` is filtered out before Hermes ever sees it.

Fix: replace `set_channel` with `update_user_settings` in `gateway/config.yaml#mcp_catalog.gateway.tools.include`. May also want a defensive check at boot time that every `include`-d tool name actually resolves to a registered handler (warn on mismatch).

This bug blocks the spec's "model-driven `update_user_settings` flow" entirely — the new tool is functionally unreachable in production.

### Polish notes (non-blocking)

1. `[cerebrum:hermes-dispatcher] dispatch.begin` logs a `ttsEnabled` field whose value is `deps.startTts !== undefined` (i.e. "is TTS wired into this dispatcher" — always `true` when the TTS service is configured), not the user's preference. The same line ran with the user's `ttsEnabled=false` set, but this field still printed `true`. Misleading at a glance during log-grepping. Consider renaming to `hasTtsBinding` or removing.
2. Case 7 produced two identical "Couldn't update voice setting. Please try again." toasts on a single click. Optimistic-revert path likely surfaces twice; one would be enough.
3. The `chmod-failed` warning on `/run/sentient/mcp-{userId}.sock` (EINVAL on virtiofs) is benign on macOS — pre-existing, not introduced by this PR.

### Out of agent scope

- iOS Safari real-device testing — flagged for operator follow-up per `.claude/rules/e2e-testing.md`.
- Pi / production smoke — host-only verification reserved for operator.
