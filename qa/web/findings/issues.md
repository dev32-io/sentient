# Issues — web

The "weird, not sure yet" pile from qa-session runs. Each entry is
appended by the Reporter's PROOF debrief; recurring entries get a
"(seen again [date])" line appended in place. Promote to a confirmed
bug by writing a JSON file in `findings/bugs/`; demote / delete by
hand if no longer relevant.

---

## 2026-04-29 — session 2026-04-29T16-15-15Z-6e51

### [settings/shell] Hermes version displays 'v0.x' placeholder in sidebar brand block

- **kind:** `design-oversight`
- **open question:** Is 'v0.x' a hardcoded placeholder in the UI component, or is it the result of a missing/failing API call to fetch the Hermes runtime version? If hardcoded, it will ship as-is and be visible to all users permanently. If API-driven, is there a fallback placeholder when the API is unavailable?
- **excerpt:**

  > Brand block: "Sentient Gateway" / "Hermes v0.x" ✓ ? Hermes version shows "v0.x" — likely a placeholder/WIP version string. 
- ![screenshot](screenshots/01-sidebar-shell.png)

### [settings/personalities] Personalities list empty — Activate-on-row flow unverifiable without seeded fixture

- **kind:** `tester-blocker`
- **open question:** Does the Personalities pane show a friendly empty-state message when the list is empty, or does it render a blank content area? The session log does not note a placeholder/empty-state string, suggesting the latter. A blank content area with only a 'New' button may leave first-time users confused about what the section is for.
- **excerpt:**

  > ? Personality list is EMPTY — no rows rendered. Charter expected "one Active tag". API returned 200 for /api/v1/profile/personalities but response must have been an empty array. This is an environment state difference, not a regression. No Active tag present — cannot verify Activate flow on non-active row. 
- ![screenshot](screenshots/03-personalities-pane.png)

### [settings/advanced] Compression slider display label does not update via programmatic event dispatch

- **kind:** `tester-blocker`
- **open question:** Max tokens label updated correctly from the same programmatic dispatch that left the compression label stale — why does one range input respond and the other not? Are they wired differently (one uses onInput, one uses onChange, or one is bound to a ref)? Needs a follow-up charter with real drag interaction to confirm whether this is a tooling artifact or an actual reactive binding gap.
- **excerpt:**

  > Moved compression slider to 0.7, max tokens to 2048 via programmatic event dispatch. - Max tokens label updated to 2048 ✓ - Compression threshold display stayed at 0.50 visually (DOM value = 0.7, display label not updated from event-dispatch path). This may indicate the display is bound to a React/Preact state update that didn't fire via raw DOM event. Not conclusive. 
- ![screenshot](screenshots/07-advanced-pane.png)
- ![screenshot](screenshots/07b-advanced-sliders.png)

### [settings/shell] Topbar gear-icon settings entry point not exercised — charter gap

- **kind:** `other`
- **open question:** The topbar gear icon presumably navigates to the settings page when the user is NOT already there. This path was not tested because the dev build always opens at root = settings. A follow-up charter should navigate away from settings first (e.g. to a conversation view) and then click the gear icon to verify the routing and transition.
- **excerpt:**

  > ? Topbar has a gear icon (settings shortcut) but the charter mentions clicking "Settings in topbar". The app defaults directly to the settings UI at root URL in this build — topbar button navigation not separately tested. No blocker. 

### [settings/soul] Apply & Restart round-trip (restart-spinner-resolves oracle) not exercised

- **kind:** `other`
- **open question:** The settings.restart-spinner-resolves oracle is defined and enabled but was not triggered during this session. A follow-up charter should click Apply & Restart with a dirty Soul field and verify the spinner transitions saving → restarting → ready within 30s. This is the highest-impact user action in the settings flow.
- **excerpt:**

  > Skipped Apply & Restart per charter. 

