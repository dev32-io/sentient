#pragma once
#include "cube_visual.h"
#include "companion.h"
#include <lvgl.h>
#include <cstdio>

class CubeVisualAssets {
public:
    bool load(sentient::cube::ResourceReader reader) {
        static const char* icons[] = {"wifi", "offline", "mic", "speaker", "phone", "dots",
            "retry", "plug", "scan", "lock", "mic-active", "mic-dark", "speaker-active"};
        static const char* batteries[] = {"0", "1", "2", "3", "charging", "0-low", "1-low", "2-low", "3-low"};
        char path[64];
        for (size_t i = 0; i < 13; ++i) {
            snprintf(path, sizeof(path), "/ui/icon-%s.i1", icons[i]);
            if (!image(reader, path, icons_[i], 36, 36, LV_COLOR_FORMAT_I1)) return false;
        }
        for (size_t i = 0; i < 9; ++i) {
            snprintf(path, sizeof(path), "/ui/battery-%s.i1", batteries[i]);
            if (!image(reader, path, batteries_[i], 54, 34, LV_COLOR_FORMAT_I1)) return false;
        }
        return image(reader, "/ui/bubble.rgb565", bubbles_[0], 72, 72, LV_COLOR_FORMAT_RGB565) &&
            image(reader, "/ui/bubble-active.rgb565", bubbles_[1], 72, 72, LV_COLOR_FORMAT_RGB565);
    }
    const lv_image_dsc_t* icon(CubeGlyph glyph, bool active = false, bool dark = false) const {
        switch (glyph) {
            case CubeGlyph::Wifi: return &icons_[0];
            case CubeGlyph::Offline: return &icons_[1];
            case CubeGlyph::Mic: return &icons_[dark ? 11 : active ? 10 : 2];
            case CubeGlyph::Speaker: return &icons_[active ? 12 : 3];
            case CubeGlyph::Phone: return &icons_[4];
            case CubeGlyph::Dots: return &icons_[5];
            case CubeGlyph::Retry: return &icons_[6];
            case CubeGlyph::Plug: return &icons_[7];
            case CubeGlyph::Scan: return &icons_[8];
            case CubeGlyph::Lock: return &icons_[9];
            default: return nullptr;
        }
    }
    const lv_image_dsc_t* battery(int percent, bool charging, bool low) const {
        return &batteries_[charging ? 4 : cube_battery_bars(percent) + (low ? 5 : 0)];
    }
    const lv_image_dsc_t* bubble(bool active) const { return &bubbles_[active ? 1 : 0]; }
private:
    static bool image(sentient::cube::ResourceReader reader, const char* path,
                      lv_image_dsc_t& image, unsigned width, unsigned height, lv_color_format_t format) {
        const uint8_t* pixels; size_t size;
        unsigned stride = format == LV_COLOR_FORMAT_I1 ? (width + 7) / 8 : width * 2;
        if (!reader.get(path, pixels, size) || size != stride * height + (format == LV_COLOR_FORMAT_I1 ? 8 : 0)) return false;
        image = {};
        image.header.magic = LV_IMAGE_HEADER_MAGIC; image.header.cf = format;
        image.header.w = width; image.header.h = height; image.header.stride = stride;
        image.data = pixels; image.data_size = size;
        return true;
    }
    lv_image_dsc_t icons_[13]{}, batteries_[9]{}, bubbles_[2]{};
};
