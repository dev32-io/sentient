"""Exercise production latest-state setters and projection with a busy LVGL lock."""
from pathlib import Path
import re
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube/sentient_ui_controller.cc'


def entry(name):
    source = SOURCE.read_text()
    match = re.search(rf'^(?:static )?void {name}\([^\n]*\) \{{', source, re.MULTILINE)
    assert match, name
    depth = 0
    for i in range(match.end() - 1, len(source)):
        depth += (source[i] == '{') - (source[i] == '}')
        if depth == 0:
            return source[match.start():i + 1]
    raise AssertionError(name)


def test_latest_state_survives_render_lock_contention():
    # Test real setters and retry projector, not a duplicate state machine.
    source = SOURCE.read_text()
    assert 'project_latest(hardware);' in source[source.index('static void poll_state_task'):source.index('// Public C API')]
    cpp = '''
#include <cassert>
#include <cstdint>
#include <mutex>
#include <string>
#include "cube_presentation.h"
namespace sentient::cube {
struct CubePresentation { bool setup, pairing, account_attention; std::string qr, locator, proof; };
}
using portMUX_TYPE = std::mutex;
#define portENTER_CRITICAL(m) (m)->lock()
#define portEXIT_CRITICAL(m) (m)->unlock()
#define portMUX_INITIALIZER_UNLOCKED {}
portMUX_TYPE g_signal_mux = portMUX_INITIALIZER_UNLOCKED;
CubeSignals g_signals;
int g_volume_percent = 0;
int g_battery_percent = 0;
int64_t g_volume_until_us = 0;
int g_boot_result = 0;
int boot_calls = 0;
bool boot_ready = false;
void toggle_button_screen_finish_boot(bool ready) { ++boot_calls; boot_ready = ready; }
bool busy = true;
int64_t clock_us = 0;
int64_t esp_timer_get_time() { return clock_us; }
bool lvgl_port_lock(int) { return !busy; }
void lvgl_port_unlock() {}
CubeScene drawn = CubeScene::NoWifi;
int paints = 0;
int shown_volume = -1;
int shown_battery = -1;
bool shown_charging = false, shown_low = false;
void toggle_button_screen_volume(int v) { shown_volume = v; }
void toggle_button_screen_battery(int percent, bool charging, bool low) {
    shown_battery = percent; shown_charging = charging; shown_low = low;
}
void toggle_button_screen_pairing(const char*, const char*, const char*) {}
void toggle_button_screen_apply_scene(CubeScene s) { drawn = s; ++paints; }
''' + entry('project_latest') + '\nextern "C" {\n' + '\n'.join(entry(name) for name in (
        'sentient_cube_set_wifi', 'sentient_cube_set_processing',
        'sentient_cube_set_playback', 'sentient_cube_set_sleep',
        'sentient_cube_set_battery', 'sentient_cube_set_battery_level',
        'sentient_cube_show_volume', 'sentient_cube_finish_boot')) + '''
}
int main() {
    sentient_cube_finish_boot(true); // Nonblocking readiness survives busy LVGL.
    assert(boot_calls == 0);
    sentient_cube_set_wifi(true);
    // Connection is sampled by poll; all one-shot callbacks must survive contention.
    g_signals.connected = true;
    sentient_cube_set_processing(true);
    sentient_cube_set_playback(true);
    sentient_cube_set_sleep(true);
    project_latest();
    assert(paints == 0);
    busy = false;
    project_latest();
    assert(drawn == CubeScene::Sleep);
    assert(boot_calls == 1 && boot_ready);
    sentient_cube_finish_boot(false); // First result remains authoritative.
    assert(boot_ready);
    assert(shown_battery == 0 && !shown_charging && !shown_low); // Unknown stays empty.
    busy = true;
    sentient_cube_set_sleep(false); // Wake false is not replayed by poll.
    project_latest();
    busy = false;
    project_latest();
    assert(drawn == CubeScene::Speaking);
    busy = true;
    sentient_cube_set_playback(false);
    project_latest();
    busy = false;
    project_latest();
    assert(drawn == CubeScene::Thinking);
    sentient_cube_set_processing(false);
    project_latest();
    assert(drawn == CubeScene::Ready);
    busy = true;
    sentient_cube_set_battery_level(80);
    sentient_cube_set_battery(false, true);
    sentient_cube_set_battery_level(12); // Latest value wins without waiting on LVGL.
    project_latest();
    assert(shown_battery == 0 && !shown_low);
    busy = false;
    project_latest();
    assert(drawn == CubeScene::Low);
    assert(shown_battery == 12 && !shown_charging && shown_low);
    sentient_cube_set_battery(true, false);
    sentient_cube_set_battery_level(42);
    project_latest();
    assert(drawn == CubeScene::Charging);
    assert(shown_battery == 42 && shown_charging && !shown_low);
    sentient_cube_set_battery(false, true);
    busy = true;
    sentient_cube_show_volume(65);
    project_latest();
    busy = false;
    project_latest();
    assert(drawn == CubeScene::Volume && shown_volume == 65);
    clock_us = 1500001;
    project_latest();
    assert(drawn == CubeScene::Low);
}
'''
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'test.cc'
        path.write_text(cpp)
        binary = Path(directory) / 'test'
        subprocess.run(['c++', '-std=c++17', '-pthread', '-I', str(SOURCE.parent),
                        str(path), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True, timeout=5)
