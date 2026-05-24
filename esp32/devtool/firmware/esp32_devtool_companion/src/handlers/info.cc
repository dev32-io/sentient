#include <cJSON.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <cstring>

#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.info";

// Helper: append a string field, defaulting to empty when nullptr.
static void add_str(cJSON* obj, const char* key, const char* val) {
    cJSON_AddStringToObject(obj, key, val ? val : "");
}

static esp_err_t info_get_handler(httpd_req_t* req) {
    esp32_devtool_info_t info = {};
    ESP_LOGD(TAG, "GET /info");
    if (esp32_devtool_get_info(&info) != 0) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"info_provider_unset\"}");
        return ESP_OK;
    }
    cJSON* j = cJSON_CreateObject();
    add_str(j, "device_id", info.device_id);
    add_str(j, "board", info.board);
    add_str(j, "chip", info.chip);
    add_str(j, "ip", info.ip);
    add_str(j, "mac", info.mac);
    add_str(j, "firmware", info.firmware);
    add_str(j, "build_profile", info.build_profile);
    cJSON_AddNumberToObject(j, "uptime_s", info.uptime_s);
    add_str(j, "wifi_ssid", info.wifi_ssid);
    cJSON_AddNumberToObject(j, "wifi_rssi", info.wifi_rssi);
    cJSON* caps = cJSON_AddArrayToObject(j, "capabilities");
#ifdef CONFIG_ESP32_DEVTOOL_SCREENSHOT_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("screenshot"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_TOUCH_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("touch"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_AUDIO_RECORD_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("audio_record"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_AUDIO_INJECT_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("audio_inject"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("log_relay"));
#endif
    cJSON* endpoints = cJSON_AddObjectToObject(j, "endpoints");
    cJSON_AddStringToObject(endpoints, "screenshot", "/screenshot");
    cJSON_AddStringToObject(endpoints, "touch", "/touch");
    cJSON_AddStringToObject(endpoints, "audio_record", "/audio/record");
    cJSON_AddStringToObject(endpoints, "audio_inject", "/audio/inject");
    cJSON_AddStringToObject(j, "contract_version", "1.0");

    char* body = cJSON_PrintUnformatted(j);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "X-Devtool-Version", "0.1.0");
    httpd_resp_sendstr(req, body);
    cJSON_free(body);
    cJSON_Delete(j);
    return ESP_OK;
}

__attribute__((constructor))
static void register_info_route() {
    devtool_register_http("GET", "/info", info_get_handler);
}
