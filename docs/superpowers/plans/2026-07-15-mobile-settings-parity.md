# Mobile Settings Parity — webui-level configuration on Android + iOS

Branch: `feature/mobile-settings-parity` (off develop @ 2026-07-15)

## Goal

Give the mobile apps the same configuration surface the webui settings has, via the existing
REST endpoints, using leveled navigation (root category list → per-category detail pages),
while keeping logout, app-update, and diagnostics — redesigned per below. UI is **native per
platform** (Compose / SwiftUI); only data layer (REST clients, repos, usecases) is shared KMP.
Design language: existing `DesignTokens.kt` (webui-transcribed) tokens on both platforms.

## Non-goals / deferred (flagged)

- ~~Signal deep-link instead of QR~~ **superseded by evidence**: the gateway wire exposes ONLY
  `qrDataUrl` (PNG data-URL) — no raw `tsdevice:` URI exists client-side, and Signal linking
  requires the primary device to scan. Both platforms render the QR natively with a
  "scan from Signal on another device" note (webui parity).
- **Get-the-app pane** — dropped on mobile (meaningless on device).
- Webui visual Apply-bar (cross-tab op coalescing) — mobile uses per-page save (below).

## UX design

### Root settings page (replaces current thin v1)

```
◄ Settings
  ── Soul ──────────────────
  [brain]     Memory            ›
  [drama]     Personalities     ›
  [waveform]  Voice             ›
  [volume-2]  Audio             ›
  [cpu]       Model             ›
  [wrench]    Tools             ›
  [book-open] System Prompt     ›
  [sliders-h] Advanced          ›
  ── User ──────────────────
  [user-circle] Account         ›
  [phone]       Devices         ›
  ── Admin ───────────────── (only when me.isAdmin)
  [users-group] Members         ›
  [key]         Secrets         ›
  ── Support ───────────────
  [life-buoy/heart-pulse] Diagnostics   ›
  ─────────────────────────
  [ Log out ]                      ← danger row
  ─────────────────────────
        (footer, centered)
  [ Check for updates ]            ← state-morphing button (below)
  Sentient 0.1.7 (108)             ← version caption, very bottom
```

- Titles + grouping copied from webui `nav-config.ts` (Soul/User/Admin). Canonical strings:
  sidebar labels win ("System Prompt", "Secrets") — do NOT copy the pane-title variants
  ("Persona", "Provider keys").
- Icons: Android transcribes the webui SVGs (`webui/src/components/common/icons/*.tsx`) to
  Compose `ImageVector`s; iOS uses nearest SF Symbols (native convention): brain,
  theatermasks, waveform, speaker.wave.2, cpu, wrench, book, slider.horizontal.3,
  person.circle, iphone, person.3, key, waveform.path.ecg (Diagnostics).
- **Update footer (redesign of check-update/version/download mess):** ONE control that
  morphs in place, plus a version caption:
  - idle → `Check for updates` (quiet/tonal button)
  - checking → spinner + `Checking…` (disabled)
  - up-to-date → `✓ Up to date` (transient ~3s, then back to idle)
  - available → `Update to v0.2.0` (primary/filled button; tap = existing installer flow)
  - failed → `Check failed — Retry`
  - Backed by the existing process-wide `UpdateViewModel` / `UpdateModel` (same instance the
    force-gate + banner use). Mandatory updates still handled by the existing force-gate,
    NOT by this footer.
  - Version caption reads BuildConfig / CFBundle exactly as today, moved to page bottom.
- **Diagnostics** becomes a category page (Support group): description copy + the existing
  session list (select → send → progress → sent/retry morph rows) moved off the root page.
- **Logout** stays a root-level danger row (current behavior). Account page carries identity
  (display name) + PIN change only — no duplicate sign-out.

### Category pages (parity with webui panes)

