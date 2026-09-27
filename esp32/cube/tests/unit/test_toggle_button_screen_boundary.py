"""Exercise production toggle widget against a small LVGL host boundary (no IDF)."""
from pathlib import Path
import subprocess
import tempfile
import unittest

BOARD = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube'


class ToggleButtonScreenBoundaryTest(unittest.TestCase):
    def test_repeated_listening_ready_resets_scale_and_keeps_button_usable(self):
        lvgl = r'''
#pragma once
#include <cstdint>
#include <string>
#include <vector>
#define LV_SCALE_NONE 256
#define LV_OPA_COVER 255
#define LV_OPA_TRANSP 0
#define LV_RADIUS_CIRCLE 999
#define LV_ALIGN_CENTER 0
#define LV_OBJ_FLAG_HIDDEN 1
#define LV_OBJ_FLAG_CLICKABLE 2
#define LV_LABEL_LONG_WRAP 0
#define LV_TEXT_ALIGN_CENTER 0
#define LV_ANIM_REPEAT_INFINITE -1
#define LV_FONT_MONTSERRAT_28 0
#define LV_EVENT_PRESSED 1
#define LV_EVENT_RELEASED 2
#define LV_EVENT_PRESS_LOST 3
struct lv_event_t {};
struct lv_obj_t {
    int width = 0, height = 0, x = 0, y = 0, scale_x = LV_SCALE_NONE, scale_y = LV_SCALE_NONE;
    int pivot_x = 0, pivot_y = 0, flags = LV_OBJ_FLAG_CLICKABLE;
    std::string text;
    void (*pressed)(lv_event_t*) = nullptr;
    void (*released)(lv_event_t*) = nullptr;
};
struct lv_anim_t { lv_obj_t* obj = nullptr; void (*exec)(void*, int32_t) = nullptr; int lo = 0, hi = 0; };
inline int lv_font_montserrat_14;
inline int lv_pct(int n) { return 10000 + n; }
inline int lv_color_hex(int n) { return n; }
inline lv_obj_t* lv_obj_create(lv_obj_t*) { return new lv_obj_t; }
inline lv_obj_t* lv_button_create(lv_obj_t*) { return new lv_obj_t; }
inline lv_obj_t* lv_label_create(lv_obj_t*) { return new lv_obj_t; }
inline void lv_obj_set_size(lv_obj_t* o, int w, int h) { o->width = w; o->height = h; }
inline void lv_obj_set_width(lv_obj_t* o, int w) { o->width = w; }
inline void lv_obj_align(lv_obj_t* o, int, int x, int y) { o->x = x; o->y = y; }
inline void lv_obj_center(lv_obj_t*) {}
inline void lv_obj_set_style_transform_pivot_x(lv_obj_t* o, int v, int) { o->pivot_x = v; }
inline void lv_obj_set_style_transform_pivot_y(lv_obj_t* o, int v, int) { o->pivot_y = v; }
inline void lv_obj_set_style_transform_scale_x(lv_obj_t* o, int v, int) { o->scale_x = v; }
inline void lv_obj_set_style_transform_scale_y(lv_obj_t* o, int v, int) { o->scale_y = v; }
inline void lv_obj_set_style_bg_color(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_bg_opa(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_border_width(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_border_color(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_radius(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_pad_all(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_text_font(lv_obj_t*, const int*, int) {}
inline void lv_obj_set_style_text_color(lv_obj_t*, int, int) {}
inline void lv_obj_set_style_text_align(lv_obj_t*, int, int) {}
inline void lv_label_set_text(lv_obj_t* o, const char* s) { o->text = s; }
inline void lv_label_set_long_mode(lv_obj_t*, int) {}
inline void lv_obj_add_flag(lv_obj_t* o, int flag) { o->flags |= flag; }
inline void lv_obj_remove_flag(lv_obj_t* o, int flag) { o->flags &= ~flag; }
inline void lv_screen_load(lv_obj_t*) {}
inline void lv_obj_add_event_cb(lv_obj_t* o, void (*cb)(lv_event_t*), int event, void*) {
    if(event == LV_EVENT_PRESSED) o->pressed = cb;
    if(event == LV_EVENT_RELEASED) o->released = cb;
}
inline void lv_anim_init(lv_anim_t* a) { *a = {}; }
inline void lv_anim_set_var(lv_anim_t* a, lv_obj_t* o) { a->obj = o; }
inline void lv_anim_set_exec_cb(lv_anim_t* a, void (*cb)(void*, int32_t)) { a->exec = cb; }
inline void lv_anim_set_values(lv_anim_t* a, int lo, int hi) { a->lo = lo; a->hi = hi; }
inline void lv_anim_set_duration(lv_anim_t*, int) {}
inline void lv_anim_set_playback_duration(lv_anim_t*, int) {}
inline void lv_anim_set_repeat_count(lv_anim_t*, int) {}
inline void lv_anim_path_ease_in_out() {}
inline void lv_anim_set_path_cb(lv_anim_t*, void (*)()) {}
inline void lv_anim_start(lv_anim_t*) {}
inline void lv_anim_del(lv_obj_t*, void (*)(void*, int32_t)) {}
'''
        cpp = r'''
#include <cassert>
#include "toggle_button_screen.cc"
int main() {
    toggle_button_screen_create();
    assert(g_button->width == SENTIENT_BTN_SIZE && g_button->height == SENTIENT_BTN_SIZE);
    assert(g_button->x == 0 && g_button->y == 0);
    assert(g_button->pivot_x == lv_pct(50) && g_button->pivot_y == lv_pct(50));
    assert(g_button->pressed && g_button->released);
    lv_event_t event;
    toggle_button_screen_apply_state(SENTIENT_UI_READY);
    for(int i = 0; i < 2; ++i) {
        assert(g_button->flags & LV_OBJ_FLAG_CLICKABLE);
        assert(g_button->scale_x == LV_SCALE_NONE && g_button->scale_y == LV_SCALE_NONE);
        g_button->pressed(&event);
        toggle_button_screen_apply_state(SENTIENT_UI_LISTENING);
        assert(g_breath_anim.lo == SENTIENT_SCALE_NORMAL);
        g_breath_anim.exec(g_breath_anim.obj, g_breath_anim.hi);
        assert(g_button->scale_x == LV_SCALE_NONE * SENTIENT_BREATH_SCALE_HI / SENTIENT_SCALE_NORMAL);
        assert(g_button->scale_y == g_button->scale_x);
        g_button->released(&event);
        toggle_button_screen_apply_state(SENTIENT_UI_READY);
        assert(g_button->scale_x == LV_SCALE_NONE && g_button->scale_y == LV_SCALE_NONE);
    }
    assert(Application::GetInstance().starts == 2 && Application::GetInstance().stops == 2);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            (tmp / 'lvgl.h').write_text(lvgl)
            (tmp / 'esp_log.h').write_text('#pragma once\n#define ESP_LOGD(...) ((void)0)\n#define ESP_LOGI(...) ((void)0)\n#define ESP_LOGW(...) ((void)0)\n')
            (tmp / 'sentient_creds.h').write_text('#pragma once\n#define SENTIENT_DEVICE_ID "host"\n')
            (tmp / 'application.h').write_text('''#pragma once
class Application {
public:
    int starts = 0, stops = 0;
    static Application& GetInstance() { static Application app; return app; }
    void StartListening() { ++starts; }
    void StopListening() { ++stops; }
};
''')
            (tmp / 'test.cc').write_text(cpp)
            binary = tmp / 'test'
            subprocess.run(['c++', '-std=c++17', '-I', str(tmp), '-I', str(BOARD),
                            str(tmp / 'test.cc'), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
