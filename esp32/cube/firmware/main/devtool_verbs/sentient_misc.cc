// SPDX-License-Identifier: MIT
// devtool_verbs/sentient_misc.cc — sentient.force_reconnect + sentient.last_transcript.
//
// Migrated from components/agent_console/verbs/sentient.cc in Task 24. The
// sentient.status verb was migrated in Task 14 (sentient.cc) — this file
// covers only the two remaining HIL verbs.
//
// Both verbs proxy SentientWsProtocol via the cube_sentient_* shims defined
// in sentient_cube.cc, which guard against the pre-WiFi window where the
// protocol object hasn't been constructed yet.
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include <cstring>

extern "C" const char* cube_sentient_status_str(void);
extern "C" void cube_sentient_force_reconnect(void);
extern "C" size_t cube_sentient_last_transcript(char* dst, size_t dst_cap);

namespace {

// 1 KB is plenty for any single transcript line.
constexpr size_t kTranscriptCap = 1024;

int handle_force_reconnect(const cJSON* /*params*/, cJSON* out_result,
                           int* /*ec*/, const char** /*em*/) {
    cube_sentient_force_reconnect();
    // "ok" reports provider-registered, not action-success — the underlying
    // force_reconnect on SentientWsProtocol is fire-and-forget. A false
    // would imply the provider hasn't been wired yet (pre-WiFi).
    const bool wired = (std::strcmp(cube_sentient_status_str(), "uninit") != 0);
    cJSON_AddBoolToObject(out_result, "ok", wired);
    return 0;
}

int handle_last_transcript(const cJSON* /*params*/, cJSON* out_result,
                           int* /*ec*/, const char** /*em*/) {
    char buf[kTranscriptCap];
    cube_sentient_last_transcript(buf, sizeof(buf));
    cJSON_AddStringToObject(out_result, "text", buf);
    return 0;
}

__attribute__((constructor))
static void register_sentient_misc_verbs(void) {
    devtool_register_verb("sentient.force_reconnect", handle_force_reconnect);
    devtool_register_verb("sentient.last_transcript", handle_last_transcript);
}

}  // namespace
