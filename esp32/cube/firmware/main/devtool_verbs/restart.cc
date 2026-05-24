// SPDX-License-Identifier: MIT
// devtool_verbs/restart.cc — soft reboot via esp_restart().
//
// Migrated from components/agent_console/verbs/restart.cc in Task 24.
//
// Result shape: { ok: true } — but caller actually sees the RSP, then a
// USB-CDC re-enumeration as the cube reboots.
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include <cstdio>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace {

int handle_restart(const cJSON* /*params*/, cJSON* out_result,
                   int* /*ec*/, const char** /*em*/) {
    cJSON_AddBoolToObject(out_result, "ok", true);
    // Caller will see the RSP, then a USB-CDC re-enumeration after restart.
    // Flush stdout + give it ~50ms to drain over the USB CDC channel.
    std::fflush(stdout);
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_restart();
    return 0;  // unreachable
}

__attribute__((constructor))
static void register_restart_verb(void) {
    devtool_register_verb("restart", handle_restart);
}

}  // namespace
