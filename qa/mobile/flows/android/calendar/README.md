# Android calendar direct-Maestro charter

These are reusable direct Maestro steps for the final E2E agent, not additions to `qa/mobile/run-e2e.sh`. Run Android and iOS sequentially. The exact comparison authority is:

- `sentient-design/HANDOFF.md`
- `sentient-design/brand-spec.md`
- `sentient-design/design/mobile/calendar.html`
- `sentient-design/components/mobile/sentient-mobile.js`
- reference URL: `http://127.0.0.1:8799/design/mobile/calendar.html`
- reference command: `python3 -m http.server 8799 --directory sentient-design`

## Fixture and network boundary

Use `withLocalCalendarFixture` from `gateway/src/calendar/e2e-helpers.ts`. Every invocation creates a unique namespace and guarantees reverse-order event and principal/database cleanup in `finally`. Pass only a loopback local target (or HTTPS loopback with `targetEnvironment: "local"`). Never target production and never reuse the principal for iOS. Derive the content-free `calendar-event-<sha256-prefix>` resource IDs from fixture identities for Maestro environment variables: concatenate the length-prefixed `eventId`, `occurrenceId`, `originalStart`, and uppercase scope name exactly as shared `stableKey` does, SHA-256 it, and use the first 12 bytes as lowercase hex. Do not write titles, payloads, credentials, descriptions, or search text to evidence/log files.

The direct agent owns this sequence:

1. Start and verify the real local stack.
2. Provision a unique fixture and log in as that disposable principal.
3. Invoke the relevant YAML file directly with Maestro.
4. For cached/uncached offline and reconnect cases, use the existing Android/emulator network controls, then wait for `calendar-offline`, `calendar-unavailable-offline`, or `calendar-freshness`. Do not add sleeps or a runner phase.
5. Run account/child phases sequentially, logging out before changing disposable principals.
6. Always restore emulator settings and allow `withLocalCalendarFixture` cleanup to finish, even after an assertion failure.

`00-open.yaml` is the reusable navigation step. The remaining files cover CAL-UX-001..007 and 013..014: four views/preferences, filters, CRUD, recurrence/conflict, permissions/account isolation, cached and unavailable offline/recovery, timezone/DST, visual states, and reduced motion.

## Exact Android display profiles

Capture production and reference at both logical profiles. Save current values first; restore them in a shell `trap`. Density 160 makes pixels equal logical dp for comparison.

```sh
old_size="$(adb shell wm size)"
old_density="$(adb shell wm density)"
old_font="$(adb shell settings get system font_scale)"
old_window="$(adb shell settings get global window_animation_scale)"
old_transition="$(adb shell settings get global transition_animation_scale)"
old_animator="$(adb shell settings get global animator_duration_scale)"
restore_calendar_emulator() {
  adb shell wm size reset
  adb shell wm density reset
  adb shell settings put system font_scale "$old_font"
  adb shell settings put global window_animation_scale "$old_window"
  adb shell settings put global transition_animation_scale "$old_transition"
  adb shell settings put global animator_duration_scale "$old_animator"
}
trap restore_calendar_emulator EXIT

adb shell wm size 390x844
adb shell wm density 160
# repeat matrix, then:
adb shell wm size 430x932
adb shell wm density 160
```

Record `adb shell wm size`, `wm density`, screenshot pixel dimensions, and the reference viewport beside each capture. Capture Day/Week/Month/Year, filters, dense agenda, preview, Add/Edit, recurrence, conflict, cached/unavailable offline, `font_scale=1.6`, and all animation scales set to `0` for reduced motion. Compare each to the exact committed mobile reference paths above; approved corrections are complete Year dates, 44dp tag targets, live controlled state, safe-area/sheet bounds, and corrected semantics.

## Semantic evidence

Use the UI hierarchy/accessibility inspector to record, without event content:

- traversal/order; selected, today, and outside-month labels;
- live view/filter/freshness state updates;
- target bounds of at least 44dp and font scaling;
- one calendar scroll region, floating-bar/navigation gesture clearance, and sheet bounds;
- top-overlay-only semantics, Back/scrim/close dismissal, and focus restoration to Add/event;
- reduced-motion state communication with nonessential animations removed.

Semantic inspection is **not** an actual TalkBack session and must not be described as one. TalkBack execution remains optional.
