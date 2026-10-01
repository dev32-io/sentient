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
#include "sdkconfig.h"
#include <cstring>
#include <esp_wifi.h>
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
#include "boards/sentient-cube/cube_hardware.h"
#include "boards/sentient-cube/sentient_ui_controller.h"
#endif
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE && !CONFIG_SENTIENT_PROD_BUILD
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#endif

extern "C" const char* cube_device_state_str(void);
extern "C" bool cube_ws_connected(void);
extern "C" const char* cube_ip_str(void);

namespace {

int state_handler(const cJSON* /*params*/, cJSON* out, int* /*ec*/, const char** /*em*/) {
    const char* s = cube_device_state_str();
    cJSON_AddStringToObject(out, "state", s != nullptr ? s : "UNKNOWN");

    wifi_ap_record_t ap_rec;
    bool wifi_ok = false;
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    if (sentient::cube::CubeHardware::Get().WifiConnected())
#endif
        wifi_ok = esp_wifi_sta_get_ap_info(&ap_rec) == ESP_OK;
    cJSON_AddBoolToObject(out, "wifi_connected", wifi_ok);

    cJSON_AddBoolToObject(out, "ws_connected", cube_ws_connected());
    cJSON_AddNullToObject(out, "cycle_id");

    const char* ip = cube_ip_str();
    cJSON_AddStringToObject(out, "ip", ip != nullptr ? ip : "");
    return 0;
}

#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE && !CONFIG_SENTIENT_PROD_BUILD
int hardware_status_handler(const cJSON* /*params*/, cJSON* out, int* /*ec*/, const char** /*em*/) {
    const auto status = sentient::cube::CubeHardware::Get().Status();
    cJSON_AddStringToObject(out, "phase", status.phase);
    cJSON_AddBoolToObject(out, "fatal", status.fatal);
    cJSON_AddStringToObject(out, "lastError", status.last_error.c_str());
    cJSON_AddBoolToObject(out, "accountAttention", status.account_attention);
    cJSON_AddBoolToObject(out, "bleActive", status.ble_active);
    cJSON_AddBoolToObject(out, "bleConnected", status.ble_connected);
    cJSON_AddBoolToObject(out, "bleAuthenticated", status.ble_authenticated);
    cJSON_AddStringToObject(out, "wifiState", status.wifi_state);
    cJSON_AddBoolToObject(out, "wifiConnected", status.wifi_connected);
    cJSON_AddBoolToObject(out, "gatewayReady", status.gateway_ready);
    cJSON_AddStringToObject(out, "wsStartPhase", status.ws_start_phase);
    cJSON_AddNumberToObject(out, "wsStartError", status.ws_start_error);
    cJSON_AddBoolToObject(out, "wsWorkerPresent", xTaskGetHandle("sentient_ws") != nullptr);
    cJSON_AddBoolToObject(out, "wsTransportTaskPresent", xTaskGetHandle("websocket_task") != nullptr);
    if (auto task = xTaskGetHandle("opus_codec"))
        cJSON_AddNumberToObject(out, "opusStackUnusedBytes", uxTaskGetStackHighWaterMark(task));
    cJSON_AddStringToObject(out, "httpPhase", status.http.phase);
    cJSON_AddNumberToObject(out, "httpStatus", status.http.http_status);
    cJSON_AddNumberToObject(out, "httpErrorCode", status.http.error_code);
    cJSON_AddBoolToObject(out, "httpTimedOut", status.http.timed_out);
    cJSON_AddNumberToObject(out, "httpTlsError", status.http.tls_error);
    cJSON_AddNumberToObject(out, "httpTlsCode", status.http.tls_code);
    cJSON_AddNumberToObject(out, "httpTlsFlags", status.http.tls_flags);
    cJSON_AddNumberToObject(out, "httpSocketErrno", status.http.socket_errno);
    cJSON_AddNumberToObject(out, "httpSentBytes", status.http.sent_bytes);
    cJSON_AddNumberToObject(out, "httpReceivedBytes", status.http.received_bytes);
    cJSON_AddNumberToObject(out, "httpBodyBytes", status.http.body_bytes);
    cJSON_AddNumberToObject(out, "httpElapsedMs", status.http.elapsed_ms);
    cJSON_AddNumberToObject(out, "httpInternalFreeBytes", status.http.internal_free_bytes);
    cJSON_AddNumberToObject(out, "httpInternalLargestBlockBytes", status.http.internal_largest_bytes);
    cJSON_AddNumberToObject(out, "httpPsramFreeBytes", status.http.psram_free_bytes);
    constexpr uint32_t internal = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    cJSON_AddNumberToObject(out, "internalFreeBytes", heap_caps_get_free_size(internal));
    cJSON_AddNumberToObject(out, "internalMinFreeBytes", heap_caps_get_minimum_free_size(internal));
    cJSON_AddNumberToObject(out, "internalLargestBlockBytes", heap_caps_get_largest_free_block(internal));
    constexpr uint32_t dma = MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA | MALLOC_CAP_8BIT;
    cJSON_AddNumberToObject(out, "dmaFreeBytes", heap_caps_get_free_size(dma));
    cJSON_AddNumberToObject(out, "dmaMinFreeBytes", heap_caps_get_minimum_free_size(dma));
    cJSON_AddNumberToObject(out, "dmaLargestBlockBytes", heap_caps_get_largest_free_block(dma));
    cJSON_AddNumberToObject(out, "psramFreeBytes", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(out, "psramMinFreeBytes", heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(out, "psramLargestBlockBytes", heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
    if (auto task = xTaskGetHandle(kCubeUiTaskName))
        cJSON_AddNumberToObject(out, "uiStackUnusedBytes", uxTaskGetStackHighWaterMark(task));
    cJSON_AddNumberToObject(out, "taskCount", uxTaskGetNumberOfTasks());
    if (auto task = xTaskGetHandle("cube-hardware"))
        cJSON_AddNumberToObject(out, "hardwareStackUnusedBytes", uxTaskGetStackHighWaterMark(task));
    return 0;
}
#endif

__attribute__((constructor))
static void register_state_verb() {
    devtool_register_verb("state", state_handler);
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE && !CONFIG_SENTIENT_PROD_BUILD
    devtool_register_verb("cube.hardware.status", hardware_status_handler);
#endif
}

}  // namespace
