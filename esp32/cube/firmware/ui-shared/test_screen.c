// ui-shared/test_screen.c — implementation. See test_screen.h for contract.

#include "test_screen.h"

// Touch heatmap dot size. The set_touch_xy helper offsets by half this value
// so the dot centers on the reported touch point.
#define SENTIENT_TOUCH_DOT_SIZE 22

// Cached pointer to the heatmap dot widget so set_touch_xy can move it
// without re-walking the screen tree. NULL until the first build() call.
static lv_obj_t* s_touch_dot = NULL;

static void build_background(lv_obj_t* parent) {
    lv_obj_set_style_bg_color(parent, lv_color_hex(0x0a1f33), 0);
    lv_obj_set_style_bg_opa(parent, LV_OPA_COVER, 0);
}

static void build_label(lv_obj_t* parent) {
    lv_obj_t* label = lv_label_create(parent);
    lv_label_set_text(label, "SENTIENT CUBE");
    lv_obj_set_style_text_color(label, lv_color_white(), 0);
    lv_obj_align(label, LV_ALIGN_CENTER, 0, -60);
}

static void build_gradient_bar(lv_obj_t* parent) {
    lv_obj_t* bar = lv_obj_create(parent);
    lv_obj_remove_style_all(bar);
    lv_obj_set_size(bar, LV_PCT(80), 16);
    lv_obj_align(bar, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_bg_color(bar, lv_color_hex(0x062033), 0);
    lv_obj_set_style_bg_grad_color(bar, lv_color_hex(0x4dd0e1), 0);
    lv_obj_set_style_bg_grad_dir(bar, LV_GRAD_DIR_HOR, 0);
    lv_obj_set_style_bg_opa(bar, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(bar, 8, 0);
}

static void build_spinner(lv_obj_t* parent) {
    lv_obj_t* spinner = lv_spinner_create(parent);
    lv_obj_set_size(spinner, 56, 56);
    lv_obj_align(spinner, LV_ALIGN_CENTER, 0, 70);
    // ~1.5 Hz: full rotation in 666 ms.
    lv_spinner_set_anim_params(spinner, 666, 200);
}

static lv_obj_t* build_touch_dot(lv_obj_t* parent) {
    lv_obj_t* dot = lv_obj_create(parent);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, SENTIENT_TOUCH_DOT_SIZE, SENTIENT_TOUCH_DOT_SIZE);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(dot, lv_color_hex(0xff5252), 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_border_width(dot, 2, 0);
    lv_obj_set_style_border_color(dot, lv_color_white(), 0);
    lv_obj_add_flag(dot, LV_OBJ_FLAG_HIDDEN);
    return dot;
}

void sentient_test_screen_build(void) {
    // Create a NEW screen and load it, instead of wiping the active screen.
    // The parent SpiLcdDisplay::SetupUI() populates the original active
    // screen with chat_message_label_ + status_bar_ + other widgets the
    // LcdDisplay base class tracks via raw pointers. lv_obj_clean on those
    // would dangling-pointer the base class — SetChatMessage later panics
    // on the dangling chat_message_label_.
    //
    // Building on a new screen leaves the parent's widgets intact (just
    // unloaded). SetChatMessage harmlessly updates an off-screen label.
    s_touch_dot = NULL;
    lv_obj_t* scr = lv_obj_create(NULL);

    build_background(scr);
    build_gradient_bar(scr);
    build_label(scr);
    build_spinner(scr);
    s_touch_dot = build_touch_dot(scr);

    lv_screen_load(scr);
}

void sentient_test_screen_set_touch_xy(int x, int y, bool visible) {
    if (s_touch_dot == NULL) {
        return;
    }
    if (visible) {
        lv_obj_set_pos(s_touch_dot, x - SENTIENT_TOUCH_DOT_SIZE / 2,
                       y - SENTIENT_TOUCH_DOT_SIZE / 2);
        lv_obj_clear_flag(s_touch_dot, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(s_touch_dot, LV_OBJ_FLAG_HIDDEN);
    }
}
