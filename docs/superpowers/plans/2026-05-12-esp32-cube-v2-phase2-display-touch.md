# ESP32 Cube v2 — Phase 2: Display + Touch + LVGL PC Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace xiaozhi's default emoji-face boot UI with a deterministic `sentient_cube_test_screen` (solid background + gradient bar + "SENTIENT CUBE" label + touch heatmap dot + 1–2 Hz spinner), wire touch taps to `<<< EVT touch.tap x y` via the agent_console event channel, and stand up an `esp32/cube/lvgl-sim/` host build that compiles the same screen code against SDL2 so UI iteration drops from ~30s per change (build + flash + boot + smoke) to ~2s.

**Architecture:** Phase 1 already wired the CO5300 QSPI panel, the CST9217 touch controller, LVGL, and a `SafeTouchReadCb` indev. Phase 2 adds: (a) a new screen module compilable in BOTH ESP-IDF and host-SDL2 targets, (b) a press-release tap detector that publishes one structured event per tap via the existing `agent_console_event()` API, (c) an owned `lv_conf.h` so the host sim and the device share LVGL configuration byte-for-byte, (d) an `esp32/cube/lvgl-sim/` host project derived from `lv_port_pc_vscode`. No protocol changes. No board-class churn beyond touch-tap detection plumbing. No audio. No WS work.

