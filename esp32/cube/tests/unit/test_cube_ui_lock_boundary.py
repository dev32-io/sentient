"""Compile production Cube UI entry points against a simulated LVGL render lock."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/boards/sentient-cube/sentient_ui_controller.cc'


def entry(name):
    source = SOURCE.read_text()
    match = re.search(rf'^void {name}\([^\n]*\) \{{', source, re.MULTILINE)
    if not match:
        raise AssertionError(f'missing {name}')
    start = match.start()
    depth = 0
    for i in range(match.end() - 1, len(source)):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                return source[start:i + 1]
    raise AssertionError(f'unclosed {name}')


class CubeUiLockBoundaryTest(unittest.TestCase):
    def test_mutations_wait_for_render_and_creation_can_reenter_lock(self):
        cpp = r'''
#include <atomic>
#include <cassert>
#include <chrono>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#define SENTIENT_DEVICE_ID "host"
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define tskIDLE_PRIORITY 0
#define pdPASS 1
using BaseType_t = int;
std::recursive_mutex port;
bool lvgl_port_lock(int) { port.lock(); return true; }
void lvgl_port_unlock() { port.unlock(); }
enum sentient_ui_state_t { SENTIENT_UI_DISABLED, SENTIENT_UI_READY, SENTIENT_UI_LISTENING };
sentient_ui_state_t g_state = SENTIENT_UI_DISABLED;
bool g_poll_started = false;
void poll_state_task(void*) {}
int xTaskCreate(void (*)(void*), const char*, int, void*, int, void*) { return pdPASS; }
std::string hint, transcript;
std::atomic<int> creations{0}, applied{0}, hint_calls{0}, transcript_calls{0}, test_screens{0};
void sentient_test_screen_build() { ++test_screens; }
void toggle_button_screen_create() { ++creations; }
void toggle_button_screen_apply_state(sentient_ui_state_t) { ++applied; }
void toggle_button_screen_set_status_hint(const char* text) { hint = text; ++hint_calls; }
void toggle_button_screen_set_transcript(const char* text) { transcript = text; ++transcript_calls; }
''' + '\n'.join(entry(name) for name in (
            'sentient_cube_create_toggle_button_screen', 'sentient_cube_set_state',
            'sentient_cube_set_status_hint', 'sentient_cube_set_transcript',
            'sentient_cube_show_test_screen')) + r'''
int main() {
    // SetupUI owns port lock during board construction; recursion must work.
    port.lock();
    sentient_cube_create_toggle_button_screen();
    assert(creations == 1 && applied == 1);
    port.unlock();

    auto during_render = [](auto setter, auto unchanged, auto updated) {
        port.lock(); // LVGL task rendering on another thread
        std::promise<void> started;
        auto ready = started.get_future();
        std::thread worker([&] { started.set_value(); setter(); });
        ready.wait();
        // Worker cannot complete while rendering; baseline without lock fails.
        std::this_thread::sleep_for(std::chrono::milliseconds(40));
        assert(unchanged());
        port.unlock();
        worker.join();
        assert(updated());
    };
    during_render([] { sentient_cube_set_status_hint("Recording"); },
                  [] { return hint_calls == 0; }, [] { return hint == "Recording"; });
    during_render([] { sentient_cube_set_transcript("heard"); },
                  [] { return transcript_calls == 0; }, [] { return transcript == "heard"; });
    during_render([] { sentient_cube_set_state(SENTIENT_UI_LISTENING); },
                  [] { return applied == 1; },
                  [] { return g_state == SENTIENT_UI_LISTENING && applied == 2; });
    during_render([] { sentient_cube_show_test_screen(); },
                  [] { return test_screens == 0; }, [] { return test_screens == 1; });
    sentient_cube_set_state(SENTIENT_UI_LISTENING);
    assert(applied == 2); // state comparison and mutation share lock
}
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'ui.cc'
            path.write_text(cpp)
            binary = Path(directory) / 'ui'
            subprocess.run(['c++', '-std=c++17', '-pthread', str(path), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
