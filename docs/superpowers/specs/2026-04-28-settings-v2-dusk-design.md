---
title: Settings v2 — Dusk redesign (single-locked-theme adopt)
date: 2026-04-28
status: approved
branch: feature/settings-v2-dusk (worktree off develop)
---

# Settings v2 — Dusk redesign

## Summary

Adopt the v2 design from `sentient-webui-design-v2/` for the gateway
web client's settings page. Dusk is the single locked color theme for
the entire app; Filled bubbles, Comfortable density, Fraunces+DM font
pairing, Bars-only voice orb, and Default tool card complete the
six-token combo. Tokens land app-wide (chat included); component-level
v2 chrome (sidebar, panes, docked apply bar) lands on the settings
page only. The current `gateway/webui/src/components/settings/`
namespace is wiped and rebuilt in one PR.

## Goals

- Match v2 Dusk byte-for-byte for app-wide tokens (color, shadow,
  type, density, radius).
- Replace the current `SettingsTabs` top-row layout with v2's
  three-group sidebar (`Soul / User / Admin`) and pane-at-a-time main
  area.
- Unify the existing two-restart-flow model (Soul.md/personalities
  per-section save + restart, vs profile-fields apply-then-restart)
  into a single docked Apply bar that is visible only when active
  pane is in the Soul group AND has dirty fields.
- Drop placeholder tabs (Permissions, Voices, Sessions, Invites,
  System) whose functionality is either covered by v2 or not yet
  implemented.
- Build a `Provider keys` admin pane as a WIP placeholder (security
  implications deferred).
- Add a settings-specific QA charter and run `/qa-session web
  settings-page` as the final implementation step, fixing reported
  bugs before the branch is ready for user review.
- Run all implementation in an isolated git worktree on
  `feature/settings-v2-dusk` (branched off `develop`) — never modify
  `develop` directly.

## Non-goals

- No structural redesign of the chat surface — it inherits the new
  tokens but keeps existing layout.
- No backend changes for provider key reveal/rotate (write-only stays).
- No dynamic MCP server registration (`Add server` button hidden in
  v1; backend not built).
- No theme switcher / Tweaks UI — Dusk + Filled + Comfortable +
  Fraunces+DM + Bars + Default are hardcoded defaults; the v2 Tweaks
  panel was a designer-side comparison tool only.
- No voice-print enrollment beyond the existing placeholder
  (backend not built).