**Tech Stack:**
- ESP-IDF v5.5.2 (`~/esp/esp-idf`), Xtensa GCC, ESP32-S3
- xiaozhi vendored at SHA `b72945a`
- LVGL 9.x (managed component `lvgl/lvgl`) — version pinned in Task 4
- `esp_lvgl_port` (managed component, used by xiaozhi)
- `esp_lcd_touch_cst9217` (managed component, CST9217 driver)
- agent_console + net_logger (unchanged from Phase 1)
- Host sim: CMake + SDL2 (Homebrew: `sdl2`), based on [`lvgl/lv_port_pc_vscode`](https://github.com/lvgl/lv_port_pc_vscode)

**Spec source:** `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md` §4 Phase 2 + §7 LVGL PC Simulator.

**Phase 1 handover:** `docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md`

---

## What Phase 1 already gives us (read before starting)

Phase 1 stabilized the display + touch hardware path during smoke recovery. Phase 2 builds on these without modifying them:

- `firmware/main/boards/sentient-cube/sentient_cube.cc`
  - `CustomLcdDisplay : SpiLcdDisplay` — owns LVGL display object, calls `SpiLcdDisplay::SetupUI()` then re-acquires the LVGL mutex (Phase 1 finding #4) and currently calls `sentient_cube_create_toggle_button_screen()` from its `SetupUI()` override (line ~245).
  - `CustomBacklight` — drives backlight brightness via panel-IO command.
  - `InitializeTouch()` — creates CST9217 handle via `esp_lcd_touch_new_i2c_cst9217`, registers `SafeTouchReadCb` as the LVGL indev read callback via the raw LVGL API (lines ~602–637).
  - `SafeTouchReadCb` — tolerates I²C transient faults (Phase 1 finding #9). Reads coordinates + sets `data->state` PRESSED/RELEASED. Currently has NO tap-detection or event-emit hook.
- `firmware/main/boards/sentient-cube/sentient_ui_controller.{cc,h}` — C-callable UI API exposing `sentient_cube_create_toggle_button_screen()`, `sentient_cube_set_state()`, `sentient_cube_set_status_hint()`.
- `firmware/main/boards/sentient-cube/toggle_button_screen.cc` — current default screen (toggle-button widget). Phase 2 does NOT delete this — it stays in the tree, just isn't the boot screen for Phase 2.
- `firmware/components/agent_console/include/agent_console.h` — public API includes `agent_console_event(const char* json)` which emits `<<< EVT <json>\n` on stdout (already used by `ui.snapshot` for chunked image events).
- `firmware/components/agent_console/verbs/ui_snapshot.cc` — `ui.snapshot` verb already wired. Uses `lv_snapshot_take` + chunked base64 RGB565. Phase 2 reuses this as-is for screen evidence.
- `firmware/components/agent_console/verbs/ui.cc` — `ui.dump_tree` verb already wired.
- Managed component `espressif__esp_lcd_touch_cst9217` is installed.
- Managed component `lvgl__lvgl` is installed; current LVGL config is auto-generated from Kconfig (no owned `lv_conf.h` in tree).

---

## Constraints + Rules

These rules govern this phase. Read before starting any task.

- **Flash budget: ≤ 4 flashes total this phase.** Per `.claude/rules/esp32/cube/flash-discipline.md` and per spec §4 Phase 2 smoke bar. Tasks 1–7 verify by `idf.py build` + host-sim build alone. Only Task 8 + Task 9 flash, and Task 9's host-sim verification needs no flash.
- **One logical change per commit.** Per `.claude/rules/git-workflow.md`. Each Task in this plan ends with one commit (except observational/setup tasks explicitly marked "no commit").
- **Do NOT delete any of: `audio/wake_words/`, `audio/demuxer/`, `boards/sentient-cube/io_expander` references, `Kconfig.projbuild` BOARD_TYPE alternates, `assets/locales/*`.** User has confirmed these are kept for future scope (mixed-language rendering for zh/en/learning-mode UI; on-device wake-word + OGG demux + IO expanders may be exercised in later phases). Phase 2 is additive only.
- **Do NOT change `CONFIG_LANGUAGE_*` defaults.** Future plan: zh + en native switching. Current Phase 1 sdkconfig is fine as-is.
- **Do NOT modify `SafeTouchReadCb` itself.** It is a tested Phase 1 surface. Tap detection is layered ON TOP of it via a small wrapper indev or a post-LVGL hook — pick whichever pattern Task 3 specifies, but the original callback stays bit-identical.
- **Do NOT touch agent_console / net_logger source.** Phase 2 only consumes them. Touch event emission uses the existing public `agent_console_event()` API.
- **Simulator is a UI-iteration aid only.** Per spec §7 scope guard: device smoke is always required. A green host-sim run never replaces a device flash + smoke.
- **All ESP-IDF commands assume the env-source dance.** Wrap every `idf.py` invocation:
  ```bash
  bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py <args>'
  ```
- **Daemon stays alive.** `_cube_daemon.py` holds the USB-CDC port. Do not `kill` it between cube-cmd invocations.

---

## File Structure

Files created or modified in this phase, each justified by a task:

| Path | Change | Task |
|---|---|---|
| `esp32/cube/firmware/main/lv_conf.h` | NEW — owned copy of LVGL config template, version-pinned | Task 4 |
| `esp32/cube/firmware/main/CMakeLists.txt` | + INCLUDE_DIRS for shared `ui-shared/`; + SRCS for `test_screen.c` | Tasks 1, 6 |
| `esp32/cube/firmware/main/Kconfig.projbuild` | toggle to enable owned `lv_conf.h` path (per LVGL component conventions) | Task 4 |
| `esp32/cube/firmware/ui-shared/test_screen.h` | NEW — shared screen public API (C linkage) | Task 1 |
| `esp32/cube/firmware/ui-shared/test_screen.c` | NEW — shared LVGL widget construction, target-agnostic | Task 1 |
| `esp32/cube/firmware/ui-shared/CMakeLists.txt` | NEW — host-target build glue (ESP-IDF picks this up too) | Task 6 |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | Boot UI → test_screen instead of toggle_button; tap detector wraps `SafeTouchReadCb` | Tasks 2, 3 |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.h` | + `sentient_cube_show_test_screen(void)` C entry | Task 2 |
| `esp32/cube/lvgl-sim/CMakeLists.txt` | NEW — host build root | Task 5 |
| `esp32/cube/lvgl-sim/main/main.c` | NEW — SDL2 init + lvgl tick + invoke shared `test_screen.h` | Task 5 |
| `esp32/cube/lvgl-sim/main/sdl2_driver.c` | NEW — minimal SDL2 display + indev glue (adapted from lv_port_pc_vscode) | Task 5 |
| `esp32/cube/lvgl-sim/README.md` | NEW — version pin + build/run + update flow | Task 7 |
| `esp32/cube/lvgl-sim/.gitignore` | NEW — `build/`, `lvgl/` (cloned upstream) | Task 5 |
| `esp32/cube/.gitignore` | + `lvgl-sim/build/`, `lvgl-sim/lvgl/` | Task 5 |
| `docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md` | NEW — Phase 2 handover | Task 10 |

`ui-shared/` lives under `firmware/` because (a) ESP-IDF's `idf_component_register(SRCS ...)` can reference files relative to the project root, and (b) the host sim's CMakeLists references it with a relative path. Putting it inside `firmware/` keeps the shared dir co-located with the device source it's meant to mirror.

---

## Task 1: Create `ui-shared/test_screen` module (device-side compile)

**Files:**
- Create: `esp32/cube/firmware/ui-shared/test_screen.h`
- Create: `esp32/cube/firmware/ui-shared/test_screen.c`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt` (add `${PROJECT_DIR}/../ui-shared` to INCLUDE_DIRS and the .c to SRCS)

**Why:** The screen must compile both on ESP-IDF (with vendor LVGL config from managed components) and on host SDL2 (with the same LVGL but a different display backend). The screen itself touches only LVGL public API — no esp_log, no FreeRTOS, no hardware. Putting it in a shared `ui-shared/` directory under `firmware/` makes the device CMakeLists pick it up via `SRCS` while the host sim picks it up via its own CMakeLists in Task 5.

The screen contains exactly four elements per spec §4 Phase 2:
1. Solid-color background (chosen to differ from any pixel xiaozhi would draw — pick `lv_color_hex(0x0a1f33)` deep blue).
2. Horizontal gradient bar (left→right, dark→bright) spanning ~80% of width, centered vertically.
3. "SENTIENT CUBE" label, centered, white, ~28px (use LVGL default font scaled).
4. 1.5 Hz spinner widget — LVGL `lv_spinner_create`.
5. (Heatmap dot for touch is in Task 3 — keep this task screen-only.)

- [ ] **Step 1: Create `test_screen.h`**

Path: `esp32/cube/firmware/ui-shared/test_screen.h`

```c
// ui-shared/test_screen.h — Sentient Cube Phase 2 test screen.
//
// Builds a deterministic LVGL screen used by both device smoke (ui.snapshot
// PNG comparison) and the host lvgl-sim (SDL2 visual parity). The screen has
// four elements: solid background, gradient bar, "SENTIENT CUBE" label, and
// a slow spinner. The spinner ticks at ~1.5 Hz so two snapshots taken 500 ms
// apart will show visible rotation — that diff is part of the Phase 2 smoke
// bar.
//
// Touch heatmap dot is added by sentient_cube.cc (device-only, depends on
// the touch indev).
//
// Pure LVGL public API — no esp_log, no FreeRTOS, no platform headers. Safe
// to compile on both ESP-IDF and SDL2 host targets.

#pragma once

#include <lvgl.h>

#ifdef __cplusplus
extern "C" {
#endif

// Builds the test screen on top of lv_screen_active(). Idempotent: a second
// call clears the previous screen content first. Caller must hold the LVGL
// mutex on ESP-IDF (lvgl_port_lock); host sim has no mutex.
void sentient_test_screen_build(void);

// Sets the heatmap-dot position (in display coordinates). Called by the
// device-side touch handler on every PRESSED tick to show a live finger
// position; safe to call from any task that already holds the LVGL mutex.
// On host sim this is invoked by the SDL2 indev driver.
void sentient_test_screen_set_touch_xy(int x, int y, bool visible);

#ifdef __cplusplus
}
#endif
```

- [ ] **Step 2: Create `test_screen.c`**

Path: `esp32/cube/firmware/ui-shared/test_screen.c`

```c
// ui-shared/test_screen.c — implementation. See test_screen.h for contract.

#include "test_screen.h"

#include <string.h>

// Cached pointer to the heatmap dot widget so set_touch_xy can move it
// without re-walking the screen tree. NULL until the first build() call.
static lv_obj_t* s_touch_dot = NULL;

static void build_background(lv_obj_t* parent) {
    lv_obj_set_style_bg_color(parent, lv_color_hex(0x0a1f33), 0);
    lv_obj_set_style_bg_opa(parent, LV_OPA_COVER, 0);
}

static void build_label(lv_obj_t* parent) {
    lv_obj_t* label = lv_label_create(parent);
    lv_label_set_text(label, "SENTIENT CUBE");
    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_align(label, LV_ALIGN_CENTER, 0, -60);
}

static void build_gradient_bar(lv_obj_t* parent) {
    lv_obj_t* bar = lv_obj_create(parent);
    lv_obj_remove_style_all(bar);
    lv_obj_set_size(bar, LV_PCT(80), 16);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0x062033), 0);
    lv_obj_set_style_bg_grad_color(bar, lv_color_hex(0x4dd0e1), 0);
    lv_obj_set_style_bg_grad_dir(bar, LV_GRAD_DIR_HOR, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(bar, 8, 0);
}

static void build_spinner(lv_obj_t* parent) {
    lv_obj_t* spinner = lv_spinner_create(parent);
    lv_obj_set_size(spinner, 56, 56);
    lv_obj_align(spinner, LV_ALIGN_CENTER, 0, 70);
    // ~1.5 Hz: full rotation in 666 ms.
    lv_spinner_set_anim_params(spinner, 666, 200);
}

static lv_obj_t* build_touch_dot(lv_obj_t* parent) {
    lv_obj_t* dot = lv_obj_create(parent);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, 22, 22);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(dot, lv_color_hex(0xff5252), 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dot, 2, 0);
    lv_obj_set_style_border_color(dot, lv_color_white(), 0);
    lv_obj_add_flag(dot, LV_OBJ_FLAG_HIDDEN);
    return dot;
}

void sentient_test_screen_build(void) {
    lv_obj_t* scr = lv_screen_active();
    lv_obj_clean(scr);

    build_background(scr);
    build_gradient_bar(scr);
    build_label(scr);
    build_spinner(scr);
    s_touch_dot = build_touch_dot(scr);
}

void sentient_test_screen_set_touch_xy(int x, int y, bool visible) {
    if (s_touch_dot == NULL) {
        return;
    }
    if (visible) {
        lv_obj_set_pos(s_touch_dot, x - 11, y - 11);
        lv_obj_clear_flag(s_touch_dot, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s_touch_dot, LV_OBJ_FLAG_HIDDEN);
    }
}
```

- [ ] **Step 3: Wire `ui-shared/` into the device CMakeLists**

Open `esp32/cube/firmware/main/CMakeLists.txt`. Find the `idf_component_register(...)` call (it starts near the top of the file and lists `SRCS`, `INCLUDE_DIRS`, etc.). Make two additions:

1. Append `"../ui-shared/test_screen.c"` to the `SRCS` list (preserve existing entries, just add this one).
2. Append `"../ui-shared"` to the `INCLUDE_DIRS` list.

Use surgical edits — do not reorder the file. If the lists are conditionally guarded by `if(CONFIG_BOARD_TYPE_SENTIENT_CUBE)` blocks, place the additions UNCONDITIONALLY at the top-level register block so the screen module always compiles. The screen is target-agnostic and small (~80 LOC).

- [ ] **Step 4: Build green**

Run:
```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -25'
```

Expected: `Project build complete.` `test_screen.c.obj` appears in `build/esp-idf/main/CMakeFiles/__idf_main.dir/__/ui-shared/`. No "undefined reference to lv_spinner_create" errors — `lv_spinner` is part of LVGL's standard widget set and enabled in xiaozhi's stock Kconfig.

If build fails with a "unable to open lv_conf.h" message: Task 4 has not run yet — defer this build verification until after Task 4 lands, OR run them in order. Recommended order is what's listed: 1, 2, 3, 4, 5, 6, 7, 8.

If build fails with "undefined reference to lv_spinner_set_anim_params": LVGL version skew — switch to `lv_spinner_set_anim_params(spinner, 600, 200)` form or check the installed LVGL version (see `managed_components/lvgl__lvgl/idf_component.yml`). The signature has been stable since LVGL 9.0.

- [ ] **Step 5: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/ui-shared/ esp32/cube/firmware/main/CMakeLists.txt && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/ui): ui-shared/test_screen — device-target compile

Adds the Phase 2 test screen module: solid background (#0a1f33),
horizontal gradient bar, "SENTIENT CUBE" label, 1.5 Hz spinner, and a
heatmap dot for touch (kept hidden until sentient_cube.cc wires the
touch indev in a follow-up task).

Module is pure LVGL public API — no esp_log, no FreeRTOS, no platform
headers — so the same .c file will compile on the lvgl-sim SDL2 host
target later in this phase. The shared dir lives at
`esp32/cube/firmware/ui-shared/` and is registered via the device's
main/CMakeLists.txt SRCS + INCLUDE_DIRS.

Build verified green; runtime wiring follows in Task 2.
EOF
)"
```

---

## Task 2: Boot UI → `sentient_test_screen_build()`

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.h`
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`

**Why:** Phase 1's `CustomLcdDisplay::SetupUI()` calls `sentient_cube_create_toggle_button_screen()` as the boot UI. Phase 2 swaps that call for the new test screen. Per spec §4 Phase 2, the toggle-button screen is restored as the default boot UI in Phase 6 (Sentient Connect). For Phase 2 through Phase 5, the cube boots into the test screen by default; the toggle-button module is kept in the tree, just not invoked.

Pattern: add a new C entry point `sentient_cube_show_test_screen()` to `sentient_ui_controller.h` that internally calls `sentient_test_screen_build()`. The board calls this entry point. This keeps the C-API contract layer intact — boards continue to depend on `sentient_ui_controller.h`, not on `ui-shared/test_screen.h` directly. (When Phase 6 restores the toggle button, the board call site flips back; nothing else changes.)

- [ ] **Step 1: Add the new C entry to `sentient_ui_controller.h`**

Open `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.h`. In the `extern "C"` block, add this declaration immediately after `sentient_cube_set_status_hint`:

```c
// Builds the Phase 2 test screen on the active LVGL screen. Idempotent:
// repeat calls clean and rebuild. Caller must hold the LVGL mutex.
//
// Used as the boot UI for Phase 2..5. Phase 6 restores
// sentient_cube_create_toggle_button_screen as the boot UI.
void sentient_cube_show_test_screen(void);
```

- [ ] **Step 2: Implement the entry in `sentient_ui_controller.cc`**

Open `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.cc`. Near the top, add:

```cpp
#include "test_screen.h"
```

Then near the existing `sentient_cube_create_toggle_button_screen` function definition (the file's `extern "C"` block), add:

```cpp
extern "C" void sentient_cube_show_test_screen(void) {
    sentient_test_screen_build();
}
```

(Wrap with `lvgl_port_lock(timeout)` if the existing helpers in this file do — match the pattern of `sentient_cube_create_toggle_button_screen`. If `create_toggle_button_screen` is called under an external lock, this new entry is too.)

- [ ] **Step 3: Swap the boot-UI call site in `sentient_cube.cc`**

Open `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`. Around line 245 (inside `CustomLcdDisplay::SetupUI()`), find this line:

```cpp
        sentient_cube_create_toggle_button_screen();
```

Replace it with:

```cpp
        // Phase 2: boot into the deterministic test screen for ui.snapshot
        // smoke and lvgl-sim parity verification. The toggle-button screen
        // (sentient_cube_create_toggle_button_screen()) returns as the boot
        // UI in Phase 6 (Sentient Connect).
        sentient_cube_show_test_screen();
```

- [ ] **Step 4: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -15'
```

Expected: `Project build complete.` No new warnings. If `sentient_ui_controller.cc` cannot find `test_screen.h`, the `INCLUDE_DIRS` addition from Task 1 Step 3 is missing the path — re-check that `"../ui-shared"` is in the `idf_component_register` `INCLUDE_DIRS` list AND that the include path resolves from the `main/` perspective (it does: `main/../ui-shared/` = `firmware/ui-shared/`).

- [ ] **Step 5: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.{cc,h} esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/ui): swap boot UI to test screen for Phase 2

Phase 1 booted into sentient_cube_create_toggle_button_screen (a
single-button mic toggle). Phase 2 needs a deterministic screen for
ui.snapshot PNG comparison and lvgl-sim parity verification — the
toggle button has live state-machine animations that produce
non-reproducible snapshots.

Adds sentient_cube_show_test_screen() to sentient_ui_controller.h's
public C API as the boot UI for Phase 2..5. The toggle-button module
stays in the tree; Phase 6 (Sentient Connect) flips the boot call back.

Caller pattern matches sentient_cube_create_toggle_button_screen — no
mutex behavior change, no widget-lifecycle change.
EOF
)"
```

---

## Task 3: Touch-tap event emission (`<<< EVT touch.tap x y`)

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` (extend `SafeTouchReadCb`'s siblings — NOT the callback body itself)

**Why:** Spec §4 Phase 2 smoke bar requires that `cube-cmd events --tail 30` returns at least one `touch.tap` event with sane x/y after a manual finger tap. The Phase 1 `SafeTouchReadCb` feeds LVGL but has no application-visible side effect — agent-side smoke can't observe taps.

Approach: piggyback on `SafeTouchReadCb` to detect a press→release transition once per tap and emit a JSON event via the existing `agent_console_event()` API (`<<< EVT {"event":"touch.tap","x":N,"y":N,"ts_us":N}\n`). Use a small static state machine inside an INDEV callback wrapper so we never modify the body of `SafeTouchReadCb` itself (keep that callback bit-identical for safety per the Phase 1 lesson "do not change a tested vendor-replacement callback").

The cleanest layering is: keep `SafeTouchReadCb` as the raw LVGL indev read callback (no change). Add a separate post-processing step that observes its output. Two implementation options:

- **Option A (recommended): tap-detector wraps `SafeTouchReadCb`.** A new function `SentientTouchReadCb` is registered as the indev read callback instead of `SafeTouchReadCb`. It calls `SafeTouchReadCb(indev, data)` first, then inspects `data->state` and `data->point` and runs the press-release FSM on top.
- **Option B: LVGL `LV_EVENT_PRESSED`/`LV_EVENT_RELEASED` on the active screen.** Requires LVGL event subscription; runs in the LVGL task and may not fire before SetupUI completes. Slightly more code, slightly less direct.

Pick Option A. It is the same shape as Phase 1 already used: register a custom indev callback, do the work there. `SafeTouchReadCb` becomes a static helper, and `SentientTouchReadCb` becomes the new indev read callback registered via `lv_indev_set_read_cb`.

The FSM state lives in two file-scope statics:
- `static bool s_was_pressed_last_tick = false;` — tracks prior tick.
- `static uint32_t s_press_start_ms = 0;` — for future "long-press vs tap" gating (not implemented this phase; keep field for clarity).

Emission rule: emit `touch.tap` exactly on the transition `prev=PRESSED → curr=RELEASED` with `data->point` from the LAST PRESSED tick (the release tick's `data->point` is undefined per LVGL). So we cache the last pressed coordinate.

Heatmap-dot wiring (introduced in Task 1): on each PRESSED tick, call `sentient_test_screen_set_touch_xy(x, y, true)`. On each RELEASED tick, call `sentient_test_screen_set_touch_xy(0, 0, false)`. The heatmap dot is a visual indicator of where the touch indev THINKS the finger is — useful for cross-checking the emitted x/y.

- [ ] **Step 1: Add the wrapper indev callback above `InitializeTouch()`**

In `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`, find the existing `SafeTouchReadCb` static function (around line 584). Immediately after it, add:

```cpp
// Tap-detector wrapper around SafeTouchReadCb. Runs the safe read first,
// then layers press→release transition detection on top to emit a single
// JSON event per tap via agent_console. Also drives the test-screen
// heatmap dot for visual cross-check.
//
// Registered as the LVGL indev read callback instead of SafeTouchReadCb
// directly. SafeTouchReadCb stays bit-identical for transient-fault
// tolerance.
static void SentientTouchReadCb(lv_indev_t* indev, lv_indev_data_t* data) {
    SafeTouchReadCb(indev, data);

    static bool s_was_pressed_last_tick = false;
    static lv_point_t s_last_pressed_point = { 0, 0 };

    const bool is_pressed = (data->state == LV_INDEV_STATE_PRESSED);

    if (is_pressed) {
        s_last_pressed_point = data->point;
        sentient_test_screen_set_touch_xy(data->point.x, data->point.y, true);
    } else if (s_was_pressed_last_tick) {
        // Press → release transition. Emit one tap event with the LAST
        // pressed-tick coordinates; release-tick coords are undefined.
        char json[96];
        snprintf(json, sizeof(json),
                 "{\"event\":\"touch.tap\",\"x\":%ld,\"y\":%ld,\"ts_us\":%lld}",
                 (long)s_last_pressed_point.x,
                 (long)s_last_pressed_point.y,
                 (long long)esp_timer_get_time());
        agent_console_event(json);
        sentient_test_screen_set_touch_xy(0, 0, false);
    }

    s_was_pressed_last_tick = is_pressed;
}
```

Add the necessary includes near the top of the file if they aren't already present:

```cpp
#include <esp_timer.h>
#include "agent_console.h"
#include "test_screen.h"
```

(`agent_console.h` is the public component header — installed via `PRIV_REQUIRES agent_console` in the main CMakeLists.txt, which Phase 1 already wired.)

- [ ] **Step 2: Swap the indev registration to use the new callback**

In `InitializeTouch()`, find the line:

```cpp
        lv_indev_set_read_cb(indev, SafeTouchReadCb);
```

Replace with:

```cpp
        lv_indev_set_read_cb(indev, SentientTouchReadCb);
```

`SafeTouchReadCb` keeps its definition — it's called by the new wrapper.

- [ ] **Step 3: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -15'
```

Expected: green. If `agent_console_event` is unresolved at link time, `main`'s CMakeLists `PRIV_REQUIRES` is missing `agent_console` — verify by:

```bash
grep "PRIV_REQUIRES\|REQUIRES" esp32/cube/firmware/main/CMakeLists.txt | head -5
```

It MUST list `agent_console`. Phase 1 wired this; do not change it here.

- [ ] **Step 4: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/touch): emit touch.tap EVT on press→release transition

Wraps the existing SafeTouchReadCb with a tap-detector indev callback
(SentientTouchReadCb). On each press→release transition, emits exactly
one structured event:

  <<< EVT {"event":"touch.tap","x":N,"y":N,"ts_us":N}

Coordinates are sampled from the last PRESSED tick (release-tick coords
are undefined per LVGL). Event flows out via the existing
agent_console_event() public API — no protocol change, no new verb.

Side effect: drives the test-screen heatmap dot via
sentient_test_screen_set_touch_xy so on-device + remote (events --tail)
agree on where the touch landed. SafeTouchReadCb itself is unchanged.
EOF
)"
```

---

## Task 4: Own `lv_conf.h` so device + host sim share LVGL config

**Files:**
- Create: `esp32/cube/firmware/main/lv_conf.h`
- Modify: `esp32/cube/firmware/sdkconfig.defaults` — opt LVGL component to use the owned header
- Modify: `esp32/cube/firmware/main/CMakeLists.txt` — add a compile definition so the LVGL component picks up the owned `lv_conf.h` from `main/`'s include dir

**Why:** Per spec §7: "Share `lv_conf.h` between host and device builds." Phase 1 inherited LVGL config from the managed component's Kconfig path; the host sim cannot consume Kconfig. Owning a single `lv_conf.h` and pointing both builds at it eliminates the "host renders correctly but device looks different (or vice versa)" failure mode.

LVGL's standard convention: define `LV_CONF_INCLUDE_SIMPLE` and put `lv_conf.h` somewhere on the include path. Both the device LVGL build (managed component) and the host sim respect this convention.

Version-pin source: `managed_components/lvgl__lvgl/idf_component.yml` declares the LVGL version pinned in `dependencies.lock`. The owned `lv_conf.h` is copied from `managed_components/lvgl__lvgl/lv_conf_template.h` AT THAT EXACT VERSION.

- [ ] **Step 1: Capture the LVGL version + template SHA**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
grep -A2 "lvgl/lvgl" esp32/cube/firmware/main/idf_component.yml | head -5 ; \
grep -A2 "lvgl__lvgl" esp32/cube/firmware/dependencies.lock 2>&1 | head -5 ; \
sha256sum esp32/cube/firmware/managed_components/lvgl__lvgl/lv_conf_template.h | cut -d' ' -f1
```

Record:
- Pinned LVGL version (e.g. `9.2.2`)
- Template SHA256

These go into `lvgl-sim/README.md` in Task 7.

- [ ] **Step 2: Copy the template into an owned file**

```bash
cp /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware/managed_components/lvgl__lvgl/lv_conf_template.h \
   /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware/main/lv_conf.h
```

Open the new file. Near the top, find the `#if 0` guard pattern that surrounds the entire config:

```c
/*
 * Copy this file as `lv_conf.h`
 * 1. simply next to the `lvgl` folder
 * 2. or to any other place and
 *    - define `LV_CONF_INCLUDE_SIMPLE`;
 *    - add the path as include path.
 */

#if 0 /*Set it to "1" to enable content*/
```

Change the `#if 0` line to `#if 1`. This activates the config. Leave every other setting at the template default — Phase 2 ships LVGL defaults; future phases can tweak per-feature.

Add a header comment ABOVE the existing template comment block:

```c
// ============================================================================
// SENTIENT CUBE — OWNED lv_conf.h
//
// Source: managed_components/lvgl__lvgl/lv_conf_template.h at LVGL <VERSION>
// Source SHA256: <TEMPLATE-SHA-FROM-STEP-1>
//
// Pinned here so the device build and the lvgl-sim host build use byte-for-
// byte identical LVGL configuration. To update: bump the lvgl managed
// component (see firmware/main/idf_component.yml), re-copy this file from
// the new lv_conf_template.h, and re-record the version + SHA above. Then
// run device + sim smoke before merging.
// ============================================================================
```

Substitute `<VERSION>` and `<TEMPLATE-SHA-FROM-STEP-1>` with the real values from Step 1.

- [ ] **Step 3: Tell the LVGL component to use the owned header**

There are two halves to this:

**3a.** Tell the LVGL component (managed) to load `lv_conf.h` via the simple-include path. Edit `esp32/cube/firmware/sdkconfig.defaults` — find this block at the tail (added in Phase 1):

```
CONFIG_LV_USE_OBJ_NAME=y
CONFIG_LV_USE_OBJ_ID=y
CONFIG_LV_USE_OBJ_ID_BUILTIN=y
```

Immediately AFTER this block, append:

```
# LVGL: load configuration from an owned lv_conf.h instead of via Kconfig
# generation. Required so the host lvgl-sim build (which has no Kconfig)
# uses byte-identical LVGL config. The owned header lives at
# firmware/main/lv_conf.h.
CONFIG_LV_CONF_SKIP=n
CONFIG_LV_CONF_INCLUDE_SIMPLE=y
```

**3b.** Add `main/` to the include path that LVGL sees. The LVGL managed component is built as a separate IDF component; it discovers `lv_conf.h` via the global include path. Add to `esp32/cube/firmware/main/CMakeLists.txt` near the top of the `idf_component_register(...)` block (or directly after it, depending on existing style):

```cmake
# LVGL picks up lv_conf.h via LV_CONF_INCLUDE_SIMPLE. The header lives
# next to main/'s sources; expose this dir to the global include path so
# the LVGL component finds it.
idf_component_get_property(lvgl_lib lvgl__lvgl COMPONENT_LIB)
target_compile_definitions(${lvgl_lib} PUBLIC LV_CONF_INCLUDE_SIMPLE=1)
target_include_directories(${lvgl_lib} PUBLIC ${CMAKE_CURRENT_LIST_DIR})
```

(If `lvgl__lvgl` resolves differently in your dependencies.lock — e.g. `espressif__lvgl` — substitute the right component name from `managed_components/` directory listing.)

- [ ] **Step 4: Clean reconfigure + build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && rm -rf build && idf.py build 2>&1 | tail -30'
```

Expected: build green. Watch the log for `lv_conf.h` resolution — at the LVGL compile step there should be no warnings about "lv_conf_internal.h: lv_conf.h not found"; if any appear, the include path didn't propagate. Fix inside this task before committing.

- [ ] **Step 5: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/main/lv_conf.h esp32/cube/firmware/main/CMakeLists.txt esp32/cube/firmware/sdkconfig.defaults && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/lvgl): own lv_conf.h for device + host-sim parity

Phase 2 introduces a host LVGL simulator (esp32/cube/lvgl-sim, later in
this phase). The simulator cannot consume Kconfig-generated LVGL config
— it needs a hand-edited lv_conf.h.

Copies the LVGL managed-component's lv_conf_template.h into
firmware/main/lv_conf.h (version + SHA pinned in the file header),
flips the activation guard from `#if 0` to `#if 1`, and tells the
managed LVGL component to load it via LV_CONF_INCLUDE_SIMPLE. main/'s
dir is added to the LVGL component's PUBLIC include dirs so the header
resolves from inside managed_components/lvgl__lvgl/.

The host sim later in this phase points at the same lv_conf.h via its
own CMakeLists — that is what makes the two targets render byte-for-
byte identically.
EOF
)"
```

---

## Task 5: Stand up `esp32/cube/lvgl-sim/` host build

**Files:**
- Create: `esp32/cube/lvgl-sim/CMakeLists.txt`
- Create: `esp32/cube/lvgl-sim/main/main.c`
- Create: `esp32/cube/lvgl-sim/main/sdl2_driver.c`
- Create: `esp32/cube/lvgl-sim/.gitignore`
- Modify: `esp32/cube/.gitignore` (already has firmware build entries; append sim entries)

**Why:** Per spec §7: a host LVGL simulator brings UI iteration from ~30s/cycle to ~2s/cycle. The simulator is based on [`lvgl/lv_port_pc_vscode`](https://github.com/lvgl/lv_port_pc_vscode), adapted to:
- pull LVGL from a sibling git clone (not vcpkg / not Conan)
- use the OWNED `firmware/main/lv_conf.h` via `LV_CONF_PATH`
- compile the shared `firmware/ui-shared/test_screen.c`
- render via SDL2 (Homebrew: `brew install sdl2`)

Pre-requisite: `brew install sdl2 cmake`. If `sdl2.pc` isn't found, the host needs `PKG_CONFIG_PATH` pointing at Homebrew's pkgconfig dir; document in the README (Task 7).

- [ ] **Step 1: Create the `.gitignore` for the sim**

Path: `esp32/cube/lvgl-sim/.gitignore`

```
build/
lvgl/
```

Then update `esp32/cube/.gitignore`. View its current state:

```bash
cat esp32/cube/.gitignore
```

Append (only if not already present):

```
# LVGL PC simulator
lvgl-sim/build/
lvgl-sim/lvgl/
```

- [ ] **Step 2: Create `lvgl-sim/CMakeLists.txt`**

Path: `esp32/cube/lvgl-sim/CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.13)
project(sentient_cube_lvgl_sim C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ---- Configuration ----------------------------------------------------------
# LVGL source lives next to this CMakeLists (cloned by setup step, see
# README.md). Version is pinned to match firmware/main/lv_conf.h (which is
# itself version-pinned to the managed component).
set(LVGL_DIR        "${CMAKE_CURRENT_LIST_DIR}/lvgl"  CACHE PATH "Path to LVGL source clone.")
set(SENTIENT_FW_DIR "${CMAKE_CURRENT_LIST_DIR}/../firmware" CACHE PATH "Path to sentient cube firmware/.")

if(NOT EXISTS "${LVGL_DIR}/lvgl.h")
    message(FATAL_ERROR
        "LVGL source not found at ${LVGL_DIR}.\n"
        "Clone the pinned LVGL version next to this CMakeLists.txt — see\n"
        "  ${CMAKE_CURRENT_LIST_DIR}/README.md for the exact tag and commands.")
endif()

if(NOT EXISTS "${SENTIENT_FW_DIR}/main/lv_conf.h")
    message(FATAL_ERROR
        "Sentient owned lv_conf.h not found at ${SENTIENT_FW_DIR}/main/lv_conf.h.\n"
        "This file is created by Phase 2 Task 4; run that task first.")
endif()

# ---- LVGL build settings ----------------------------------------------------
add_compile_definitions(
    LV_CONF_INCLUDE_SIMPLE=1
    LV_CONF_PATH="${SENTIENT_FW_DIR}/main/lv_conf.h"
)

# ---- SDL2 -------------------------------------------------------------------
find_package(SDL2 REQUIRED)
include_directories(${SDL2_INCLUDE_DIRS})

# ---- LVGL as a library ------------------------------------------------------
# Use LVGL's own CMakeLists if present, else recurse for sources.
add_subdirectory(${LVGL_DIR} ${CMAKE_CURRENT_BINARY_DIR}/lvgl_build)

# ---- Sentient shared UI sources --------------------------------------------
set(SENTIENT_UI_SRCS
    "${SENTIENT_FW_DIR}/ui-shared/test_screen.c"
)

# ---- Sim app ----------------------------------------------------------------
add_executable(sentient_cube_lvgl_sim
    main/main.c
    main/sdl2_driver.c
    ${SENTIENT_UI_SRCS}
)

target_include_directories(sentient_cube_lvgl_sim PRIVATE
    "${SENTIENT_FW_DIR}/ui-shared"
    "${SENTIENT_FW_DIR}/main"
    "${LVGL_DIR}"
)

target_link_libraries(sentient_cube_lvgl_sim PRIVATE lvgl ${SDL2_LIBRARIES})
```

- [ ] **Step 3: Create `lvgl-sim/main/main.c`**

Path: `esp32/cube/lvgl-sim/main/main.c`

```c
// lvgl-sim/main/main.c — Sentient Cube LVGL host simulator entry point.
//
// Boots LVGL on an SDL2 window of the same dimensions as the device panel
// (466x466), runs the shared test screen, and pumps LVGL ticks at ~60 Hz.
// Use Cmd+W (macOS) or close the window to exit.

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <SDL.h>

#include "lvgl/lvgl.h"
#include "sdl2_driver.h"
#include "test_screen.h"

#define SENTIENT_SIM_WIDTH  466
#define SENTIENT_SIM_HEIGHT 466

static uint32_t tick_get_ms(void) {
    return SDL_GetTicks();
}

int main(int argc, char* argv[]) {
    (void)argc; (void)argv;

    lv_init();
    lv_tick_set_cb(tick_get_ms);

    if (sentient_sim_sdl2_init(SENTIENT_SIM_WIDTH, SENTIENT_SIM_HEIGHT) != 0) {
        fprintf(stderr, "[lvgl-sim] SDL2 init failed\n");
        return 1;
    }

    sentient_test_screen_build();
    printf("[lvgl-sim] running %dx%d. Close the window to exit.\n",
           SENTIENT_SIM_WIDTH, SENTIENT_SIM_HEIGHT);

    bool running = true;
    while (running) {
        running = sentient_sim_sdl2_pump_events();
        lv_timer_handler();
        SDL_Delay(5);
    }

    sentient_sim_sdl2_shutdown();
    return 0;
}
```

- [ ] **Step 4: Create `lvgl-sim/main/sdl2_driver.c` + header**

Path: `esp32/cube/lvgl-sim/main/sdl2_driver.h`

```c
#pragma once
#include <stdbool.h>

int  sentient_sim_sdl2_init(int width, int height);
void sentient_sim_sdl2_shutdown(void);
bool sentient_sim_sdl2_pump_events(void);
```

Path: `esp32/cube/lvgl-sim/main/sdl2_driver.c`

```c
// lvgl-sim/main/sdl2_driver.c — Minimal SDL2 display + indev glue for LVGL.
//
// Adapted from lvgl/lv_port_pc_vscode (simulator template). Single window,
// software framebuffer, mouse-as-touch indev.

#include "sdl2_driver.h"

#include <stdlib.h>
#include <string.h>
#include <SDL.h>

#include "lvgl/lvgl.h"

static SDL_Window*    s_window     = NULL;
static SDL_Renderer*  s_renderer   = NULL;
static SDL_Texture*   s_texture    = NULL;
static lv_display_t*  s_display    = NULL;
static lv_indev_t*    s_indev      = NULL;
static int            s_width      = 0;
static int            s_height     = 0;
static int            s_mouse_x    = 0;
static int            s_mouse_y    = 0;
static bool           s_mouse_down = false;

static void flush_cb(lv_display_t* disp, const lv_area_t* area, uint8_t* px_map) {
    (void)disp;
    int w = area->x2 - area->x1 + 1;
    int h = area->y2 - area->y1 + 1;
    SDL_Rect r = { area->x1, area->y1, w, h };
    SDL_UpdateTexture(s_texture, &r, px_map, w * 2);  // RGB565 = 2 bytes/px
    SDL_RenderClear(s_renderer);
    SDL_RenderCopy(s_renderer, s_texture, NULL, NULL);
    SDL_RenderPresent(s_renderer);
    lv_display_flush_ready(disp);
}

static void indev_read_cb(lv_indev_t* indev, lv_indev_data_t* data) {
    (void)indev;
    data->point.x = s_mouse_x;
    data->point.y = s_mouse_y;
    data->state = s_mouse_down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

int sentient_sim_sdl2_init(int width, int height) {
    if (SDL_Init(SDL_INIT_VIDEO) != 0) return -1;

    s_window = SDL_CreateWindow("Sentient Cube — lvgl-sim",
                                SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                                width, height, 0);
    if (!s_window) return -2;
    s_renderer = SDL_CreateRenderer(s_window, -1, SDL_RENDERER_ACCELERATED);
    if (!s_renderer) return -3;
    s_texture = SDL_CreateTexture(s_renderer, SDL_PIXELFORMAT_RGB565,
                                  SDL_TEXTUREACCESS_STREAMING, width, height);
    if (!s_texture) return -4;

    s_width  = width;
    s_height = height;

    // LVGL display
    s_display = lv_display_create(width, height);
    static uint8_t* fb = NULL;
    size_t buf_bytes = (size_t)width * (size_t)height * 2;
    fb = (uint8_t*)malloc(buf_bytes);
    if (!fb) return -5;
    lv_display_set_buffers(s_display, fb, NULL, buf_bytes,
                           LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_color_format(s_display, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(s_display, flush_cb);

    // LVGL indev (mouse-as-touch)
    s_indev = lv_indev_create();
    lv_indev_set_type(s_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_indev, indev_read_cb);
    lv_indev_set_display(s_indev, s_display);

    return 0;
}

bool sentient_sim_sdl2_pump_events(void) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
        switch (e.type) {
            case SDL_QUIT:
                return false;
            case SDL_MOUSEBUTTONDOWN:
                if (e.button.button == SDL_BUTTON_LEFT) s_mouse_down = true;
                break;
            case SDL_MOUSEBUTTONUP:
                if (e.button.button == SDL_BUTTON_LEFT) s_mouse_down = false;
                break;
            case SDL_MOUSEMOTION:
                s_mouse_x = e.motion.x;
                s_mouse_y = e.motion.y;
                break;
            default: break;
        }
    }
    return true;
}

void sentient_sim_sdl2_shutdown(void) {
    if (s_texture)  SDL_DestroyTexture(s_texture);
    if (s_renderer) SDL_DestroyRenderer(s_renderer);
    if (s_window)   SDL_DestroyWindow(s_window);
    SDL_Quit();
}
```

- [ ] **Step 5: Clone LVGL at the pinned version + build**

In `esp32/cube/lvgl-sim/`, clone LVGL at the version recorded in Task 4 Step 1 (substitute `<VERSION>`):

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/lvgl-sim && \
git clone --depth 1 --branch v<VERSION> https://github.com/lvgl/lvgl lvgl
```

Verify SDL2 is installed:
```bash
brew list sdl2 || brew install sdl2
```

Configure + build:
```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/lvgl-sim && \
cmake -B build -S . && \
cmake --build build -j 2>&1 | tail -25
```

Expected: build green, binary at `build/sentient_cube_lvgl_sim`.

If `find_package(SDL2)` fails, add `-DSDL2_DIR=/opt/homebrew/lib/cmake/SDL2` (Apple Silicon) or `-DSDL2_DIR=/usr/local/lib/cmake/SDL2` (Intel Mac) to the cmake configure command. Note the working command in the README (Task 7).

- [ ] **Step 6: Commit (LVGL clone is gitignored — it does NOT enter the commit)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git status --short && \
git add esp32/cube/lvgl-sim/CMakeLists.txt esp32/cube/lvgl-sim/main esp32/cube/lvgl-sim/.gitignore esp32/cube/.gitignore && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/lvgl-sim): stand up SDL2 host LVGL simulator

Adapts the lv_port_pc_vscode template into esp32/cube/lvgl-sim/:
- CMakeLists.txt finds SDL2, builds LVGL from a sibling `lvgl/` clone,
  and points LVGL at firmware/main/lv_conf.h via LV_CONF_PATH so the
  device + sim use identical config.
- main/sdl2_driver.c provides minimal SDL2 display flush + mouse-as-
  touch indev glue.
- main/main.c boots LVGL, builds the shared test screen via
  sentient_test_screen_build(), and pumps SDL2 events at ~200 Hz.
- LVGL source clone and build/ dir are gitignored.

UI-iteration loop: edit ui-shared/test_screen.c → cmake --build → ./
build/sentient_cube_lvgl_sim. ~2s round-trip, no cube needed.

Per spec §7 scope guard: simulator is a UI-iteration aid only. Device
smoke is always required. A green sim run never replaces a flash.
EOF
)"
```

---

## Task 6: Smoke the host sim build (no flash)

Pure verification. No file changes, no commit. Confirms the host sim launches, shows the SDL2 window, and renders the test screen.

- [ ] **Step 1: Run the sim**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/lvgl-sim && \
./build/sentient_cube_lvgl_sim
```

