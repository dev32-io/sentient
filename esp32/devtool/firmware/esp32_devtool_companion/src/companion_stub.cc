#include "esp32_devtool/companion.h"
#include "esp32_devtool/verbs.h"
#include "esp32_devtool/endpoints.h"

extern "C" {

int esp32_devtool_companion_start(const esp32_devtool_companion_config_t*) {
    return 0;
}
void esp32_devtool_companion_post_network_ready(void) {}
void esp32_devtool_companion_stop(void) {}
void esp32_devtool_companion_checkpoint(const char*) {}
void esp32_devtool_companion_event(const char*) {}
void devtool_register_verb(const char*, devtool_verb_handler_t) {}
void devtool_register_http(const char*, const char*, devtool_http_handler_t) {}
void esp32_devtool_set_info_provider(esp32_devtool_info_provider_t) {}
void esp32_devtool_set_snapshot_provider(esp32_devtool_snapshot_provider_t) {}
void esp32_devtool_set_touch_provider(esp32_devtool_touch_provider_t) {}
void esp32_devtool_set_audio_record_provider(esp32_devtool_audio_record_provider_t) {}
void esp32_devtool_set_audio_inject_provider(esp32_devtool_audio_inject_provider_t) {}

}
