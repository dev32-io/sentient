# ESP32 — TODO

Cross-cutting follow-ups discovered during Phase 6+ work. Each entry: short
title, why it matters, current workaround, owner (if assigned). Keep entries
self-contained so they're pickable in any order.

## generic-touch-event verb (`ui.tap_at` / `touch.inject`)

**Why:** Agent-driven smoke tests have no way to drive the LVGL touch event
path from a verb. We have `button.toggle` (bypasses LVGL — calls
`Application::ToggleChatState()` directly) and `<<< EVT touch.tap` (emitted
from real physical taps in `SentientTouchReadCb`), but nothing that injects
a synthetic touch into the LVGL indev so widget click handlers fire as if a
real screen tap landed at (x, y).

**Impact:** Phase 6a's `S2 toggle uplink` smoke can verify the SDK state
machine via `button.toggle`, but cannot verify that the actual on-screen
button is correctly wired, sized, or hit-testable. A button-resize regression
(e.g. shrinking past the user's habit zone) is invisible to the agent suite —
only the operator notices when they tap and nothing happens.

**Workaround:** operator drives physical taps + reports observed behavior.
Slow and breaks "agent should be able to smoke without human".

**Proposed verb shape:**

```
ui.tap_at  { "x": <int>, "y": <int> }  -> { "ok": true }
```

Implementation sketch: register a dummy `lv_indev` (type pointer) that's
driven by a verb-set state struct. Verb writes (x, y, pressed=true) → next
`lv_timer_handler` reads it via the read-cb, dispatches a touch press, then
the verb arms a 60 ms timer to send the release. LVGL routes the event
through the normal widget tree — `on_button_clicked` fires if (x, y) lands
on a clickable widget.

Alternative: emit `lv_obj_send_event(target, LV_EVENT_CLICKED, ...)` via a
verb that takes a widget id from `ui.dump_tree`. Higher level, doesn't
exercise hit-testing — but easier to wire and good enough for "did the
button receive a click" checks.

**Acceptance:**
- New Group-A HIL test that calls `ui.tap_at` over the toggle button center,
  asserts `state` flips Idle → Listening.
- Same test at a coord outside the button → state stays Idle.
- Documented in `.claude/rules/esp32/cube/agent-console.md` alongside the
  existing `touch.tap` EVT line.

**Origin:** flagged during Phase 6a smoke (2026-05-15) when a button-size
regression went undetected by the agent suite — needed operator
intervention to confirm hit-test was broken.

## lvgl-sim coverage for toggle_button_screen

**Why:** `esp32/cube/lvgl-sim/` is the agent's fast (~2 s) UI-iteration loop
— edit → build → snapshot → `Read` PNG without ever flashing. Today the sim
only renders `firmware/ui-shared/test_screen.c`. The Phase 6+ user-facing
screen (`toggle_button_screen.cc`) lives under
`firmware/main/boards/sentient-cube/` and is invisible to the sim, so every
UI iteration on the toggle screen (button size, hint label, transcript
label, breath animation) requires a full device flash + smoke loop (~30 s).

**Impact:** The button-resize regression that motivated the
`ui.tap_at` follow-up above would have been caught instantly in the sim if
the toggle screen were sim-renderable. Designers/agents currently flash to
preview anything beyond the LVGL primitives in `test_screen.c`.

**Blocker:** `toggle_button_screen.cc` `#include`s `esp_log.h` and
`application.h` (for `Application::Instance().ToggleChatState()` on tap),
neither of which exists on the host. Per cube CLAUDE.md and
`.claude/rules/esp32/cube/lvgl-sim.md`, `ui-shared/` MUST stay pure-LVGL
(no `esp_log`, no FreeRTOS, no `esp_lcd_*`, no app glue).

**Proposed split:**

```
firmware/ui-shared/toggle_button_screen.c        // LVGL widget tree only:
                                                 //   create / show / set_state(READY|LISTENING|DISABLED)
                                                 //   set_hint(text) / set_transcript(text)
                                                 //   breath animation
                                                 // Takes a `void (*on_tap)(void*)` callback +
                                                 // opaque user_data — NO Application reference.

firmware/main/boards/sentient-cube/toggle_button_screen_glue.cc
                                                 // ESP_LOGI calls, registers on_tap that calls
                                                 // Application::Instance().ToggleChatState(),
                                                 // wires state-machine observer → set_state().
```

Sim then renders the pure widget; a tiny `lvgl-sim/main/toggle_demo.c`
stub can drive `set_state()` / `set_hint()` on a timer to preview every
visual state.

**Acceptance:**
- `lvgl-sim` CMakeLists adds `ui-shared/toggle_button_screen.c` to
  `SENTIENT_UI_SRCS`.
- `./build/sentient_cube_lvgl_sim --snapshot /tmp/sim.png` renders the
  toggle screen with all three button states reachable from a `--state`
  CLI flag (or a timed cycle).
- Device build remains green — `boards/sentient-cube/` glue takes over
  the app-side wiring with identical runtime behavior to today.

**Origin:** flagged during Phase 6+ snapshot-reliability work
(2026-05-15) when an agent confirmed the sim builds and renders
`test_screen.c` cleanly, but cannot exercise the user-facing
`toggle_button_screen.cc` widget tree.