Expected: an SDL2 window pops up titled "Sentient Cube — lvgl-sim", 466×466, showing:
- deep-blue background
- horizontal gradient bar centered
- "SENTIENT CUBE" label above the bar
- a spinner below the bar, rotating

Click + drag in the window — the heatmap dot appears under the cursor while the mouse button is held. (Note: the sim's mouse indev doesn't run `SentientTouchReadCb`'s event emission path — only the device does. The sim heatmap is driven by the shared `sentient_test_screen_set_touch_xy` call from a stripped indev callback that runs INSIDE the sim's read callback. If the heatmap dot does not appear in the sim, that is acceptable for Phase 2 — the touch.tap event smoke is device-only.)

- [ ] **Step 2: Take a screenshot for the handover**

While the sim window is open, use macOS Cmd+Shift+4 to capture the window region. Save to `/tmp/phase2-lvgl-sim.png` (Cmd+Shift+4 → drag → file lands on Desktop, then `mv ~/Desktop/Screen\ Shot*.png /tmp/phase2-lvgl-sim.png`).

- [ ] **Step 3: Close the sim, no commit**

Close the SDL2 window. Move on.

---

## Task 7: `lvgl-sim/README.md` — version pin + build/run + update flow

**Files:**
- Create: `esp32/cube/lvgl-sim/README.md`

