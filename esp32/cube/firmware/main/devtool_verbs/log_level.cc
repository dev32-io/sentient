// SPDX-License-Identifier: MIT
// devtool_verbs/log_level.cc — set ESP_LOGx threshold for a tag at runtime.
//
// Migrated from components/agent_console/verbs/log_level.cc in Task 24.
//
// Params: { tag: string, level: "none"|"error"|"warn"|"info"|"debug"|"verbose" }
// Result: { ok: true }
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include <cstring>
#include <esp_log.h>

namespace {

esp_log_level_t parse_level(const char* s) {
    if (std::strcmp(s, "none")    == 0) return ESP_LOG_NONE;
    if (std::strcmp(s, "error")   == 0) return ESP_LOG_ERROR;
    if (std::strcmp(s, "warn")    == 0) return ESP_LOG_WARN;
    if (std::strcmp(s, "info")    == 0) return ESP_LOG_INFO;
    if (std::strcmp(s, "debug")   == 0) return ESP_LOG_DEBUG;
    if (std::strcmp(s, "verbose") == 0) return ESP_LOG_VERBOSE;
    return ESP_LOG_NONE;
}

int handle_log_level(const cJSON* params, cJSON* out_result,
                     int* ec, const char** em) {
    const cJSON* tag   = cJSON_GetObjectItem(params, "tag");
    const cJSON* level = cJSON_GetObjectItem(params, "level");
    if (!cJSON_IsString(tag) || !cJSON_IsString(level)) {
        *ec = -32602;
        *em = "Invalid params: tag + level required";
        return 1;
    }
    esp_log_level_set(tag->valuestring, parse_level(level->valuestring));
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_log_level_verb(void) {
    devtool_register_verb("log_level", handle_log_level);
}

}  // namespace
