// Platform adapter only. Shipping views/player also compile in lvgl-sim.
#include "sentient_ui_controller.h"
#include "cube_views.h"
#include "application.h"
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
#include "character_profile.h"
#include <src/misc/lv_area_private.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#endif
LV_FONT_DECLARE(BUILTIN_TEXT_FONT);

extern bool sentient_cube_read_asset(void*, const char*, const uint8_t*&, size_t&);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
static constexpr const char* kCharacterTag = "sentient.cube.character";
static CharacterProfile profile;
static bool profile_enabled, visual_flush;
static constexpr lv_area_t kSpriteArea = {112, 116, 367, 371};
#endif
static void voice_input(void*, bool pressed) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    profile_enabled = esp_log_level_get(kCharacterTag) >= ESP_LOG_INFO;
    profile.visual_press_us = pressed ? esp_timer_get_time() : 0;
#endif
    if (pressed) Application::GetInstance().StartListening();
    else Application::GetInstance().StopListening();
}
static sentient::cube::ViewHost& view_host() {
    static sentient::cube::ViewHost host({nullptr, sentient_cube_read_asset}, voice_input,
                                       nullptr, &BUILTIN_TEXT_FONT);
    return host;
}
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
// Fixed-size device timing aggregates, opt-in through existing log_level tag.
static void profile_display(lv_event_t* event) {
    auto& main = view_host().main();
    if (!profile_enabled || lv_screen_active() != main.screen()) return;
    const auto code = lv_event_get_code(event);
    if (code == LV_EVENT_INVALIDATE_AREA) {
        const auto* area = lv_event_get_invalidated_area(event);
        lv_area_t overlap;
        if (area && main.sprite() && !lv_obj_has_flag(main.sprite(), LV_OBJ_FLAG_HIDDEN) &&
            lv_area_intersect(&overlap, area, &kSpriteArea))
            profile.sprite_invalidated_px += lv_area_get_size(&overlap);
    } else if (code == LV_EVENT_RENDER_START || code == LV_EVENT_RENDER_READY) {
        profile.render(code == LV_EVENT_RENDER_START, esp_timer_get_time());
    } else if (code == LV_EVENT_FLUSH_START || code == LV_EVENT_FLUSH_FINISH) {
        if (code == LV_EVENT_FLUSH_START) {
            visual_flush = false;
            const auto* flushed = static_cast<const lv_area_t*>(lv_event_get_param(event));
            if (flushed && profile.visual_press_us && main.scene() == CubeScene::Listening &&
                lv_display_get_rotation(lv_display_get_default()) == LV_DISPLAY_ROTATION_0) {
                lv_area_t logical = *flushed, area;
                lv_area_move(&logical, -lv_display_get_offset_x(lv_display_get_default()),
                             -lv_display_get_offset_y(lv_display_get_default()));
                visual_flush = lv_area_is_on(&logical, &kSpriteArea);
                if (!visual_flush) {
                    lv_obj_get_coords(main.voice_cue(), &area);
                    visual_flush = lv_area_is_on(&logical, &area);
                }
            }
        }
        profile.flush(code == LV_EVENT_FLUSH_START, esp_timer_get_time(),
                      main.scene() == CubeScene::Listening, visual_flush);
        if (code == LV_EVENT_FLUSH_FINISH) visual_flush = false;
    }
}
#endif
extern "C" void toggle_button_screen_create(void) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    static bool registered = false;
    if (!registered) {
        registered = true;
        esp_log_level_set(kCharacterTag, ESP_LOG_NONE);
        for (auto event : {LV_EVENT_INVALIDATE_AREA, LV_EVENT_RENDER_START, LV_EVENT_RENDER_READY,
                           LV_EVENT_FLUSH_START, LV_EVENT_FLUSH_FINISH})
            lv_display_add_event_cb(lv_display_get_default(), profile_display, event, nullptr);
    }
#endif
    view_host().create();
}
extern "C" void toggle_button_screen_finish_boot(bool ready) {
    // ApplyTextFont sets BootView's inherited font. Preserve it on future screens.
    view_host().finish_boot(ready, ready ? lv_obj_get_style_text_font(lv_screen_active(), LV_PART_MAIN) : nullptr);
}
extern "C" void toggle_button_screen_apply_scene(CubeScene scene) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    static CubeScene prior = CubeScene::Sleep;
    static unsigned transitions = 0;
    if (prior != scene) {
        prior = scene;
        profile_enabled = esp_log_level_get(kCharacterTag) >= ESP_LOG_INFO;
        if (++transitions % 32 == 0 && profile_enabled)
            ESP_LOGI(kCharacterTag, "transitions=%u max_render_us=%lu max_flush_cb_us=%lu max_touch_to_flush_cb_us=%lu sprite_invalidated_px_hi=%lu sprite_invalidated_px_lo=%lu min_heap=%lu min_psram=%lu",
                     transitions, (unsigned long)profile.max_render_us,
                     (unsigned long)profile.max_flush_cb_us, (unsigned long)profile.max_touch_to_flush_cb_us,
                     (unsigned long)(profile.sprite_invalidated_px >> 32), (unsigned long)profile.sprite_invalidated_px,
                     (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
                     (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
    }
#endif
    view_host().project(scene);
}
extern "C" void toggle_button_screen_volume(int percent) { view_host().volume(percent); }
extern "C" void toggle_button_screen_battery(int percent, bool charging, bool low) {
    view_host().battery(percent, charging, low);
}
extern "C" void toggle_button_screen_pairing(const char* qr, const char* locator, const char* proof) {
    view_host().pairing(qr, locator, proof);
}
extern "C" bool cube_setup_display_visible(void) { return view_host().protected_visible(); }
extern "C" void toggle_button_screen_suspend(void) { view_host().suspend(); }