**Why:** Per spec §7: "Pin version explicitly in `lvgl-sim/README.md` — record commit SHA and `lv_conf.h` version. Document `git remote add upstream && git fetch && cherry-pick`-style update flow." The README is the single source of truth for anyone (or any future agent) regenerating the sim.

- [ ] **Step 1: Create the README**

Path: `esp32/cube/lvgl-sim/README.md`

```markdown
# Sentient Cube — LVGL PC Simulator

Host (macOS/Linux) SDL2 build of the Sentient Cube UI for fast UI iteration
without flashing. Runs the same `ui-shared/test_screen.c` the device runs.

**Scope:** UI iteration only. Per Phase 2 spec §7 scope guard, this
simulator never replaces device smoke. Animation timing, `esp_lcd_panel_*`
DMA behavior, and LVGL ↔ agent_console event coupling are device-only.

## Pinned versions

| Component | Version | Source |
|---|---|---|
| LVGL | `v<VERSION>` (commit `<SHA>`) | https://github.com/lvgl/lvgl |
| `lv_conf.h` | byte-identical to `firmware/main/lv_conf.h` | this repo |
| SDL2 | system Homebrew | `brew install sdl2` |

Update the `<VERSION>` and `<SHA>` placeholders with the real values from
Phase 2 Task 4 Step 1.

## First-time setup (macOS)

```sh
# 1. SDL2 dev headers
brew install sdl2 cmake

