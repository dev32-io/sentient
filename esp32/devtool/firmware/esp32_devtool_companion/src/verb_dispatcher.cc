#include "verb_dispatcher.h"
#include "esp32_devtool/verbs.h"

#include <cJSON.h>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <esp_log.h>

static const char* TAG = "sentient.cube.devtool.dispatch";

namespace {
constexpr int kMaxVerbs = 32;
struct VerbEntry {
    const char* method;
    devtool_verb_handler_t handler;
};
VerbEntry g_verbs[kMaxVerbs];
int g_verb_count = 0;

const devtool_verb_handler_t lookup(const char* method) {
    for (int i = 0; i < g_verb_count; i++) {
        if (std::strcmp(g_verbs[i].method, method) == 0) {
            return g_verbs[i].handler;
        }
    }
    return nullptr;
}

void emit_response(cJSON* response) {
    char* s = cJSON_PrintUnformatted(response);
    if (s != nullptr) {
        std::printf("<<< RSP %s\n", s);
        std::fflush(stdout);
        cJSON_free(s);
    }
}

void emit_error(int id_or_null_marker, const cJSON* id_node, int code, const char* message) {
    cJSON* response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "jsonrpc", "2.0");
    if (id_node != nullptr) {
        cJSON_AddItemToObject(response, "id", cJSON_Duplicate(id_node, 1));
    } else {
        cJSON_AddNullToObject(response, "id");
    }
    cJSON* err = cJSON_CreateObject();
    cJSON_AddNumberToObject(err, "code", code);
    cJSON_AddStringToObject(err, "message", message);
    cJSON_AddItemToObject(response, "error", err);
    emit_response(response);
    cJSON_Delete(response);
    (void)id_or_null_marker;
}

}  // namespace

extern "C" {

void devtool_verb_dispatcher_init(void) {
    // Registry is populated via __attribute__((constructor)) by verb files.
    // Nothing to initialize explicitly.
    ESP_LOGI(TAG, "init verb_count=%d", g_verb_count);
}

void devtool_register_verb(const char* method, devtool_verb_handler_t handler) {
    if (g_verb_count >= kMaxVerbs) {
        ESP_LOGE(TAG, "register_verb: max verbs reached, dropping '%s'",
                 method != nullptr ? method : "(null)");
        return;
    }
    g_verbs[g_verb_count++] = { method, handler };
}

void devtool_dispatcher_dispatch_line(const char* json_line) {
    if (json_line == nullptr || json_line[0] == '\0') return;
    cJSON* root = cJSON_Parse(json_line);
    if (root == nullptr) {
        emit_error(0, nullptr, -32700, "Parse error");
        return;
    }
    cJSON* version = cJSON_GetObjectItem(root, "jsonrpc");
    cJSON* method  = cJSON_GetObjectItem(root, "method");
    cJSON* id      = cJSON_GetObjectItem(root, "id");
    cJSON* params  = cJSON_GetObjectItem(root, "params");

    if (!cJSON_IsString(version) || std::strcmp(version->valuestring, "2.0") != 0 ||
        !cJSON_IsString(method) || id == nullptr) {
        emit_error(0, id, -32600, "Invalid Request");
        cJSON_Delete(root);
        return;
    }

    devtool_verb_handler_t handler = lookup(method->valuestring);
    if (handler == nullptr) {
        emit_error(0, id, -32601, "Method not found");
        cJSON_Delete(root);
        return;
    }

    cJSON* result = cJSON_CreateObject();
    int err_code = 0;
    const char* err_msg = nullptr;
    int rc = handler(params, result, &err_code, &err_msg);

    cJSON* response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "jsonrpc", "2.0");
    cJSON_AddItemToObject(response, "id", cJSON_Duplicate(id, 1));
    if (rc == 0) {
        cJSON_AddItemToObject(response, "result", result);
    } else {
        cJSON_Delete(result);
        cJSON* err = cJSON_CreateObject();
        cJSON_AddNumberToObject(err, "code", err_code != 0 ? err_code : -32603);
        cJSON_AddStringToObject(err, "message", err_msg != nullptr ? err_msg : "Internal error");
        cJSON_AddItemToObject(response, "error", err);
    }
    emit_response(response);
    cJSON_Delete(response);
    cJSON_Delete(root);
}

}  // extern "C"
