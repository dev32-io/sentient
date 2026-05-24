// SPDX-License-Identifier: MIT
// devtool_verbs/wifi.cc — wifi.disconnect + wifi.connect + wifi.reconnect.
//
// Uses esp_wifi C API directly; doesn't reach into Application state.
// Migrated from components/agent_console/verbs/wifi.cc in Task 24.
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include <esp_log.h>
#include <esp_wifi.h>

namespace {

constexpr const char* TAG = "sentient.cube.devtool.wifi";

int handle_wifi_disconnect(const cJSON* /*params*/, cJSON* out_result,
                           int* ec, const char** em) {
    esp_err_t err = esp_wifi_disconnect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_NOT_STARTED) {
        ESP_LOGW(TAG, "disconnect err=0x%x", err);
        *ec = -32603;
        *em = "wifi disconnect failed";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

int handle_wifi_connect(const cJSON* /*params*/, cJSON* out_result,
                        int* ec, const char** em) {
    esp_err_t err = esp_wifi_connect();
    ESP_LOGI(TAG, "connect err=0x%x", err);
    // Tolerate only truly-transient async states. Real config errors
    // (ESP_ERR_WIFI_SSID = no AP in range, ESP_ERR_WIFI_PASSWORD = bad PSK)
    // MUST surface — masking them hides cred bugs:
    //   NOT_CONNECT: station still mid-disconnect (transient)
    //   CONN:        internal control block busy (transient retry)
    if (err != ESP_OK &&
        err != ESP_ERR_WIFI_NOT_CONNECT &&
        err != ESP_ERR_WIFI_CONN) {
        *ec = -32603;
        *em = "wifi connect failed";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

int handle_wifi_reconnect(const cJSON* /*params*/, cJSON* out_result,
                          int* ec, const char** em) {
    esp_err_t disc_err = esp_wifi_disconnect();
    if (disc_err != ESP_OK &&
        disc_err != ESP_ERR_WIFI_NOT_STARTED &&
        disc_err != ESP_ERR_WIFI_NOT_CONNECT) {
        ESP_LOGW(TAG, "reconnect: disconnect phase err=0x%x", disc_err);
        *ec = -32603;
        *em = "wifi reconnect failed";
        return 1;
    }
    esp_err_t conn_err = esp_wifi_connect();
    ESP_LOGI(TAG, "reconnect: connect phase err=0x%x", conn_err);
    if (conn_err != ESP_OK &&
        conn_err != ESP_ERR_WIFI_NOT_CONNECT &&
        conn_err != ESP_ERR_WIFI_CONN) {
        *ec = -32603;
        *em = "wifi reconnect failed";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_wifi_verbs(void) {
    devtool_register_verb("wifi.disconnect", handle_wifi_disconnect);
    devtool_register_verb("wifi.connect",    handle_wifi_connect);
    devtool_register_verb("wifi.reconnect",  handle_wifi_reconnect);
}

}  // namespace
