// SPDX-License-Identifier: MIT
// sentient_ui_controller.h
//
// Cube presentation input boundary; shared views live in ui-shared/cube_views.
// No LVGL headers leak into application and touch/board callers.
#pragma once
#include <stdbool.h>

#ifdef __cplusplus
#include "cube_presentation.h"
inline constexpr char kCubeUiTaskName[] = "cube-ui-poll";
extern "C" {
#endif

// Creates asset-independent BootView and sets it as active LVGL screen.
// Idempotent: subsequent calls retain the same widgets.
// Also starts the background device-state polling task (once only).
void sentient_cube_create_toggle_button_screen(void);
// Call after platform pack/font readiness. False stays in controlled BootView.
void sentient_cube_finish_boot(bool assets_ready);

// Project real events onto the character screen under LVGL port lock.
void sentient_cube_set_wifi(bool connected);
void sentient_cube_set_processing(bool processing);
void sentient_cube_set_playback(bool playing);
void sentient_cube_set_sleep(bool asleep);
void sentient_cube_show_volume(int percent);
void sentient_cube_set_battery(bool charging, bool low);
void sentient_cube_set_battery_level(int percent);


// Optional diagnostic screen. Cancels shipping view input and animation;
// projector restores shipping view on its next poll. Acquires LVGL mutex.
void sentient_cube_show_test_screen(void);

#ifdef __cplusplus
}
#endif