# 2. Clone LVGL at the pinned version next to this README.
cd esp32/cube/lvgl-sim
git clone --depth 1 --branch v<VERSION> https://github.com/lvgl/lvgl lvgl

# 3. Configure + build
cmake -B build -S . \
  -DSDL2_DIR=/opt/homebrew/lib/cmake/SDL2  # Apple Silicon
  # -DSDL2_DIR=/usr/local/lib/cmake/SDL2   # Intel Mac
cmake --build build -j
```

## Run

```sh
./build/sentient_cube_lvgl_sim
```

An SDL2 window pops up. Close the window or hit Cmd+W to exit.

## Iteration loop

Edit any of:
- `../firmware/ui-shared/test_screen.c` — shared LVGL widget construction
- `../firmware/main/lv_conf.h` — LVGL config (touches the device too —
  always verify on device after such edits)

Then:
```sh
cmake --build build -j && ./build/sentient_cube_lvgl_sim
```

Round-trip is ~2 seconds. The device's smoke loop is ~30 seconds.

## Update flow (when LVGL has a new release we want to track)

The LVGL managed component on the device (`firmware/main/idf_component.yml`)
and the LVGL clone here MUST move together — otherwise `lv_conf.h` template
fields drift between the two targets.

1. Bump the LVGL version in `firmware/main/idf_component.yml`.
2. Run `idf.py reconfigure` once to fetch the new managed component into
   `firmware/managed_components/lvgl__lvgl/`.
3. Re-copy `firmware/managed_components/lvgl__lvgl/lv_conf_template.h` over
   `firmware/main/lv_conf.h`. Apply any local diffs in the header comment
   block; flip `#if 0` to `#if 1` again.
