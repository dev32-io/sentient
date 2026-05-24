// SPDX-License-Identifier: MIT
// toggle_button_screen.cc
//
// Single-screen LVGL widget tree for the cube's v1 POC UI:
//   - SENTIENT_BTN_SIZE px circular button at center
//     - Sage fill  when READY
//     - Terra fill when LISTENING (+ breath animation)
//     - Transparent outline when DISABLED
//   - Status hint label above the button (montserrat-14, hidden when empty)
//   - Breath animation: scale 1.00→1.05→1.00 over 3400 ms (LVGL transform units)
//
// Forward-declared in sentient_ui_controller.cc and called from there.
//
// VERIFY UPSTREAM markers call out every unconfirmed-symbol boundary.
// Resolve them during the first build against the real upstream tree.
//
// LVGL version in use: ~9.5.0 (from upstream/main/idf_component.yml).

#include "sentient_ui_controller.h"
#include "sentient_tokens.h"
#include "sentient_creds.h"  // SENTIENT_DEVICE_ID baked at build time

#include <lvgl.h>
#include <esp_log.h>

// VERIFY UPSTREAM: confirm application.h is on the include path as "application.h"
// (it lives in upstream/main/ which cmake adds to INCLUDE_DIRS).
#include "application.h"

static const char* TAG = "sentient.cube.ui.toggle";

// ---------------------------------------------------------------------------
// Module-private LVGL widget refs
// ---------------------------------------------------------------------------
static lv_obj_t* g_screen        = nullptr;
static lv_obj_t* g_button        = nullptr;
static lv_obj_t* g_status_hint   = nullptr;
static lv_obj_t* g_transcript    = nullptr;

// Breath animation state.
static lv_anim_t g_breath_anim;
static bool      g_breath_running = false;

// ---------------------------------------------------------------------------
// Forward declarations of internal helpers
// ---------------------------------------------------------------------------
static void start_breath(void);
static void stop_breath(void);

// ---------------------------------------------------------------------------
// Button click handler
// ---------------------------------------------------------------------------

static void on_button_clicked(lv_event_t* /*e*/) {
    ESP_LOGI(TAG, "click device_id=" SENTIENT_DEVICE_ID);
    // VERIFY UPSTREAM: ToggleChatState() confirmed in application.h line 92.
    Application::GetInstance().ToggleChatState();
}

// ---------------------------------------------------------------------------
// Breath animation callback
//
// v ∈ [SENTIENT_BREATH_SCALE_LO, SENTIENT_BREATH_SCALE_HI] (integer units,
// 1000 = 1.0× in LVGL 9 transform scale).
//
// VERIFY UPSTREAM: lv_obj_set_style_transform_scale_x / _y are LVGL 9 APIs.
// If the upstream pins an LVGL 9.x release prior to 9.0.0-rc.1 the API may be
// lv_obj_set_style_transform_zoom (scalar, applies to both axes). Adjust if the
// build errors with "undefined reference".
// ---------------------------------------------------------------------------

static void breath_scale_cb(void* obj, int32_t v) {
    lv_obj_set_style_transform_scale_x((lv_obj_t*)obj, (int16_t)v, 0);
    lv_obj_set_style_transform_scale_y((lv_obj_t*)obj, (int16_t)v, 0);
}

static void start_breath(void) {
    if (g_breath_running || g_button == nullptr) {
        return;
    }
    g_breath_running = true;
    lv_anim_init(&g_breath_anim);
    lv_anim_set_var(&g_breath_anim, g_button);
    lv_anim_set_exec_cb(&g_breath_anim, breath_scale_cb);
    lv_anim_set_values(&g_breath_anim,
                       SENTIENT_BREATH_SCALE_LO,
                       SENTIENT_BREATH_SCALE_HI);
    lv_anim_set_duration(&g_breath_anim, SENTIENT_BREATH_HALF_MS);
    lv_anim_set_playback_duration(&g_breath_anim, SENTIENT_BREATH_HALF_MS);
    lv_anim_set_repeat_count(&g_breath_anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&g_breath_anim, lv_anim_path_ease_in_out);
    lv_anim_start(&g_breath_anim);
    ESP_LOGD(TAG, "breath_start device_id=" SENTIENT_DEVICE_ID);
}

