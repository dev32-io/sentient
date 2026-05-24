// SPDX-License-Identifier: MIT
// devtool_verbs/sentient.cc — sentient.status verb for esp32-devtool.
//
// Proxies SentientWsProtocol status via the cube_sentient_status_str() shim
// defined in sentient_cube.cc. Returns "uninit" pre-WiFi (before the WS
// protocol object is constructed).
//
// Result shape: { status: <string> }
//
// Only sentient.status is migrated here in Task 14. sentient.force_reconnect
// and sentient.last_transcript are migrated in Task 24 along with the
// remaining verbs.
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"

extern "C" const char* cube_sentient_status_str(void);

namespace {

int sentient_status_handler(const cJSON* /*params*/, cJSON* out,
                            int* /*ec*/, const char** /*em*/) {
    cJSON_AddStringToObject(out, "status", cube_sentient_status_str());
    return 0;
}

__attribute__((constructor))
static void register_sentient_status_verb() {
    devtool_register_verb("sentient.status", sentient_status_handler);
}

}  // namespace