| Page | Controls (native equivalents) | Endpoints |
|---|---|---|
| Memory | slot segmented (MEMORY.md/USER.md), edit/preview toggle, plain editor + server `charLimit` cap, char counter | GET/PUT `/profile/memory/{memory,user}` |
| Personalities | list of expandable cards; activate / delete / create(name+instructions) | GET/POST/PUT/DELETE `/profile/personalities…`, POST `/profile/active-personality` |
| Voice | filter (search/tags/language), pack grid/list, play preview, pick active, delete, **Add Voice** (record WAV in-app OR pick audio file; name/description/tags/language form; multipart create), **Clone from Fish** (gated on `features.fish_browse_enabled`: browse/search Fish library, play sample, one-tap clone; FeatureDisabled → entry hidden) | GET/POST/DELETE `/voices`, POST `/voices/:id/preview`, active = profile.voice via PUT `/profile/me`; Fish: GET `/providers/voices[?search…]`, GET `/providers/voices/:id`, POST `/providers/voices/:fishId/clone`; flag via GET `/services/versions` |
| Audio | "Speak responses (TTS)" toggle, "Reply channel" segmented voice/text | PUT `/profile/me` (audio) + live `PreferencesConnector.patch` |
| Model | provider segmented, model search, model card list (single-select) | GET `/providers/models`, PUT `/profile/me` (model) |
| Tools | per-MCP-server toggle + per-tool toggles, Hermes built-in toolset toggles | GET `/mcp-catalog`, PUT `/profile/me` (tools) |
| System Prompt | edit/preview toggle, mono editor, restore-default (confirm dialog) | GET/PUT `/profile/soul`, GET `/profile/soul/default` |
| Advanced | Reasoning select (none…xhigh), Compression slider 0–1/0.05, Max tokens slider 128–8192/128, Prompt-injection editor | PUT `/profile/me` (advanced/compression) |
| Account | display name field + save, change-PIN dialog (current+new 4-digit) | PUT `/auth/me`, PUT `/auth/me/pin` |
| Devices | Signal card: linked → account+date+Unlink(confirm); unlinked → Link (deep-link button + copy URI + status poll + cancel) | GET `/devices`, POST `/devices/signal/link|cancel|unlink`, GET `…/link/status` |
| Members (admin) | member list, promote/demote, delete(confirm), add user (name+PIN wizard, 3-user cap) | GET/POST/PATCH/DELETE `/admin/users…` |
| Secrets (admin) | per-provider masked key rows, update key, set active, custom base-URL row | GET/PUT `/admin/secrets…` |
| Diagnostics | existing vitals session list, moved to own page | POST `/diagnostics/logs` (existing VitalsUploader) |

### Save semantics (mobile deviation from webui Apply bar — deliberate)

- **Per-page draft + Save.** Each editing page keeps `original` + `draft` locally; Save appears
  in page top bar when dirty (derived by diff, not a stored flag). Back with dirty draft →
  discard confirm.
- **Fast save** (Audio): PUT profile, then live WS patch (`PreferencesConnector.patch`) so the
  running session updates instantly; no restart.