4. Bump the version pin + SHA in this README's "Pinned versions" table.
5. Re-clone the sibling `lvgl/` directory at the new tag:
   ```sh
   cd esp32/cube/lvgl-sim
   rm -rf lvgl
   git clone --depth 1 --branch v<NEW-VERSION> https://github.com/lvgl/lvgl lvgl
   ```
6. Run the device + sim smoke from the Phase 2 handover.
7. Commit firmware/main/lv_conf.h + firmware/main/idf_component.yml +
   firmware/dependencies.lock + lvgl-sim/README.md as one commit titled
   `chore(esp32-cube/lvgl): bump LVGL to v<NEW-VERSION>`.

## What this sim does NOT do

Per spec §7:
- No `esp_lcd_panel_draw_bitmap` async-done callback timing.
- No LVGL display-lock contention with agent_console event-emit path.
- No real DMA refresh / tearing behavior.
- No `agent_console_event` emission on tap — that's device-only.

If a UI bug only appears in one of these axes, the sim WILL look fine
while the device is broken. Always device-smoke before declaring done.

## Troubleshooting

- **`fatal error: 'SDL.h' file not found`** — SDL2 dev headers are missing.
  `brew install sdl2`.
- **`could NOT find SDL2`** — Add `-DSDL2_DIR=/opt/homebrew/lib/cmake/SDL2`
  to `cmake -B build` (Apple Silicon) or `/usr/local/...` (Intel).
- **Blank black window** — `lv_display_flush_ready` was probably not called.
  Check `main/sdl2_driver.c` `flush_cb`.
- **`LVGL source not found at .../lvgl`** — Step 2 of "First-time setup"
  was skipped. Clone the pinned LVGL tag.
- **`Sentient owned lv_conf.h not found`** — Run Phase 2 Task 4 first.
```

Substitute every `<VERSION>` and `<SHA>` with the real values from Task 4 Step 1.

- [ ] **Step 2: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/lvgl-sim/README.md && \
git commit -m "$(cat <<'EOF'
docs(esp32-cube/lvgl-sim): README — version pin + setup + update flow

Records the LVGL version + commit SHA the sim is pinned to (matches
firmware/main/lv_conf.h). Documents the first-time setup (brew install
sdl2, git clone --depth 1 --branch v<X>, cmake build), the ~2s
iteration loop, the LVGL-bump update flow that keeps device + sim in
lockstep, and the troubleshooting matrix for common SDL2 + path issues.

Per spec §7 scope guard, the "what this sim does NOT do" section is
prominent — device smoke is mandatory.
EOF
)"
```

