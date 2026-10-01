"""Run production fade bodies: immediate wake cancels an unticked sleep fade."""
from pathlib import Path
import re
import subprocess


def test_wake_cancels_pending_fade(tmp_path):
    source = (Path(__file__).resolve().parents[2] / 'firmware/main/boards/common/backlight.cc').read_text()
    methods = '\n'.join(re.search(rf'^void Backlight::{name}\([^\n]*\) \{{.*?^\}}',
        source, re.M | re.S).group() for name in ('SetBrightness', 'OnTransitionTimer'))
    cpp = r'''
#include <cassert>
#include <cstdint>
#define ESP_LOGI(...) ((void)0)
struct Timer { bool running = false; } timer;
void esp_timer_stop(Timer* t) { t->running = false; }
void esp_timer_start_periodic(Timer* t, int) { t->running = true; }
struct Settings {
    static inline int saved = 75;
    Settings(const char*, bool) {}
    void SetInt(const char*, int value) { saved = value; }
};
struct Backlight {
    Timer* transition_timer_ = &timer;
    uint8_t brightness_ = 75, target_brightness_ = 75, step_ = 1;
    int output = 75;
    void SetBrightness(uint8_t, bool = false);
    void OnTransitionTimer();
    void SetBrightnessImpl(uint8_t value) { output = value; }
};
''' + methods + r'''
int main() {
    Backlight light;
    for (int ticks : {0, 1, 30, 75}) {
        light.SetBrightness(0);
        for (int i = 0; i < ticks; ++i) light.OnTransitionTimer();
        light.SetBrightness(Settings::saved);
        for (int i = 0; i < 100; ++i) light.OnTransitionTimer();
        assert(light.brightness_ == 75 && light.output == 75 && !timer.running);
    }
    light.SetBrightness(0);
    light.SetBrightness(75, true);
    assert(!timer.running && Settings::saved == 75);
    light.OnTransitionTimer(); // Already-dispatched tick must also be harmless.
    assert(light.output == 75);
    light.SetBrightness(255, true);
    for (int i = 0; i < 100; ++i) light.OnTransitionTimer();
    assert(light.output == 100 && Settings::saved == 100);
    light.SetBrightness(0);
    for (int i = 0; i < 100; ++i) light.OnTransitionTimer();
    assert(light.output == 0 && Settings::saved == 100 && !timer.running);
}
'''
    cpp = '#include <initializer_list>\n' + cpp
    (tmp_path / 'check.cc').write_text(cpp)
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    str(tmp_path / 'check.cc'), '-o', str(tmp_path / 'check')], check=True)
    subprocess.run([str(tmp_path / 'check')], check=True)