- **Slow save** (Model, Tools, Advanced, System Prompt, Memory, Personalities mutations):
  PUT/POST then `POST /profile/apply` → blocking in-page progress ("Applying — assistant
  restarting…", per-user 429 handled as "already applying"), then re-fetch server truth into
  original+draft (webui semantics: trust post-restart state, not the submitted draft).
- **Imperative ops** (Voice pick/delete, Account, Devices, Members, Secrets): immediate call +
  result toast/inline state, mirroring webui.

## Architecture (per rules)

### shared/mobile-sdk (commonMain, pure)

New `settings/` REST clients, exact `SessionsHttpClient` shape (inject `HttpClient`,
`gatewayWsUrl`, `token: () -> String`; derive base URL via existing helper; bearer per call;
result types never throw across boundary):

- `ProfileHttpClient` — getMe/updateMe (`ProfileV1`), apply, soul get/put/default,
  memory get/put per slot, personalities CRUD + activate, mcpCatalog.
- `VoicesHttpClient` — list, delete, preview (returns wav `ByteArray`).
- `ProvidersHttpClient` — models catalog.
- `DevicesHttpClient` — devices get, signal link/cancel/status/unlink.
- `AdminHttpClient` — users list/create/patch/delete, secrets get/put/active.
- `AuthClient` additions — `updateMe(displayName)`, `changePin(current,new)`, `logout()`.
- Kotlin models mirror the gateway zod schemas **field-for-field** (read
  `gateway/src/api/handlers/*.ts` + `shared/` zod sources; wire-contract tests mock the exact
  server JSON, per testing rules).
- `/auth/me` must expose `isAdmin` for the Admin gate — verify gateway response; if absent,
  additive gateway change + webui-sdk cross-check per `web-sdk-mirror-contract`.

### shared/mobile-data

- `SettingsComponent` (connection scope, built on login beside `ChatComponent`): wires clients →
  stateless repos (interfaces + result envelopes) → usecases.
- Repos: `ProfileRepository`, `VoicesRepository`, `AccountRepository`, `DevicesRepository`,
  `AdminRepository` — pure mappers, no fold/merge.
- Usecases per screen concern: load/save profile sections, apply-with-restart FSM
  (idle→saving→restarting→ready|failed — the one real state machine, unit-tested), voices
  list/preview/pick, account ops, devices link poll loop, admin ops.

### Android

- Routes: `settings` root + `settings/{memory,personalities,voice,audio,model,tools,
  system-prompt,advanced,account,devices,members,secrets,diagnostics}` — flat typed routes in
  `Routes.kt`, one `composable()` each, thin VM per route via Koin resolving usecases from the
  connection scope. Settings/Update VMs migrate OFF app singletons onto the usecase chain.
- Native components under `android/…/settings/components/`: CategoryRow, GroupHeader,
  SettingsCard, RowToggle, RowSlider, RowSegmented, RowSelect, MonoEditor, UpdateFooter,
  DangerButton. Tokens via `LocalTokens`; previews per rules.
- Icons: `android/…/settings/icons/` ImageVectors transcribed from webui SVGs.
- WAV preview playback: small `VoicePreviewPlayer` (MediaPlayer over temp file).
- Voice creation: `VoiceRecorder` (AudioRecord → 16-bit PCM mono WAV; mic permission at point
  of use) + SAF audio file picker; Add Voice screen = record/upload toggle, playback check,
  re-record, name/description/tags/language form (caps from mobile-sdk constants; language
  options = canonical Qwen list mirrored in mobile-sdk, flagged as mirror of
  `@sentient/config`), multipart submit with progress.

### iOS

- `Route` enum grows matching cases; `path.append(…)` from root list; per-screen `@MainActor`
  `@Observable` VMs over the same KMP usecases (SKIE bridging).
- Native components under `ios/App/Settings/Components/` mirroring the Android set as SwiftUI.
- SF Symbols per mapping above. WAV playback via `AVAudioPlayer(data:)`.
- Voice creation: `AVAudioRecorder` (LinearPCM WAV settings; mic permission at point of use) +
  `fileImporter` for audio files; same Add Voice flow as Android.
- Regenerate project via XcodeGen; never hand-edit pbxproj.

## Execution phases (subagent fan-out)

1. **P1a** mobile-sdk clients+models+tests (Opus) ∥ **P1b** Android components+icons (Sonnet)
   ∥ **P1c** iOS components (Sonnet).
2. **P2** mobile-data repos+usecases+DI + platform wiring stubs (Opus; after P1a).
3. **P3a** Android routes+root+footer+diagnostics-move (Opus), then **P3b/P3c** Android category
   pages split Soul / User+Admin (parallel, page-file-only edits). **P3d–f** iOS mirror same split.
4. **P4** builds green (gradle assembleDebug, xcodegen+xcodebuild), lint, unit tests, per-phase
   code review (two-stage: spec + quality).
5. **P5** e2e per matrix below (Sonnet agents; Maestro on emulator/simulator vs local stack).

## E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Root list renders groups | Pixel emu + iPhone sim | logged in | open Settings | Soul/User/Support groups; Admin only for admin user; version footer at bottom | settings route logged |
| Non-admin gate | both | non-admin login | open Settings | no Admin group | me.isAdmin=false logged |
| Audio fast save | both | TTS on | toggle TTS off → Save | Save appears on dirty, completes w/o restart UI, dock/session reflects | PUT profile 200 + prefs patch frame, no apply |
| Model slow save | both | model A active | pick model B → Save | "Applying — restarting…" progress → success, page shows B | PUT profile + POST apply 200, restart poll ok |
| Apply conflict | Android | apply in-flight (2nd device/web) | Save slow change | "already applying" surfaced, no crash | 429 apply-in-progress logged |
| Memory cap | both | — | type past charLimit | input capped, counter shows limit | GET memory returns charLimit |
| System Prompt restore default | both | edited soul | Restore default → confirm → Save | default text applied after restart | GET soul/default + PUT + apply |
| Voice preview+pick | both | ≥2 packs | play preview; pick other pack | audio audible; active badge moves | preview 200 wav bytes; PUT profile voice |
| Voice delete | both | deletable pack | delete → confirm | tile gone | DELETE 200 |
| Voice create via record | both | mic granted | Add Voice → record ~5s → play check → name+language → submit | progress → new pack in list | multipart POST 201, wav bytes logged size only |
| Voice create via upload | both | audio file on device | Add Voice → pick file → form → submit | new pack in list | multipart POST 201 |
| Voice create over-cap name | both | — | 100-char name | client-side cap blocks / inline error | no request or 422 logged |
| Voice create mic denied | both | mic denied | Add Voice → record | rationale + settings-bounce fallback, no crash | permission-denied logged |
| Fish clone happy | both | fish enabled + key | Clone from Fish → search → play sample → clone | progress → new pack in list (auto-active per server) | GET providers/voices 200; POST clone 200 |
| Fish gated off | both | fish disabled | open Voice page | no Fish entry visible | features.fish_browse_enabled=false logged |
| Fish upstream fail | both | fish enabled, bad key/offline | browse | inline error + retry, no crash | upstream-failed kind logged |
| Tools toggle | both | server enabled | disable one MCP server → Save | toggle persists after re-open | PUT profile tools + apply |
| Advanced sliders | both | defaults | set reasoning=high, threshold, maxTokens → Save | values persist | PUT profile advanced + apply |
| Personalities create+activate | both | 1 personality | create new → activate | active pill moves | POST + activate + apply |
| Account rename | both | name X | change display name → save | toast/inline success; new name in drawer header | PUT auth/me 200 |
| PIN change wrong current | both | — | change PIN w/ bad current | inline error, no lockout | 401/422 logged, no token drop |
| Devices unlink confirm | both | signal linked | Unlink → cancel, then confirm | cancel = no-op; confirm = unlinked state | POST unlink once |
| Members add (admin) | both | 2 users | add 3rd, then try 4th | 3rd created; add disabled at cap | POST 200; cap enforced |
| Secrets update key (admin) | both | key set | update key | masked row updates, never echoes key | PUT 200; no key in logs |
| Diagnostics page send | both | ≥1 vitals session | send log | progress → Sent ✓ | POST diagnostics/logs 200 ref |
| Update footer check | both | up-to-date manifest | tap Check for updates | Checking… → ✓ Up to date → idle | manifest GET logged |
| Update footer available | Android | manifest bumped | tap Check | button morphs to "Update to vX" | status Available logged |
| Update check offline | both | airplane mode | tap Check | "Check failed — Retry", app alive | CheckFailed reason logged |
| Logout | both | logged in | root Log out | back to login; token cleared | logout POST + token clear |
| Dirty-back discard | both | dirty Audio draft | back | discard confirm; discard restores | no PUT fired |
| Offline slow save | both | airplane mode | Save model change | failure surfaced inline, draft kept | envelope failure logged, no crash |
| Web settings regression | 1280×900 + 390×844 | — | webui settings smoke (existing) | unchanged behavior | no new WARN/ERROR |

Unreachable-in-CI flags: real Signal link completion (needs a Signal account) — smoke covers
link-start/cancel/status-poll only; iOS itms install completion (needs registered device).