---

## Task 8: Single-flash bundled device smoke

**Files:**
- None modified
- Smoke evidence: `/tmp/phase2-*` (referenced by Task 10 handover)

**Why:** All Tasks 1–7 verified by build + host sim only. This task flashes the post-change image to the cube ONCE, runs the Phase 2 smoke bar from spec §4:

1. `cube-cmd ui.snapshot --output /tmp/p2.png` → PNG shows test screen.
2. `cube-cmd events --tail 30` after manual finger tap → at least one `touch.tap` event with sane x/y.
3. LVGL 1–2 Hz spinner visible in two snapshots taken 500ms apart.

(The host-sim parity case from spec §4 was already run in Task 6.)

Pre-flight gate before flashing:
- Working tree clean.
- `idf.py build` green on current HEAD.
- Daemon alive: `ls /tmp/cube-daemon.sock`.
- `bash scripts/cube-cmd.sh state` returns valid JSON.

If any gate fails, stop and fix. Do NOT flash a wedged cube.

- [ ] **Step 1: Pre-flight gate check**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git status --short && \
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: clean tree. `cube-cmd state` returns `{"state":"IDLE","wifi_connected":true,"ws_connected":true,...}`.

- [ ] **Step 2: Flash**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py -p /dev/cu.usbmodem101 flash 2>&1 | tail -30' | tee /tmp/phase2-flash.log
```

Expected: ends with `Hard resetting via RTS pin...`. If `esptool` reports "Failed to connect", kill the daemon (`rm -f /tmp/cube-daemon.sock /tmp/cube-daemon.pid; pkill -f _cube_daemon`) and retry. **One retry allowed.** A third failure = AXP2101 fault; stop and recover physically per `.claude/rules/esp32/cube/flash-discipline.md`.

- [ ] **Step 3: Wait for cold boot + verify state**

```bash
sleep 10
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: `IDLE` + wifi/ws connected within ~10s.

- [ ] **Step 4: ui.snapshot smoke**

```bash
bash esp32/cube/scripts/cube-snapshot.sh /tmp/phase2-screen-1.png
```

(If `cube-snapshot.sh` does not yet wrap `ui.snapshot` into a PNG, use the longer form referenced in `.claude/rules/esp32/cube/testing.md`. Confirm path by `head esp32/cube/scripts/cube-snapshot.sh`.)

Expected: `/tmp/phase2-screen-1.png` exists, is a valid PNG, shows:
- deep blue background
- gradient bar mid-screen
- "SENTIENT CUBE" label
- spinner

Visual inspect via `open /tmp/phase2-screen-1.png` (macOS).

If the screen still shows the toggle button or the xiaozhi chat face: Task 2 boot-UI swap did not flash correctly — re-verify `sentient_cube_show_test_screen()` is the call in `CustomLcdDisplay::SetupUI()`, rebuild, and ONE more flash is allowed.

- [ ] **Step 5: Spinner-motion smoke (two snapshots 500ms apart)**

```bash
bash esp32/cube/scripts/cube-snapshot.sh /tmp/phase2-screen-a.png && \
sleep 0.5 && \
bash esp32/cube/scripts/cube-snapshot.sh /tmp/phase2-screen-b.png
```

Compare visually: `open /tmp/phase2-screen-a.png /tmp/phase2-screen-b.png`. The spinner should be at clearly different angular positions in the two captures. If both snapshots show an identical spinner angle, LVGL's tick / animation engine isn't being driven — check `lvgl_port_lock` patterns; this is rare on a Phase 1-stable tree.

- [ ] **Step 6: touch.tap event smoke**

Tap the cube's screen with a finger (physical, single quick tap), then:

```bash
bash esp32/cube/scripts/cube-cmd.sh events '{"tail": 30}'
```

Expected: at least one event line containing `"event":"touch.tap"` with `"x":N` and `"y":N` in a plausible range (0 ≤ x ≤ 465, 0 ≤ y ≤ 465 for the 466×466 panel).

If multiple `touch.tap` events appear for one physical tap, the LVGL indev poll rate is too high and the FSM is mis-firing — investigate `s_was_pressed_last_tick` state. Fix inside Task 8 and one re-flash is allowed.

If zero `touch.tap` events appear after a clear physical tap:
1. Run `cube-cmd events '{"tail": 60}'` to view broader history.
2. Look for `>>> EVT` lines — if none, `agent_console_event` is not being called; investigate `SentientTouchReadCb` registration.
3. Look for `_reader_exc_` lines from the daemon — if present, daemon is dropping bytes (Phase 1 rapid-CMD glitch unrelated to taps; not fatal).

Record verbatim: the matching event line. Goes into the Phase 2 handover.

- [ ] **Step 7: Record smoke results**

Create `/tmp/phase2-smoke-record.txt` with:

```
PHASE 2 DEVICE SMOKE:
- flash result: ✅ / ❌
- cube-cmd state after boot: <returned JSON>
- ui.snapshot screen 1 → /tmp/phase2-screen-1.png — visual: <PASS/FAIL + reason>
- ui.snapshot screens a,b → spinner moved: <YES/NO>
- touch.tap event captured: ✅ <quoted EVT line>  / ❌
- flashes used: <n> (≤ 4 budget)
- AXP2101 faults: <n>
- daemon restarts: <n>
- cold physical recoveries: <n>

HOST SIM SMOKE (Task 6):
- sim ran: ✅ / ❌
- sim screenshot → /tmp/phase2-lvgl-sim.png — visual: <PASS/FAIL>
- visual parity with device: <YES/NO + notes>
```

- [ ] **Step 8: No commit — smoke artifacts are not source**

---

## Task 9: (intentionally blank — kept for plan symmetry with five-task batches)

This slot was reserved during planning for an extra contingency task (typically the rapid-CMD parse-error investigation from spec §6 known-follow-ups). Phase 1's parse-error finding is unrelated to Phase 2 work — if it recurs during Task 8 smoke, fix it inline; otherwise skip. No file changes.

- [ ] **Step 1: No-op. Move on to Task 10.**

---

## Task 10: Phase 2 handover doc

**Files:**
- Create: `docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md`

**Why:** Per spec §5, every phase MUST end with a handover doc with the seven mandatory sections. This is the gate before Phase 3 (Speaker).

- [ ] **Step 1: Create the file with full skeleton**

Path: `docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md`

```markdown
# ESP32 Cube Phase 2 — Display + Touch + LVGL PC Simulator Handover

**Date:** 2026-05-12
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase2-display-touch.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §4 Phase 2 + §7

## What's done

- Added `esp32/cube/firmware/ui-shared/test_screen.{c,h}` — target-agnostic LVGL screen module: deep-blue bg, horizontal gradient bar, "SENTIENT CUBE" label, 1.5 Hz spinner, hideable touch heatmap dot. Compiles into both the device build (via `main/CMakeLists.txt`) and the host SDL2 sim.
- Replaced Phase 1's boot UI (`sentient_cube_create_toggle_button_screen()`) with `sentient_cube_show_test_screen()` in `CustomLcdDisplay::SetupUI()`. Toggle-button module stays in the tree; Phase 6 (Sentient Connect) restores it as the boot UI.
- Added `SentientTouchReadCb` in `sentient_cube.cc` — wraps Phase 1's `SafeTouchReadCb` with a press→release FSM that emits `<<< EVT {"event":"touch.tap","x":N,"y":N,"ts_us":N}` exactly once per physical tap. Drives the test-screen heatmap dot for visual cross-check. `SafeTouchReadCb` itself unchanged.
- Owned `firmware/main/lv_conf.h` — copied from the LVGL managed-component template at the pinned version, activation guard flipped to `#if 1`, version + SHA recorded in the file header. Managed LVGL component now resolves the owned header via `LV_CONF_INCLUDE_SIMPLE` + main/ on the include path. Host sim points at the same header via `LV_CONF_PATH`.
- Stood up `esp32/cube/lvgl-sim/` — SDL2 host build (`lv_port_pc_vscode` template adapted): CMakeLists, main.c, sdl2_driver.c, .gitignore, version-pinned README documenting setup, run, iteration loop, LVGL-bump update flow, and `what this sim does NOT do`.
- Bundled device smoke (single flash) verified: cube boots into test screen; ui.snapshot returns expected PNG; two snapshots 500 ms apart show spinner motion; physical finger tap produces one `touch.tap` event with sane x/y. Host sim renders byte-identical layout.

## What's used (stack the user now owns)

