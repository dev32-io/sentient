"""Exercise board diagnostics and pinned LVGL without device access."""
from pathlib import Path
import re
import subprocess
import tempfile

FIRMWARE = Path(__file__).resolve().parents[2] / 'firmware'
BOARD = FIRMWARE / 'main/boards/sentient-cube'


def entry(name):
    source = (BOARD / 'sentient_cube.cc').read_text()
    match = re.search(rf'^.*\b{name}\([^;]*?\) \{{', source, re.MULTILINE)
    assert match, name
    depth = 0
    for i in range(match.end() - 1, len(source)):
        depth += (source[i] == '{') - (source[i] == '}')
        if depth == 0:
            return source[match.start():i + 1]
    raise AssertionError(name)


def test_synthetic_release_and_physical_read_validity():
    source = (BOARD / 'sentient_cube.cc').read_text()
    state = source[source.index('struct SynthTap {'):source.index('static int cube_snapshot_provider')]
    cpp = '''
#include <cassert>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include "cube_presentation.h"
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
#define ESP_OK 0
#define LV_INDEV_STATE_RELEASED 0
#define LV_INDEV_STATE_PRESSED 1
struct lv_point_t { long x, y; };
struct lv_indev_t {};
struct lv_indev_data_t { lv_point_t point{}; int state = 0; };
using esp_lcd_touch_handle_t = void*;
void* driver = reinterpret_cast<void*>(1);
void* lv_indev_get_driver_data(lv_indev_t*) { return &driver; }
bool physical_valid = false, physical_pressed = false;
int reads = 0;
int esp_lcd_touch_read_data(esp_lcd_touch_handle_t) { ++reads; return physical_valid ? ESP_OK : -1; }
bool esp_lcd_touch_get_coordinates(esp_lcd_touch_handle_t, uint16_t* x,
    uint16_t* y, uint16_t*, uint8_t* count, int) {
    *x = 20; *y = 30; *count = physical_pressed ? 1 : 0; return physical_pressed;
}
int64_t now = 0;
int64_t esp_timer_get_time() { return now; }
bool lvgl_port_lock(int) { return true; }
void lvgl_port_unlock() {}
std::atomic<bool> s_display_asleep{false};
CubeWakeGesture s_wake_gesture;
struct Timer { void WakeUp() { s_display_asleep = false; } } timer;
struct Board { static Board& GetInstance(); };
struct SentientCubeBoard : Board { Timer* power_save_timer_ = &timer; } board;
Board& Board::GetInstance() { return board; }
void sentient_test_screen_set_touch_xy(long, long, bool) {}
void esp32_devtool_companion_event(const char*) {}
''' + state + entry('cube_touch_inject') + '\n' + entry('SafeTouchReadCb') + '\n' + entry('SentientTouchReadCb') + '''
int main() {
    lv_indev_t indev;
    lv_indev_data_t data;
    auto tick = [&] { SentientTouchReadCb(&indev, &data); return data.state; };
    s_display_asleep = true;
    assert(cube_touch_inject(100, 200, 100) == 0);
    assert(tick() == LV_INDEV_STATE_RELEASED && !s_display_asleep);
    now = 50000;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    now = 100000;
    assert(tick() == LV_INDEV_STATE_RELEASED && reads == 0);
    assert(tick() == LV_INDEV_STATE_RELEASED && reads == 1); // invalid CST9217
    assert(cube_touch_inject(100, 200, 100) == 0);
    assert(tick() == LV_INDEV_STATE_PRESSED); // next hold reaches LVGL/capture
    now = 200000;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    // Genuine wake: invalid physical read must NOT clear consumed gesture.
    physical_valid = physical_pressed = true;
    s_display_asleep = true;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    physical_valid = false;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    physical_valid = true;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    physical_pressed = false;
    assert(tick() == LV_INDEV_STATE_RELEASED);
    physical_pressed = true;
    assert(tick() == LV_INDEV_STATE_PRESSED);
    physical_valid = false;
    assert(tick() == LV_INDEV_STATE_RELEASED); // press-lost remains safe
}
'''
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        (tmp / 'test.cc').write_text(cpp)
        subprocess.run(['c++', '-std=c++17', '-I', str(BOARD), str(tmp / 'test.cc'),
                        '-o', str(tmp / 'test')], check=True)
        subprocess.run([str(tmp / 'test')], check=True)


