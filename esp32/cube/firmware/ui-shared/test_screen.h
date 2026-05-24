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