| Path | Responsibility |
|---|---|
| `esp32/cube/firmware/ui-shared/test_screen.{c,h}` | Target-agnostic LVGL screen module. Shared between device + sim. |
| `esp32/cube/firmware/main/lv_conf.h` | Owned LVGL config. Source of truth for device + sim parity. |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.{cc,h}` | + `sentient_cube_show_test_screen()` C entry; existing toggle-button + state APIs unchanged. |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | `SentientTouchReadCb` (tap detector) registered as the LVGL indev callback. `SafeTouchReadCb` unchanged. |
| `esp32/cube/lvgl-sim/` | Host SDL2 simulator project. Iteration loop ~2s. |
| `esp32/cube/lvgl-sim/README.md` | Version pin (LVGL `v<VER>` SHA `<X>`), setup, run, update flow, scope guard. |

Verb surface unchanged (`state`, `mark`, `events`, `audio.inject_pcm`, `tts.cancel`, `ui.dump_tree`, `ui.snapshot`, `log_level`, `wifi.*`, `ws.*`, `button.*`, `restart`). New EVT type only: `touch.tap` (emitted by the device on physical tap; not invoked by the sim).

## What's smoked

- **build (device)**: green at every task commit boundary → ✅
- **build (sim)**: `cmake --build build` green; binary at `lvgl-sim/build/sentient_cube_lvgl_sim` → ✅
- **flash**: single attempt → ✅ (record: <n> flashes total)
- **boot**: clean cold boot, test screen visible on cube → ✅
- **ui.snapshot**: `/tmp/phase2-screen-1.png` shows test screen as designed → ✅
- **spinner motion**: `/tmp/phase2-screen-a.png` vs `/tmp/phase2-screen-b.png` (500 ms apart) show distinct spinner angles → ✅
- **touch.tap event**: physical tap → events --tail returned `<verbatim EVT line>` → ✅
- **host sim parity**: SDL2 window matches device layout (`/tmp/phase2-lvgl-sim.png` vs `/tmp/phase2-screen-1.png`) → ✅

Evidence:
- `/tmp/phase2-smoke-record.txt`
- `/tmp/phase2-flash.log`
- `/tmp/phase2-screen-1.png`, `/tmp/phase2-screen-a.png`, `/tmp/phase2-screen-b.png`
- `/tmp/phase2-lvgl-sim.png`

## What you need to know

1. **`firmware/main/lv_conf.h` is now the LVGL config source of truth.** Device + sim both read it. Bumping the LVGL managed component without re-copying this header from the new template will silently desync the two builds. The Update-flow section of `lvgl-sim/README.md` is mandatory reading before any LVGL version bump.

2. **`SentientTouchReadCb` layered on top of `SafeTouchReadCb`.** Phase 1's safe-read callback is still the raw LVGL indev read function; the new wrapper calls it first then runs the tap FSM. If you need to disable the tap event (e.g. during a future state-machine cleanup), re-point `lv_indev_set_read_cb` back to `SafeTouchReadCb` directly. Do NOT modify `SafeTouchReadCb`'s body — it is the I²C transient-fault tolerance layer from Phase 1.

3. **Boot UI is the test screen now, not the toggle button.** This is Phase-2-through-Phase-5 default. Phase 6 (Sentient Connect) flips back to `sentient_cube_create_toggle_button_screen()` in `CustomLcdDisplay::SetupUI()`. Both screens stay in the tree.

4. **The host sim does NOT emit `<<< EVT touch.tap`.** Its mouse indev only feeds LVGL — the tap-detector wrapper is device-only. If a future verb verifies tap behavior, the host sim is not a substitute.

5. **`ui.snapshot` parse-error follow-up.** Spec §6 flags an intermittent RPC parse-error in the chunked-EVT path; this phase did not exercise it heavily. If it recurs during Phase 3+, treat as a Phase 2 follow-up (line-truncation likely in the `<<< EVT` emit path under load).

## Hardware glossary (terms new this phase)

- **SDL2**: Simple DirectMedia Layer 2. Cross-platform graphics/input library; the host sim uses it to draw a 466×466 window and read mouse input as a touch substitute. Installed via Homebrew (`brew install sdl2`).
- **lv_conf.h**: LVGL's master configuration header. Controls memory pool sizes, enabled widgets, color formats, feature flags. Owning ours instead of Kconfig-generating it is what makes the device + sim builds byte-identical.
- **LV_CONF_INCLUDE_SIMPLE / LV_CONF_PATH**: LVGL preprocessor macros that change how the library finds its config header. Simple = "find lv_conf.h on the include path"; PATH = "load lv_conf.h from this exact filesystem path" (used by the host sim).
- **indev (LVGL)**: short for "input device." LVGL's abstraction for mouse / touch / encoder input. Each indev has a read callback that LVGL polls at the configured tick rate.

(Phase 1 glossary still applies: AMOLED, AXP2101, USB-Serial-JTAG, QSPI, PowerSaveTimer, I²C.)

## Open questions / risks

- **`ui.snapshot` chunked EVT parse-error** — see "What you need to know" item 5. Not blocking Phase 3 but should be investigated if it recurs.
- **Mixed-language font coverage.** The user plans zh + en native + fr/pt-mixed rendering for future learning-mode UI. xiaozhi's default LVGL font (Montserrat 14 + Noto Sans CJK) covers most of this but not all combining diacritics. Verify glyph coverage in Phase 3 if test screen needs localized strings.
- **No new hardware risks introduced this phase.** All work is additive on a Phase 1-stable tree.

## Flash + smoke metrics

- Flashes this phase: <n> (budget ≤ 4)
- AXP2101 faults hit: <n>
- Daemon restarts: <n>
- Cold physical recoveries: <n>
- Total dev time on smoke: ~<approx> hours
- Host sim iteration round-trip measured: ~<n> seconds (edit → build → run)
```

Fill `<n>` / `<X>` / `<VER>` slots from `/tmp/phase2-smoke-record.txt` and Task 4 Step 1's recorded LVGL version.

- [ ] **Step 2: Commit the handover**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md && \
git commit -m "$(cat <<'EOF'
docs(esp32-cube): Phase 2 display + touch + lvgl-sim handover

Final commit of Phase 2. Documents:
- ui-shared/test_screen module (target-agnostic LVGL widget code)
- Boot UI swap (test screen for Phase 2..5; toggle returns in Phase 6)
- SentientTouchReadCb tap-detector + touch.tap EVT
- Owned firmware/main/lv_conf.h (LVGL config source of truth)
- esp32/cube/lvgl-sim/ host SDL2 simulator
- Single-flash device smoke + host sim parity check

Phase 3 (Speaker, was original-spec Phase 3) is next.
EOF
)"
```

- [ ] **Step 3: Post the handover content to chat for user review**

After the commit lands, paste the full handover doc contents into the user's chat for review. Do NOT merge `feature/esp32-cube-v2-rescope` to `develop` — the feature branch continues through Phase 6 per spec §4.

---

## Self-Review Checklist

- **Spec coverage:** Spec §4 Phase 2 smoke bar items mapped: (1) `cube-cmd ui.snapshot` → Task 8 Step 4. (2) `cube-cmd events --tail` after manual tap → Task 8 Step 6. (3) 1–2 Hz spinner in two snapshots 500 ms apart → Task 8 Step 5. (4) Host `lvgl-sim` SDL2 layout parity → Task 6. Spec §7 deliverables: `lvgl-sim/` host build (Task 5), pinned LVGL version + commit SHA in README (Task 7), `lv_conf.h` shared between targets (Task 4), portable LVGL code in shared dir (Task 1), per-target `disp_drv` / `indev_drv` glue (host: Task 5; device: Phase 1's `SafeTouchReadCb` + Phase 2's `SentientTouchReadCb`). Spec §6 known-follow-up `ui.snapshot` parse-error called out in handover "open questions" + Task 9 contingency.
- **Placeholder scan:** No "TBD" / "implement later". `<VERSION>` / `<SHA>` / `<n>` / `<X>` slots are explicit template variables filled from recorded baselines (Task 4 Step 1, Task 8 Step 7).
- **Type / path consistency:** `sentient_test_screen_build()` consistent across header, .c, sim main, sentient_ui_controller.cc. `sentient_test_screen_set_touch_xy()` same. `SentientTouchReadCb` always capitalized that way. `firmware/ui-shared/` not `ui-shared/firmware/`. `lvgl-sim/main/sdl2_driver.{c,h}` both files exist. `agent_console_event` signature matches the public API in `components/agent_console/include/agent_console.h`.
- **Flash discipline:** Budget ≤ 4. Tasks 1–7 build-only. Task 8 single flash + one allowed retry. No exploratory flashes.
- **One-commit-per-task:** Tasks 6 + 8 + 9 explicit "no commit" (observational / no-op). Every other task = one commit. Total: 8 commits.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase2-display-touch.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, spec + code-quality review between tasks.

**2. Inline Execution** — execute tasks in this session via executing-plans.

Which approach?
