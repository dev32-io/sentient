// SPDX-License-Identifier: MIT
// sentient_ui_controller.h
//
// Cube UI state machine, exposed as a C-callable API so sentient_cube.cc and
// other xiaozhi C/C++ code can drive it without including LVGL headers
// directly. Real widget creation is delegated to toggle_button_screen.cc
// (Task 3.2) via forward-declared C linkage functions.
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SENTIENT_UI_DISABLED = 0,  // startup / connecting / speaking — button inactive
    SENTIENT_UI_READY,         // WS connected, mic off — button interactive
    SENTIENT_UI_LISTENING,     // mic live — button shows listening animation
} sentient_ui_state_t;

// Creates the toggle-button screen and sets it as the active LVGL screen.
// Idempotent: subsequent calls re-bind the same widgets.
// Also starts the background device-state polling task (once only).
void sentient_cube_create_toggle_button_screen(void);

// Updates the visual state of the toggle button. Safe to call from any task
// (internally schedules the LVGL update on the LVGL task).
void sentient_cube_set_state(sentient_ui_state_t state);

// Sets the small status hint label above the button. Empty string hides it.
void sentient_cube_set_status_hint(const char* text);

// Sets the transcript label below the button. Empty string hides it.
// Phase 6a smoke aid — surfaces the latest STT transcript so the operator can
// see what the gateway heard while iterating on toggle-to-talk turns.
void sentient_cube_set_transcript(const char* text);

// Builds the Phase 2 test screen on the active LVGL screen. Idempotent:
// repeat calls clean and rebuild. Caller must hold the LVGL mutex.
//
// Used as the boot UI for Phase 2..5. Phase 6 restores
// sentient_cube_create_toggle_button_screen as the boot UI.
void sentient_cube_show_test_screen(void);

#ifdef __cplusplus
}
#endif
