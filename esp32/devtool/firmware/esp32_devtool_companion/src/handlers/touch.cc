#include <cJSON.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <algorithm>
#include <cstring>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.touch";

// Default hold duration when client omits "hold_ms". 60 ms covers ~12 LVGL
// ticks at our 5 ms tick period — enough for at least one PRESSED tick + one
// RELEASED tick, which is what LVGL needs to register a click.
static constexpr int kDefaultHoldMs = 60;

// Max body size accepted. /touch payloads are tiny JSON objects
// ({"x":N,"y":N,"hold_ms":N}); cap at 128 bytes — anything larger is malformed.
static constexpr int kMaxBodyBytes = 128;

static esp_err_t touch_handler(httpd_req_t* req) {
    ESP_LOGD(TAG, "POST /touch content_len=%d", req->content_len);
    if (req->content_len <= 0 || req->content_len >= kMaxBodyBytes) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"bad_content_length\"}");
        return ESP_OK;
    }
    char buf[kMaxBodyBytes];
    int to_read = std::min<int>(kMaxBodyBytes - 1, req->content_len);
    int len = httpd_req_recv(req, buf, to_read);
    if (len <= 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"empty_body\"}");
        return ESP_OK;
    }
    buf[len] = 0;

    cJSON* j = cJSON_Parse(buf);
    if (j == nullptr) {
        ESP_LOGW(TAG, "bad_json: '%.*s'", len, buf);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"bad_json\"}");
        return ESP_OK;
    }
    cJSON* jx = cJSON_GetObjectItem(j, "x");
    cJSON* jy = cJSON_GetObjectItem(j, "y");
    if (!cJSON_IsNumber(jx) || !cJSON_IsNumber(jy)) {
        cJSON_Delete(j);
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"missing_xy\"}");
        return ESP_OK;
    }
    int x = jx->valueint;
    int y = jy->valueint;
    cJSON* jhold = cJSON_GetObjectItem(j, "hold_ms");
    int hold_ms = (jhold && cJSON_IsNumber(jhold)) ? jhold->valueint : kDefaultHoldMs;
    cJSON_Delete(j);

    ESP_LOGI(TAG, "invoke x=%d y=%d hold_ms=%d", x, y, hold_ms);
    int rc = esp32_devtool_invoke_touch(x, y, hold_ms);
    if (rc != 0) {
        ESP_LOGW(TAG, "invoke_touch failed rc=%d (provider unset or busy)", rc);
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"touch_provider_unset\"}");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    return ESP_OK;
}

__attribute__((constructor))
static void register_touch_route() {
    devtool_register_http("POST", "/touch", touch_handler);
}