static void stop_breath(void) {
    if (!g_breath_running || g_button == nullptr) {
        return;
    }
    g_breath_running = false;
    // VERIFY UPSTREAM: lv_anim_del signature in LVGL 9 is
    // lv_anim_del(obj, exec_cb) — same as LVGL 8.
    lv_anim_del(g_button, breath_scale_cb);
    // Reset to 1.0× so button doesn't freeze at a mid-scale value.
    lv_obj_set_style_transform_scale_x(g_button, SENTIENT_SCALE_NORMAL, 0);
    lv_obj_set_style_transform_scale_y(g_button, SENTIENT_SCALE_NORMAL, 0);
    ESP_LOGD(TAG, "breath_stop device_id=" SENTIENT_DEVICE_ID);
}

// ---------------------------------------------------------------------------
// Public C API — implemented here, forward-declared in sentient_ui_controller.cc
// ---------------------------------------------------------------------------

extern "C" void toggle_button_screen_create(void) {
    if (g_screen != nullptr) {
        ESP_LOGW(TAG, "create.reentrant device_id=" SENTIENT_DEVICE_ID);
        return;
    }
    ESP_LOGI(TAG, "create device_id=" SENTIENT_DEVICE_ID
             " display=%dx%d btn=%d",
             SENTIENT_DISPLAY_W, SENTIENT_DISPLAY_H, SENTIENT_BTN_SIZE);

    // --- Screen ---
    g_screen = lv_obj_create(nullptr);
    lv_obj_set_style_bg_color(g_screen, lv_color_hex(SENTIENT_BG_DARK), 0);
    lv_obj_set_style_bg_opa(g_screen, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(g_screen, 0, 0);

    // --- Toggle button: circular, centered ---
    // VERIFY UPSTREAM: LVGL 9 renamed lv_btn_create → lv_button_create.
    // If build fails with "undefined reference to lv_button_create", try lv_btn_create.
    g_button = lv_button_create(g_screen);
    lv_obj_set_size(g_button, SENTIENT_BTN_SIZE, SENTIENT_BTN_SIZE);
    lv_obj_align(g_button, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_radius(g_button, LV_RADIUS_CIRCLE, 0);
    // Remove default padding so label fills the full circle visually.
    lv_obj_set_style_pad_all(g_button, 0, 0);
    lv_obj_add_event_cb(g_button, on_button_clicked, LV_EVENT_CLICKED, nullptr);

    // No button label — Phase 6a smoke aid uses graphic-only state cues
    // (sage = mic off / terra = mic on). State + transcript live in the
    // surrounding labels so the button itself stays clean.

    // --- Status hint label (event/state line above button) ---
    // Shows the most recent cube-sdk event for the operator. Empty hides it.
    g_status_hint = lv_label_create(g_screen);
    lv_label_set_text(g_status_hint, "");
    lv_obj_align(g_status_hint, LV_ALIGN_CENTER, 0, SENTIENT_HINT_Y_OFFSET);
    lv_obj_set_style_text_color(g_status_hint, lv_color_hex(SENTIENT_INK), 0);
    // Prefer the 28pt Phase-6a smoke-aid font when available; fall back to the
    // built-in 14pt that ships with every LVGL build so prod profiles (which
    // omit the 28pt asset to save flash) still link.
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(g_status_hint, &lv_font_montserrat_28, 0);
#else
    lv_obj_set_style_text_font(g_status_hint, &lv_font_montserrat_14, 0);
#endif
    lv_obj_add_flag(g_status_hint, LV_OBJ_FLAG_HIDDEN);

    // --- Transcript label (below button) ---
    // Shows the most recent STT transcript so the operator can see what the
    // gateway heard. Multi-line, wraps at SENTIENT_TRANSCRIPT_W.
    g_transcript = lv_label_create(g_screen);
    lv_label_set_text(g_transcript, "");
    lv_obj_align(g_transcript, LV_ALIGN_CENTER, 0, SENTIENT_TRANSCRIPT_Y_OFFSET);
    lv_obj_set_width(g_transcript, SENTIENT_TRANSCRIPT_W);
    lv_label_set_long_mode(g_transcript, LV_LABEL_LONG_WRAP);
    lv_obj_set_style_text_color(g_transcript, lv_color_hex(SENTIENT_INK), 0);
    lv_obj_set_style_text_align(g_transcript, LV_TEXT_ALIGN_CENTER, 0);
#if LV_FONT_MONTSERRAT_28
    lv_obj_set_style_text_font(g_transcript, &lv_font_montserrat_28, 0);
#else
    lv_obj_set_style_text_font(g_transcript, &lv_font_montserrat_14, 0);
#endif
    lv_obj_add_flag(g_transcript, LV_OBJ_FLAG_HIDDEN);

    // Activate this screen.
    // VERIFY UPSTREAM: LVGL 9 uses lv_screen_load(); LVGL 8 used lv_scr_load().
    // The upstream codebase calls lv_screen_active() (9.x form), so assume 9.x.
    lv_screen_load(g_screen);

    ESP_LOGI(TAG, "create.done device_id=" SENTIENT_DEVICE_ID);
}

extern "C" void toggle_button_screen_apply_state(sentient_ui_state_t state) {
    if (g_button == nullptr) {
        ESP_LOGW(TAG, "apply_state.no_screen device_id=" SENTIENT_DEVICE_ID
                 " state=%d", (int)state);
        return;
    }
    ESP_LOGD(TAG, "apply_state device_id=" SENTIENT_DEVICE_ID " state=%d",
             (int)state);

    switch (state) {
        case SENTIENT_UI_DISABLED:
            // Transparent fill + sage outline — indicates unavailable.
            lv_obj_set_style_bg_opa(g_button, LV_OPA_TRANSP, 0);
            lv_obj_set_style_border_color(g_button, lv_color_hex(SENTIENT_SAGE), 0);
            lv_obj_set_style_border_width(g_button, SENTIENT_BTN_BORDER_W, 0);
            // VERIFY UPSTREAM: lv_obj_remove_flag is the LVGL 9 form of
            // lv_obj_clear_flag. Both appear in upstream; prefer remove_flag.
            lv_obj_remove_flag(g_button, LV_OBJ_FLAG_CLICKABLE);
            stop_breath();
            break;

        case SENTIENT_UI_READY:
            // Solid sage fill — mic off / ready to accept a tap.
            lv_obj_set_style_bg_opa(g_button, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(g_button, lv_color_hex(SENTIENT_SAGE), 0);
            lv_obj_set_style_border_width(g_button, 0, 0);
            lv_obj_add_flag(g_button, LV_OBJ_FLAG_CLICKABLE);
            stop_breath();
            break;

        case SENTIENT_UI_LISTENING:
            // Solid terra fill + breath animation — mic is live.
            lv_obj_set_style_bg_opa(g_button, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(g_button, lv_color_hex(SENTIENT_TERRA), 0);
            lv_obj_set_style_border_width(g_button, 0, 0);
            lv_obj_add_flag(g_button, LV_OBJ_FLAG_CLICKABLE);
            start_breath();
            break;
    }
}

extern "C" void toggle_button_screen_set_transcript(const char* text) {
    if (g_transcript == nullptr) {
        return;
    }
    if (text == nullptr || text[0] == '\0') {
        lv_obj_add_flag(g_transcript, LV_OBJ_FLAG_HIDDEN);
        ESP_LOGD(TAG, "transcript_hidden device_id=" SENTIENT_DEVICE_ID);
        return;
    }
    lv_label_set_text(g_transcript, text);
    lv_obj_remove_flag(g_transcript, LV_OBJ_FLAG_HIDDEN);
    ESP_LOGD(TAG, "transcript_set device_id=" SENTIENT_DEVICE_ID " text='%.80s'", text);
}

extern "C" void toggle_button_screen_set_status_hint(const char* text) {
    if (g_status_hint == nullptr) {
        return;
    }
    if (text == nullptr || text[0] == '\0') {
        lv_obj_add_flag(g_status_hint, LV_OBJ_FLAG_HIDDEN);
        ESP_LOGD(TAG, "hint_hidden device_id=" SENTIENT_DEVICE_ID);
        return;
    }
    lv_label_set_text(g_status_hint, text);
    lv_obj_remove_flag(g_status_hint, LV_OBJ_FLAG_HIDDEN);
    ESP_LOGD(TAG, "hint_set device_id=" SENTIENT_DEVICE_ID " text='%.80s'", text);
}
