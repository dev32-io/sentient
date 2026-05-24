// SPDX-License-Identifier: MIT
// devtool_verbs/mark.cc — emit a labeled marker to stdout for HIL test sync.
//
// Emits: >>> CHECKPOINT <label> <ts_us>
// Uses esp32_devtool_companion_checkpoint() so the format matches the devtool
// wire protocol exactly. HIL test runners wait on this line as a rendezvous
// point.
//
// params: { "label": "<string>" }
// Result shape: { ok: true }
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include "esp32_devtool/companion.h"

namespace {

int mark_handler(const cJSON* params, cJSON* out, int* ec, const char** em) {
    const cJSON* label = cJSON_GetObjectItem(params, "label");
    if (!cJSON_IsString(label)) {
        *ec = -32602;
        *em = "Invalid params: label required";
        return 1;
    }
    esp32_devtool_companion_checkpoint(label->valuestring);
    cJSON_AddBoolToObject(out, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_mark_verb() {
    devtool_register_verb("mark", mark_handler);
}

}  // namespace
