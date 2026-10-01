#pragma once
#include <cstdint>

// Fixed-size LVGL-task aggregates. Durations are callback CPU time, not panel scanout.
struct CharacterProfile {
    uint32_t max_render_us = 0, max_flush_cb_us = 0, max_touch_to_flush_cb_us = 0;
    uint64_t sprite_invalidated_px = 0;
    int64_t render_started_us = 0, flush_started_us = 0, visual_press_us = 0;

    void render(bool start, int64_t now) {
        if (start) render_started_us = now;
        else if (render_started_us) {
            uint32_t us = static_cast<uint32_t>(now - render_started_us);
            if (us > max_render_us) max_render_us = us;
            render_started_us = 0;
        }
    }
    void flush(bool start, int64_t now, bool listening, bool visual_area) {
        if (start) flush_started_us = now;
        else if (flush_started_us) {
            uint32_t us = static_cast<uint32_t>(now - flush_started_us);
            if (us > max_flush_cb_us) max_flush_cb_us = us;
            flush_started_us = 0;
            if (visual_press_us && listening && visual_area) {
                us = static_cast<uint32_t>(now - visual_press_us);
                if (us > max_touch_to_flush_cb_us) max_touch_to_flush_cb_us = us;
                visual_press_us = 0;
            }
        }
    }
};
