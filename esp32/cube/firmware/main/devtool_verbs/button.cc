// SPDX-License-Identifier: MIT
// devtool_verbs/button.cc — button.toggle verb for esp32-devtool.
//
// Defers to cube_button_toggle(), a shim defined in sentient_cube.cc that
// calls Application::ToggleChatState() without agent_console pulling `main`
// into its REQUIRES.
//
// Result shape: { ok: true }
// Caller can re-query state via the `state` verb to see the new state.
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"

extern "C" void cube_button_toggle(void);

namespace {

int button_toggle_handler(const cJSON* /*params*/, cJSON* out,
                          int* /*ec*/, const char** /*em*/) {
    cube_button_toggle();
    cJSON_AddBoolToObject(out, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_button_toggle_verb() {
    devtool_register_verb("button.toggle", button_toggle_handler);
}

}  // namespace