def test_snapshot_borrowed_buffer_with_native_lvgl():
    # Use pinned renderer, including its reshape/stride/capacity semantics.
    lvgl = FIRMWARE / 'managed_components/lvgl__lvgl'
    cpp = '''
#include <cassert>
#include <cstdint>
#include <cstring>
#include "lvgl.h"
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
constexpr int kSnapLvglLockMs = 2000;
bool setup = false, visible = false, busy = false, locked = false;
bool capturing = false, capture_on_lock = false;
bool cube_voice_processing() { return capturing; }
namespace sentient::cube {
struct CubeHardware {
    static CubeHardware& Get() { static CubeHardware h; return h; }
    struct State { bool setup; };
    State Presentation() { return {setup}; }
};
}
bool cube_setup_display_visible() { assert(locked); return visible; }
bool lvgl_port_lock(int) {
    if (busy) return false;
    if (capture_on_lock) capturing = true;
    locked = true; return true;
}
void lvgl_port_unlock() { assert(locked); locked = false; }
''' + entry('cube_capture_ui_snapshot') + '''
int main() {
    lv_init();
    auto* display = lv_display_create(466, 466);
    auto* screen = lv_screen_active();
    lv_obj_set_style_bg_color(screen, lv_color_hex(0xff0000), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    auto* lower = lv_obj_create(screen);
    lv_obj_remove_style_all(lower);
    lv_obj_set_pos(lower, 0, 233);
    lv_obj_set_size(lower, 466, 233);
    lv_obj_set_style_bg_color(lower, lv_color_hex(0x0000ff), 0);
    lv_obj_set_style_bg_opa(lower, LV_OPA_COVER, 0);
    alignas(64) uint16_t pixels[480 * 480 + 32];
    constexpr size_t capacity = 480 * 480 * 2;
    int w = -1, h = -1;
    auto capture = [&](size_t cap = capacity) {
        int result = cube_capture_ui_snapshot(pixels, cap, &w, &h);
        assert(!locked); return result;
    };
    for (int repeat = 0; repeat < 2; ++repeat) {
        std::memset(pixels, 0xa5, sizeof(pixels));
        assert(capture() == 0 && w == 466 && h == 466);
        for (int i = 0; i < w * h; ++i)
            assert(pixels[i] == (i < w * 233 ? 0xf800 : 0x001f));
        assert(pixels[480 * 480] == 0xa5a5);
    }
    std::memset(pixels, 0xa5, sizeof(pixels));
    assert(capture(466 * 466 * 2) == -1); // padded rows exceed packed capacity
    assert(pixels[0] == 0xa5a5);
    assert(capture(1) == -1);
    assert(cube_capture_ui_snapshot(pixels + 1, capacity - 2, &w, &h) == -1);
    setup = true; assert(capture() == -1); setup = false;
    visible = true; assert(capture() == -1); visible = false;
    busy = true; assert(capture() == -1); busy = false;
    capturing = true; assert(capture() == -1); capturing = false;
    capture_on_lock = true; assert(capture() == -1);
    capture_on_lock = capturing = false;
    assert(pixels[0] == 0xa5a5);
    lv_obj_delete(lower);
    lv_display_set_resolution(display, 480, 480); // packed stride, no copy
    assert(capture() == 0 && w == 480 && h == 480);
    for (int i = 0; i < w * h; ++i) assert(pixels[i] == 0xf800);
    // Native reshape includes extended drawing bounds; oversized render refused.
    lv_display_set_resolution(display, 500, 500);
    assert(capture() == -1);
    lv_display_delete(display);
    lv_deinit();
}
'''
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        (tmp / 'test.cc').write_text(cpp)
        (tmp / 'lv_conf.h').write_text('''#define LV_USE_SNAPSHOT 1
#define LV_DRAW_BUF_STRIDE_ALIGN 8
#define LV_DRAW_BUF_ALIGN 64
#define LV_USE_LOG 0
#define LV_USE_OS LV_OS_NONE
''')
        (tmp / 'CMakeLists.txt').write_text(f'''
cmake_minimum_required(VERSION 3.16)
project(snapshot_check C CXX)
set(CMAKE_CXX_STANDARD 17)
set(LV_CONF_PATH "{tmp / 'lv_conf.h'}" CACHE STRING "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)
add_subdirectory("{lvgl}" lvgl)
add_executable(check test.cc)
target_link_libraries(check PRIVATE lvgl)
''')
        subprocess.run(['cmake', '-S', str(tmp), '-B', str(tmp / 'build')], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        build = subprocess.run(['cmake', '--build', str(tmp / 'build'), '-j', '8'],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        assert build.returncode == 0, build.stdout[-12000:]
        subprocess.run([str(tmp / 'build/check')], check=True, timeout=10)
