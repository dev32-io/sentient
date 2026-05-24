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

# Charter: settings-page (sentient)

**Mission:** Walk every pane in the v2 settings sidebar and exercise
each interactive case in under 8 minutes. Confirm the apply-bar shows
only for Soul-group dirty state, that restart cycles resolve, and that
no pane regresses Dusk theming after the v2 rewrite.

## Preconditions

- Stack up at https://localhost:8888.
- Fresh seeded auth profile (login charter runs first if stale).
- At least one MCP server registered in `gateway/config.yaml#mcp_catalog`.

## Touchpoints (run in order; each touches one pane + its interactives)

### 1. Sidebar shell
- Click Settings in topbar → sidebar renders with three groups
  (SOUL / USER / ADMIN) and 9 nav items.
- Bottom status reads "Healthy · N MCP connected" with N matching the
  configured catalog.
- Brand block reads "Sentient Gateway" + "Hermes <version>".

### 2. Persona pane (Soul.md)
- Edit textarea: type a char → dirty dot on Persona nav item appears,
  apply-bar slides up reading "1 pending change · Apply & Restart".
- Switch Edit→Preview seg → markdown rendered (h2 / list / code spans
  visible).
- Click Restore default → textarea repopulates with default; dirty
  state stays.
- Click Discard → textarea reverts; apply-bar hides; dirty dot clears.
- Click Apply & Restart → spinner runs (≤ 30s), resolves to ready,
  textarea persists.

### 3. Personalities pane
- All personalities list renders with one Active tag.
- Click Activate on a non-active row → row updates without apply-bar
  appearing (instant op; oracle: apply-bar-only-when-dirty must NOT
  fire here).
- Expand a row chevron → inline body textarea appears.
- Edit body → apply-bar appears with "Apply & Restart".
- Click New → name + body inputs appear; apply-bar shows on type.
- Click Delete on a row → confirm gate; second click commits and
  triggers restart.

### 4. Voice pane
- Library renders ≥ 1 voice tile from providersApi.listVoices.
- Type in search → list filters live.
- Click a lang chip (e.g. en-US) → list filters by language.
- Paginate (if >8 voices) → next/prev buttons advance.
- Click a voice tile → tile gets selected ring; apply-bar appears.
- Apply & Restart resolves.

### 5. Model pane
- Provider segmented defaults to current `profile.model.provider`.
- Toggle to other provider → list refetches.
- Type in search → live filter.
- Click a model card → SELECTED tag appears; apply-bar shows.

### 6. Tools pane
- Server list renders (current v1: enabled MCP IDs only — per-tool
  granularity ships with backend extension; reporter should NOT flag
  the absence of per-tool toggles as a bug).
- "Add server" button MUST be hidden in v1 (backend not built).
- Click Remove on an enabled MCP → row drops from list; apply-bar
  shows "Apply & Restart".

### 7. Advanced pane
- Drag compression slider → value text updates live, apply-bar shows.
- Drag max tokens slider → same.
- Type in prompt-injection textarea → same.

### 8. Account pane (USER group)
- apply-bar must NOT appear at any point on this pane.
- Edit display name + Save → toast "Display name updated".
- Click Change PIN → modal opens. Cancel via Esc, X, scrim, Cancel.
- Enter wrong current PIN → inline error.
- Enter correct current + valid new + matching confirm → toast
  "PIN updated", modal closes.
- Click Log out → returns to login screen.

### 9. Members pane (ADMIN group)
- apply-bar must NOT appear.
- List renders real users from adminApi.listUsers.
- Add member with valid display name + 4-digit PIN → spinner-overlay
  shows "Applying changes…", then row appears, toast "X added".
- Toggle a non-self user's admin role → toast.
- Click delete on a non-self user → confirm modal; confirm triggers
  spinner-overlay + row removal.

### 10. Provider keys pane (ADMIN group, WIP)
- Pane shows WIP badge + the placeholder copy explaining the security
  deferral. No interactive controls.

### 11. Cross-pane sanity (visual)
- Switch between every pane in sequence; sidebar active state follows;
  main pane scroll position resets per pane.
- Fraunces (display) renders on <h2> headings; DM Sans (UI) on body /
  inputs / chips.
- Dusk colors: bg #2B2621, accent terra #F2A06A, ink #F2E8D6 on every
  pane.
- No console errors / warnings / 5xx network during the entire walk.

## Things to skip
- TTS audio quality, AEC — out of scope for settings UI.
- Voice-print enrollment — backend WIP; placeholder only.
- Provider-key reveal/rotate — backend deferred per security review.
- Per-tool granularity inside Tools pane — backend not yet exposing
  rich MCP catalog (intentional v1 deviation from plan source).

## Notes for the Reporter
- A failing apply-bar visibility test (bar shows on Account/Members,
  or doesn't show on Soul-group dirty) is severity:critical — that's a
  contract regression.
- Any pane that doesn't match its reference screenshot in
  `sentient-webui-design-v2/screenshots/` (within minor antialiasing
  tolerance) is severity:major.
