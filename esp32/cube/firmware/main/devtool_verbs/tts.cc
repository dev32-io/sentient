// SPDX-License-Identifier: MIT
// devtool_verbs/tts.cc — tts.cancel verb.
//
// Aborts in-flight TTS playback via cube_tts_cancel(), a shim defined in
// sentient_cube.cc that calls Application::AbortSpeaking() (the same path
// the sentient SDK takes for barge-in). Result shape: { ok: true }.
//
// Migrated from components/agent_console/verbs/audio_misc.cc in Task 24.
// Split into its own file per the plan's verb-per-file convention.
//
// Registered via __attribute__((constructor)) static-init.

#include "esp32_devtool/verbs.h"
#include <esp_log.h>

extern "C" void cube_tts_cancel(void);

namespace {

constexpr const char* TAG = "sentient.cube.devtool.tts";

int handle_tts_cancel(const cJSON* /*params*/, cJSON* out_result,
                      int* /*ec*/, const char** /*em*/) {
    ESP_LOGI(TAG, "tts_cancel");
    cube_tts_cancel();
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_tts_cancel_verb(void) {
    devtool_register_verb("tts.cancel", handle_tts_cancel);
}

}  // namespace
