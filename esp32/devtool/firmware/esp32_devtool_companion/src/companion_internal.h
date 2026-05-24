#pragma once
#include "esp32_devtool/companion.h"
#ifdef __cplusplus
extern "C" {
#endif
int esp32_devtool_get_info(esp32_devtool_info_t* out);
int esp32_devtool_get_snapshot(esp32_devtool_snapshot_t* out);
int esp32_devtool_invoke_touch(int x, int y, int hold_ms);
int esp32_devtool_invoke_audio_record(int16_t* dst, size_t samples, int sample_rate);
int esp32_devtool_invoke_audio_inject(const int16_t* src, size_t samples, int sample_rate);
#ifdef __cplusplus
}
#endif
