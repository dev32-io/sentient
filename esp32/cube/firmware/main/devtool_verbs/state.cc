// SPDX-License-Identifier: MIT
// devtool_verbs/state.cc — read-only device-state snapshot for esp32-devtool.
//
// Result shape:
//   { state: <string>, ws_connected: bool, wifi_connected: bool,
//     cycle_id: null, ip: <string> }
//
// The `ip` field enables auto-discovery: cli/transport/http.py calls this verb
// to resolve the cube's HTTP base URL without requiring --http on every invocation.
//
// Registered via __attribute__((constructor)) static-init. WHOLE_ARCHIVE on the
// main component prevents the linker from stripping this constructor.
//
// Does NOT include agent_console.h — the extern "C" shims below are declared
// directly here to avoid pulling in agent_console component headers (which would
// re-introduce the agent_console → main dependency cycle in the other direction).
// The shims are defined in sentient_cube.cc.

#include "esp32_devtool/verbs.h"
#include <cstring>
#include <esp_wifi.h>

extern "C" const char* cube_device_state_str(void);
extern "C" bool cube_ws_connected(void);
extern "C" const char* cube_ip_str(void);

namespace {

int state_handler(const cJSON* /*params*/, cJSON* out, int* /*ec*/, const char** /*em*/) {
    const char* s = cube_device_state_str();
    cJSON_AddStringToObject(out, "state", s != nullptr ? s : "UNKNOWN");

    wifi_ap_record_t ap_rec;
    bool wifi_ok = (esp_wifi_sta_get_ap_info(&ap_rec) == ESP_OK);
    cJSON_AddBoolToObject(out, "wifi_connected", wifi_ok);

    cJSON_AddBoolToObject(out, "ws_connected", cube_ws_connected());
    cJSON_AddNullToObject(out, "cycle_id");

    const char* ip = cube_ip_str();
    cJSON_AddStringToObject(out, "ip", ip != nullptr ? ip : "");
    return 0;
}

__attribute__((constructor))
static void register_state_verb() {
    devtool_register_verb("state", state_handler);
}

}  // namespace