- No personality template library (current code has one default; the
  v2 "Template" Card on the Persona pane is a designer assumption that
  doesn't match reality, and is dropped).

## Reference visuals

All references live in
`sentient-webui-design-v2/screenshots/` (captured 2026-04-28 from
`Sentient.html` served via `python3 -m http.server`, viewport
1440×900, full-page PNG). Implementation must match these within
minor antialiasing tolerance.

| Pane / state | File |
|---|---|
| Chat (token-baseline) | `00-chat-reference.png` |
| Persona (Soul.md edit) | `01-settings-persona.png` |
| Persona (preview tab) | `01a-settings-persona-preview.png` |
| Personalities (collapsed) | `02-settings-personalities.png` |
| Personalities (expanded body) | `02a-settings-personalities-expanded.png` |
| Voice library | `03-settings-voice.png` |
| Model picker | `04-settings-model.png` |
| Tools (collapsed) | `05-settings-tools.png` |
| Tools (server expanded) | `05a-settings-tools-expanded.png` |
| Advanced | `06-settings-advanced.png` |
| Account | `07-settings-account.png` |
| Account PIN modal | `07a-settings-account-pin-modal.png` |
| Members | `08-settings-members.png` |
| Provider keys (WIP, future visual contract) | `09-settings-provider-keys.png` |
| Apply bar (dirty state) | `10-apply-bar-dirty.png` |

The v2 source files (`Sentient.html`, `chat_view.jsx`, `message.jsx`,
`settings_view.jsx`, `icons.jsx`, `styles.css`) are the canonical
reference for primitive shapes and CSS class names; the screenshots
above are the visual contract.

## Section 1 — Token deltas (app-wide)

App-wide token corrections so the entire UI runs Dusk + Fraunces+DM.

### Files & changes

- `gateway/webui/index.html`
  - Add Google Fonts `<link>` for **Fraunces** (opsz,wght@9..144,
    400;500;600), **DM Sans** (400;500;600;700), **JetBrains Mono**
    (already present).
  - Remove Inter / Instrument Serif imports if present.

- `gateway/webui/src/styles/tokens/typography.css`
  - `--font-display: "Fraunces", "Cormorant Garamond", Georgia, serif;`
  - `--font-ui: "DM Sans", "Inter", system-ui, -apple-system, sans-serif;`
  - `--font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;`
  - Keep size/line-height scale unchanged.

- `gateway/webui/src/styles/tokens/colors.css`
  - Audit pass — values should already match v2 Dusk byte-for-byte.
    Confirm and correct any drift.

- `gateway/webui/src/styles/tokens/shadows.css`
  - Audit pass — three tokens should match v2 Dusk shadow set
    (terra glow on `--shadow-2`).

- `gateway/webui/src/styles/tokens/spacing.css`
  - Add density tokens for the locked Comfortable combo:
    `--pad-msg: 18px; --gap-msg: 32px; --msg-max: 720px;`
  - No `[data-density]` selectors — single combo only.

- `gateway/webui/src/styles/tokens/radius.css`
  - Audit pass — `--r-sm: 8px; --r-md: 12px; --r-lg: 18px;
    --r-xl: 26px; --r-pill: 999px;`

### Verification

Eyeball `00-chat-reference.png` against the rendered chat after
fonts swap. Bubble corner radii, accent color, ink text, and shadow
hue must match.

## Section 2 — Settings shell architecture

### Layout

```
gateway/webui/src/components/settings/
├── settings-view.tsx              -- top container; owns `tab` + `dirty` map
├── settings-shell.css             -- .settings-v2 grid (sidebar | main | apply-bar)
│
├── sidebar/
│   ├── sidebar-nav.tsx            -- pure; renders NAV constant
│   ├── sidebar-status.tsx         -- bottom "Healthy · N MCP connected"
│   └── nav-config.ts              -- Soul / User / Admin groups + SOUL_KEYS set
│
├── apply-bar/
│   ├── apply-bar.tsx              -- docked; visible IFF Soul tab + dirtyCount > 0
│   ├── apply-bar-machine.ts       -- ported FSM (see Section 5)
│   └── apply-bar.css
│
├── primitives/                    -- ports of v2 settings_view.jsx primitives
│   ├── card.tsx                   -- <Card title sub action padding>
│   ├── row.tsx                    -- <Row label hint dirty vertical>
│   ├── text-field.tsx             -- prefix/suffix/monospace/full
│   ├── textarea.tsx               -- monospace/dirty
│   ├── select.tsx                 -- custom dropdown (icon/tag/check)
│   ├── toggle.tsx                 -- aria-pressed switch
│   ├── segmented.tsx              -- pill seg control
│   ├── slider.tsx                 -- range with formatted value
│   ├── chip.tsx                   -- on/off pill
│   ├── search-field.tsx           -- icon + input
│   ├── btn.tsx                    -- kind: primary|secondary|ghost; size: sm|md; danger; on-dark
│   ├── modal.tsx                  -- centered overlay + scrim + Esc close
│   ├── pin-input.tsx              -- 4-box numeric password
│   ├── pane-head.tsx              -- <PaneHead title sub action>
│   ├── wip-badge.tsx              -- restyled from existing
│   └── primitives.css
│
└── panes/
    ├── persona-pane.tsx           -- Soul.md (replaces SoulSection + PersonaSection)
    ├── personalities-pane.tsx     -- inline expand/edit (port from PersonalitySection + PersonalityEditor)
    ├── voice-pane.tsx             -- voice library grid + filter + paginate
    ├── model-pane.tsx             -- provider segmented + model card list
    ├── tools-pane.tsx             -- MCP server list + per-tool toggle
    ├── advanced-pane.tsx          -- compression slider + max tokens + injection
    ├── account-pane.tsx           -- identity / security / session
    ├── members-pane.tsx           -- member list + invite + delete
    ├── provider-keys-pane.tsx     -- WIP placeholder
    └── panes.css
```

### State ownership

- `SettingsView` owns:
  - `tab: SidebarKey` — which pane is active
  - `dirty: Record<DirtyKey, boolean>` — which fields have unsaved changes
- Each pane container receives `mark(key)` and reads its own dirty
  slice. Containers own their data fetching via existing API clients.
- Primitives are pure / presentational.

### Apply-bar visibility contract

```
apply-bar visible IFF:
  SOUL_KEYS.has(tab) AND Object.values(dirty).filter(Boolean).length > 0
```

The bar must NOT appear on Account, Members, or Provider keys panes
regardless of dirty state. (Encoded as the
`settings.apply-bar-only-when-dirty` oracle in Section 6.)

### Apply-bar smart label (B1 unified)

Extends `apply-machine.ts` to track op kind:

- Only fast ops dirty (e.g. just personality activate) →
  button reads **"Apply"**, no spinner cycle.
- Any slow op dirty (Soul.md, personality save/create/delete, voice,
  model, tools, advanced) → button reads **"Apply & Restart"**,
  spinner cycle runs after click.

## Section 3 — Per-pane data flow & restart classification

| Pane | Data source | Dirty key shape | Restart? | Reference | Notable interactions |
|---|---|---|---|---|---|
| **Persona** (Soul.md) | `profileApi.getSoul`, `putSoul`, `getSoulDefault` | `persona.soul` | yes | `01-settings-persona.png`, `01a-…-preview.png` | textarea edit, Edit/Preview seg, Restore default |
| **Personalities** | `profileApi.getPersonalities`, `postActivePersonality`, `putPersonality`, `postPersonality`, `deletePersonality` | `personalities.active`, `personalities.<name>`, `personalities.new` | activate-only = **no**; edit/create/delete = **yes** | `02-…`, `02a-…-expanded.png` | inline row expand, Activate, Delete (confirm), New (inline form), body textarea edit |
| **Voice** | `providersApi.listVoices`, `profile.voice` | `profile.voice` | yes | `03-settings-voice.png` | search, lang chips, paginate, select tile, play preview (only if `previewAudioUrl`) |
| **Model** | `providersApi.listModels`, `profile.model.id`, `profile.model.provider` | `profile.model` | yes | `04-settings-model.png` | provider segmented, search, click card |
| **Tools** | `profile.tools` | `profile.tools.<server>`, `profile.tools.<server>.<tool>` | yes | `05-…`, `05a-…-expanded.png` | row expand, server toggle, per-tool toggle. **Add server hidden in v1** (no backend). |
| **Advanced** | `profile.compression`, `profile.advanced.maxTokens`, `profile.advanced.systemPromptInjection` | `profile.compression`, `profile.advanced.maxTokens`, `profile.advanced.injection` | yes | `06-settings-advanced.png` | sliders, prompt-injection textarea |
| **Account** (User group) | `authApi.updateMe`, `authApi.changePin` | per-card local (no apply bar) | no | `07-…`, `07a-…-pin-modal.png` | display name save, Change PIN modal, Re-enroll (WIP), Log out |
| **Members** (Admin group) | `adminApi.listUsers`, `createUser`, `deleteUser`, `setIsAdmin`, `resetPin` | per-row immediate (no apply bar) | yes for create/delete (uses `<SpinnerOverlay>`) | `08-settings-members.png` | row kebab, invite, delete-confirm modal |
| **Provider keys** (Admin, **WIP**) | none | n/a | n/a | `09-settings-provider-keys.png` | WIP badge + placeholder copy only |

### Persona — Template Card removed

The v2 design's "Template" Card with a `warm-domestic-v3` selector
implies a template library (multiple templates pickable). Current
backend has one default Soul.md retrieved via `getSoulDefault`. Spec
drops the Template Card entirely. Pane shows only the Soul.md
textarea + Edit/Preview seg + Restore default action. Same correction
philosophy as relabeling "System prompt" → "Soul.md".

### Tools — Add server button hidden in v1

`gateway/config.yaml#mcp_catalog` is operator-managed YAML
(see root CLAUDE.md). No runtime server-add API exists. The v2 "Add
server" button is hidden in v1 and will be enabled when an admin
endpoint lands.

## Section 4 — Content adaptations

Most user-facing content is wired to real APIs. Placeholders only
matter where v2 hardcoded fictional Chen-family names. Family pattern
follows existing `householdName="My Home"` and `USER_NAME="Kevin"`.

- **Topbar** (`shell/topbar.tsx`)
  - `householdName="My Home"` — already correct.
  - Crumbs `Conversation` / `Household` — adopt v2.
  - Status chip `"14 devices online"` — **drop** (no live device
    count). Surface only when a backend signal exists.

- **Sidebar header**
  - `Sentient Gateway` — hardcoded.
  - `Hermes <code>v0.x</code>` — Hermes is a separate runtime
    (`sentient-hermes` package), so its version is not in the
    gateway's `package.json`. Hardcode `v0.x` placeholder for v1.
    Listed under Open follow-ups: surface real version via a
    `/api/v1/version` endpoint that proxies through to Hermes.
  - Bottom status `Healthy · N MCP connected` — N from
    `profile.tools` enabled-server count; "Healthy" hardcoded.

- **Persona pane** — Soul.md content from backend; default template
  owned by ops, not by this redesign.

- **Personalities pane** — real list from `getPersonalities`.

- **Account pane** — real `auth.user.displayName`. Voice-print
  Re-enroll button **disabled** with tooltip `"Voice print enrollment
  coming soon"` (backend not built).

- **Members pane** — real users from `adminApi.listUsers`. Drop the
  `household-fixtures.ts` mock data.
  `member-add-form.tsx` placeholder `"e.g. Jordan"` — keep.

- **Voice pane** — real voices from `providersApi.listVoices`. Lang
  filter chips hardcoded as `["all", "en-US", "en-GB", "ja-JP",
  "zh-CN", "es-ES"]` (Fish Audio supported locales).

- **Model pane** — real models from `providersApi.listModels`.
  Provider segmented matches `provider` field on entries.

- **Tools pane** — real MCP server list from `profile.tools` /
  `mcp_catalog`. Drop v2's mock six servers.

- **Provider keys pane (WIP)**
  - Placeholder copy verbatim:
    > *"Provider keys management is coming. For now, an admin sets
    > keys server-side via the gateway environment. We'll surface
    > rotation, revocation, and audit here once the backend supports
    > it safely."*
  - WIP badge top-right of pane.

## Section 5 — Cleanup, migration order, CSS strategy

### Files to delete

```
gateway/webui/src/components/settings/
  invites-panel.tsx                  ✗
  permission-grid.tsx                ✗
  permissions-panel.tsx              ✗
  session-row.tsx                    ✗
  sessions-panel.tsx                 ✗
  voices-panel.tsx                   ✗
  system-panel.tsx                   ✗ (replaced by provider-keys-pane WIP)
  settings-tabs.tsx                  ✗ (replaced by sidebar-nav)
  my-agent-tab.tsx                   ✗
  my-account-tab.tsx                 ✗
  members-panel.tsx                  ✗
  member-add-form.tsx                ✗ (folds into members-pane)
  member-delete-modal.tsx            ✗
  member-row.tsx                     ✗
  wip-badge.tsx                      → moved to primitives/wip-badge.tsx
  my-agent/                          ✗ (entire dir; logic ports to apply-bar/ + panes/)
gateway/webui/src/data/household-fixtures.ts   ✗
```

### Files to keep unchanged

- `services/profile-api.ts`, `auth-api.ts`, `admin-api.ts`,
  `providers-api.ts`, `_helpers.ts`
- `hooks/use-auth.tsx`, `use-toast.tsx`
- `components/restart-spinner.tsx` (used internally by apply-bar)

### Logic ports (port the FSM, restyle the chrome)

- `my-agent/apply-machine.ts` → `apply-bar/apply-bar-machine.ts`,
  extended for Soul.md PUT, personality save/create/delete, plus
  smart-label classification (fast vs slow ops).
- `my-agent/dirty-state.ts` → folded into `settings-view.tsx` local
  state with extended dirty-key shape.
- `my-agent/apply-footer.tsx` → `apply-bar/apply-bar.tsx` with v2
  styling per `10-apply-bar-dirty.png`.
- `my-agent/apply-footer.test.tsx` → port to
  `apply-bar/apply-bar-machine.test.ts`. Test the FSM (state
  transitions, classification, smart label), not the chrome.

### CSS strategy

- `tokens/*.css` — values edited in place per Section 1. No file
  moves.
- `styles/components.css` (current 2494 lines) — strip every selector
  related to settings: `.settings`, `.settings-tabs`,
  `.settings-panel`, `.my-agent`, `.member-list`, `.system-panel`,
  `.account-section`, `.permission-grid`, `.soul-section`,
  `.personality-section`, `.voice-section`, `.model-section`,
  `.tools-section`, `.advanced-section`, plus their modifiers. Chat
  / dock / topbar / auth selectors remain.
- New settings CSS lives colocated under
  `components/settings/**/*.css`, namespaced under `.settings-v2` to
  avoid collision during the rewrite. Imports wired in `main.tsx`.

### Migration order within the PR

```
1. Token edits (typography, spacing density) + index.html font imports.
2. Build primitives/ (15 components, pure, no data).
3. Build apply-bar/ (port apply-machine.ts, extend, restyle).
4. Build sidebar/ (nav-config.ts, sidebar-nav.tsx, sidebar-status.tsx).
5. Build panes/ in order:
     persona → personalities → voice → model → tools → advanced
     → account → members → provider-keys.
6. Wire new settings-view.tsx (replaces current).
7. Delete old files; strip old CSS from components.css.
8. Verify locally:
     bun run lint && bun run typecheck && bun run test && bun run dev
   Eyeball each pane against its reference screenshot.
```

## Section 6 — QA additions

### A) New charter: `qa/web/charters/settings-page.md`

```yaml
---
id: settings-page
area: settings
auth: seeded
concurrency_key: null
risk_hint: high
oracles:
  - shared.console-error-free
  - shared.network-no-5xx
  - shared.few-hiccupps.product-consistency
  - shared.no-stuck-state
  - web.no-blank-render-after-3s
  - web.no-broken-images
  - web.tap-target-min-44px
  - settings.apply-bar-only-when-dirty
  - settings.restart-spinner-resolves
---
```

Body (full content lives in the charter file once written):

- Mission: walk every pane in the v2 settings sidebar and exercise
  each interactive case in under 8 minutes. Confirm apply-bar shows
  only for Soul-group dirty state, restart cycles resolve, and no
  pane regresses Dusk theming after the v2 rewrite.

- Touchpoints (one per pane plus a cross-pane sanity walk):
  1. Sidebar shell loads with three groups + 9 nav items.
  2. Persona pane: edit, Edit/Preview seg, Restore default, Discard,
     Apply & Restart resolves.
  3. Personalities: list, Activate (no apply-bar), expand row, edit
     body (apply-bar), New, Delete confirm.
  4. Voice: search, lang chips, paginate, select tile, Apply.
  5. Model: provider segment switch, search, select card.
  6. Tools: server expand/collapse, server toggle, per-tool toggle,
     Add server **must be hidden** in v1.
  7. Advanced: drag sliders, edit injection.
  8. Account: display name save, Change PIN modal flow (Esc/X/scrim/
     wrong-PIN/correct), Log out. Apply bar **must NOT appear**.
  9. Members: list, add member, toggle admin, reset PIN, delete
     confirm. Apply bar **must NOT appear**.
  10. Provider keys: WIP badge + placeholder copy only.
  11. Cross-pane: nav active state, scroll resets, Fraunces+DM
      rendering, Dusk colors verified, no console errors.

- Things to skip: TTS audio quality, AEC, voice-print enrollment,
  provider-key reveal/rotate.

- Reporter notes: apply-bar visibility violations are
  severity:critical (contract regression). Pane mismatches against
  the screenshot references are severity:major.

### B) New oracles in `qa/web/oracles.md` (Project-specific section)

```
### settings.apply-bar-only-when-dirty
Checks: The docked apply-bar at the bottom of the settings page is
visible IFF the active sidebar tab belongs to the Soul group AND at
least one Soul-group field is dirty. It MUST NOT appear on Account,
Members, or Provider keys panes regardless of dirty state.
How: After every interactive action in the settings page, query
`document.querySelector('.apply-bar')` visibility. Fire if visible
on User/Admin panes, or if hidden when Soul fields show dirty dots.
Severity: critical (contract regression).

### settings.restart-spinner-resolves
Checks: When Apply & Restart is clicked, the spinner must transition
saving → restarting → ready (or failed) within 30s. Never stick on
"Restarting…" forever.
How: After clicking Apply & Restart, watch the spinner element for
≤ 30s. Capture screenshot if it doesn't reach a terminal state.
Severity: major (user-blocking).
```

### C) Final tasks added to the implementation plan

```
T_FINAL_1  Author qa/web/charters/settings-page.md per Section 6A.

T_FINAL_2  Add settings.apply-bar-only-when-dirty +
           settings.restart-spinner-resolves oracles to
           qa/web/oracles.md per Section 6B.

T_FINAL_3  Agent invokes `/qa-session web settings-page`.
           At the preamble prompt, agent auto-replies `go` (this
           consent is granted by the user's approval of this spec).
           Agent waits for the session to complete (Stack bringup →
           Planner → Explorer browser session → Reporter →
           commit_findings). Records the session_id from the handoff.
           Then reads:
             qa/web/findings/bugs/*.json     (entries with
                                              first_seen_session ==
                                              this session_id)
             qa/web/findings/issues.md       (sections dated today)
             qa/web/sessions/<session_id>/session-sheet.md

T_FINAL_4  Agent triages findings:
             - severity:critical or :major bugs  → MUST fix on this
                                                   branch before
                                                   merge.
             - severity:minor bugs                → fix if obvious;
                                                   else document
                                                   under "Follow-ups"
                                                   in the design doc.
             - issues (UX feel, design oversight) → fix the clear
                                                   ones (broken
                                                   layout, wrong
                                                   copy); defer
                                                   subjective UX
                                                   unless user flags.
             - tester-blocker issues              → fix the test
                                                   setup (charter
                                                   ambiguity, missing
                                                   fixtures).

           Iteration loop with hard cap = 3:
             After fixes, agent re-runs `/qa-session web settings-page`
             with auto-`go`. Iterate until any of:
               (a) no new bugs of severity ≥ major AND remaining
                   issues are documented or deferred with written
                   rationale, AND `bun run ci` passes — done.
               (b) iteration count reaches 3 — agent stops and
                   surfaces remaining findings to the user with a
                   short summary; the branch is NOT marked ready.
```

## Decisions

- **Single locked theme.** Dusk + Filled + Comfortable + Fraunces+DM
  + Bars + Default. No theme switcher. The v2 Tweaks panel was a
  designer-side tool only.
- **App-wide token refresh, settings-only component refresh.** Tokens
  are the design language — they propagate. Components stay scoped to
  the settings page.
- **Unified Apply bar for the Soul group (B1).** Replaces the current
  two-flow model (per-section save+restart vs profile-fields apply-
  then-restart). Simpler mental model, matches v2 reference.
- **Persona = Soul.md, no Template library.** Drop v2's Template
  Card; one default backed by `getSoulDefault` is sufficient.
- **Provider keys = WIP placeholder.** Reveal/rotate deferred for
  security review. Backend stays write-only.
- **Drop placeholder tabs.** Permissions, Voices, Sessions, Invites,
  System are dropped — covered by v2 Members or unimplemented.
- **Drop "Add server" in Tools.** No backend; hidden until built.
- **Big-bang rewrite of `settings/`** (Approach A) — single PR,
  delete-and-replace.

## Open follow-ups (post-merge)

These are NOT in scope for this design:

- Live device count for the topbar status chip.
- Hermes version surfacing via `/api/v1/version` endpoint that
  proxies through to the Hermes runtime.
- Voice-print enrollment backend + UI re-enable.
- Personality template library (if multiple defaults are ever
  needed).
- MCP server runtime registration API + Tools "Add server" re-enable.
- Provider keys reveal/rotate backend + UI re-enable, after security
  review.
- Live `Healthy` indicator (currently hardcoded).

### Carried forward from QA session 2026-04-29T16-15-15Z-6e51 (5 issues, 0 bugs)

- Personalities pane empty-state UX unverified — needs seeded fixture + re-run charter.
- Tools pane reduced to enabled-MCP-IDs list (per-tool toggles deferred until backend exposes rich MCP catalog).
- Advanced compression-slider display label binding gap suspected — confirm via real drag interaction (programmatic event dispatch insufficient).
- Topbar gear-icon settings entry path untested — charter follow-up.
- `settings.restart-spinner-resolves` oracle not exercised this session (Apply & Restart skipped to avoid Hermes restart during QA) — charter follow-up.

## Implementation tasks summary (for the writing-plans handoff)

```
T_WT_0  Use the `superpowers:using-git-worktrees` skill to create a
        feature branch `feature/settings-v2-dusk` off `develop` in an
        isolated worktree. All subsequent tasks (T_TOK..T_FINAL_4) run
        in that worktree. Never push to `develop` directly per
        `.claude/rules/git-workflow.md`.

T_TOK   Token edits + index.html font imports.
T_PRM   Build primitives/ (15 components).
T_APB   Build apply-bar/ (port + extend FSM, smart label, v2 chrome).
T_SID   Build sidebar/ (nav-config, sidebar-nav, sidebar-status).
T_PPN   Build persona-pane.tsx (Soul.md only, drop Template Card).
T_PRP   Build personalities-pane.tsx (inline expand/edit per v2).
T_VPN   Build voice-pane.tsx (library grid + filter + paginate).
T_MPN   Build model-pane.tsx (provider seg + card list).
T_TPN   Build tools-pane.tsx (server list + per-tool toggle; hide Add).
T_APN   Build advanced-pane.tsx (sliders + injection).
T_ACP   Build account-pane.tsx (identity / security / session).
T_MEM   Build members-pane.tsx (list + invite + delete; ports admin-api wiring).
T_PVK   Build provider-keys-pane.tsx (WIP placeholder).
T_VIE   Wire new settings-view.tsx (tab + dirty + apply-bar visibility).
T_DEL   Delete old settings/ files + household-fixtures.ts; strip old CSS.
T_VER   Local verify: bun run lint / typecheck / test / dev; eyeball each pane.

T_FINAL_1   Author qa/web/charters/settings-page.md.
T_FINAL_2   Add 2 new oracles to qa/web/oracles.md.
T_FINAL_3   Agent runs /qa-session web settings-page, auto-go, reads findings.
T_FINAL_4   Agent triages + fixes; iterates with hard cap = 3.
```
