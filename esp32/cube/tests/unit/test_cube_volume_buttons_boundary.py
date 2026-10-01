"""Run the production Cube button callbacks against host codec/display stubs."""
from pathlib import Path
import subprocess
import tempfile
import unittest

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'
BOARD = MAIN / 'boards/sentient-cube/sentient_cube.cc'
CONFIG = MAIN / 'boards/sentient-cube/config.h'


def function(source, marker):
    start = source.index(marker)
    opening = source.index('{', start)
    depth = 0
    for pos in range(opening, len(source)):
        depth += (source[pos] == '{') - (source[pos] == '}')
        if depth == 0:
            return source[start:pos + 1]
    raise AssertionError(f'unclosed function: {marker}')


class CubeVolumeButtonsBoundaryTest(unittest.TestCase):
    def test_press_down_events_schedule_each_clamped_volume_change(self):
        source = BOARD.read_text()
        callback = function(source, 'void InitializeButtons()')
        callback = callback.replace('void InitializeButtons()',
                                    'void SentientCubeBoard::InitializeButtons()', 1)
        config = CONFIG.read_text()
        self.assertIn('#define VOLUME_UP_BUTTON_GPIO GPIO_NUM_18', config)
        self.assertIn('#define BOOT_BUTTON_GPIO GPIO_NUM_0', config)
        self.assertIn('Button volume_up_button_;', source)
        self.assertIn('Button boot_button_;', source)
        self.assertIn('volume_up_button_(VOLUME_UP_BUTTON_GPIO), boot_button_(BOOT_BUTTON_GPIO)', source)
        self.assertNotIn('ToggleChatState', callback)
        self.assertNotIn('SetAecMode', callback)
        self.assertNotIn('OnDoubleClick', callback)
        self.assertNotIn('OnClick', callback)
        self.assertNotIn('OnLongPress', callback)
        self.assertNotIn('OnPressRepeat', callback)
        self.assertEqual(callback.count('.OnPressDown('), 2)
        # Base display keeps its legacy header on its inactive screen; Cube
        # scene owns visible status art without stealing button feedback.
        setup = function(source, 'virtual void SetupUI() override')
        self.assertNotIn('lv_obj_set_parent(top_bar_', setup)

        cpp = r'''
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <functional>
#include <string>
#include <utility>
#include <vector>
#define VOLUME_UP_BUTTON_GPIO 18
#define BOOT_BUTTON_GPIO 0
#define TAG "test"
#define ESP_LOGI(...) ((void)0)
enum { kDeviceStateStarting, kDeviceStateIdle };
struct AudioCodec {
    int volume = 70, writes = 0;
    int output_volume() const { return volume; }
    void SetOutputVolume(int value) { volume = value; ++writes; }
};
struct Display {

};
struct Application {
    std::vector<std::function<void()>> tasks;
    int state = kDeviceStateIdle;
    static Application& GetInstance() { static Application app; return app; }
    int GetDeviceState() const { return state; }
    void Schedule(std::function<void()>&& task) { tasks.push_back(std::move(task)); }
    void RunScheduled() {
        auto pending = std::move(tasks);
        tasks.clear();
        for (auto& task : pending) task();
    }
};
struct Button {
    std::function<void()> press_down;
    int registrations = 0;
    void OnPressDown(std::function<void()> callback) {
        press_down = std::move(callback);
        ++registrations;
    }
    void PressDown() { press_down(); }
};
struct SentientCubeBoard {
    Button volume_up_button_, boot_button_;
    AudioCodec codec;
    Display display;
    int wifi_config_requests = 0;
    AudioCodec* GetAudioCodec() { return &codec; }
    Display* GetDisplay() { return &display; }
    void EnterWifiConfigMode() { ++wifi_config_requests; }
    void InitializeButtons();
};
''' + 'int shown_volume = -1; void sentient_cube_show_volume(int value) { shown_volume = value; }\n' + callback + r'''
int main() {
    auto& app = Application::GetInstance();
    SentientCubeBoard board;
    board.InitializeButtons();
    assert(board.volume_up_button_.registrations == 1);
    assert(board.boot_button_.registrations == 1);
    app.state = kDeviceStateStarting;
    board.boot_button_.PressDown(); // Preserve existing startup Wi-Fi-config action.
    assert(board.wifi_config_requests == 1 && app.tasks.empty() && board.codec.writes == 0);
    app.state = kDeviceStateIdle;

    board.codec.volume = 98;
    board.volume_up_button_.PressDown();
    assert(app.tasks.size() == 1 && board.codec.writes == 0 && shown_volume == -1);
    app.RunScheduled();
    assert(board.codec.volume == 100 && board.codec.writes == 1);
    assert(shown_volume == 100);

    board.codec.volume = 50;
    board.volume_up_button_.PressDown();
    board.volume_up_button_.PressDown(); // Rapid second tap still counts separately.
    assert(app.tasks.size() == 2 && board.codec.writes == 1);
    app.RunScheduled();
    assert(board.codec.volume == 60 && board.codec.writes == 3);
    assert(shown_volume == 60);

    board.codec.volume = 3;
    board.boot_button_.PressDown();
    assert(app.tasks.size() == 1 && board.codec.writes == 3);
    app.RunScheduled();
    assert(board.codec.volume == 0 && board.codec.writes == 4);
    assert(shown_volume == 0);

    board.codec.volume = 50;
    board.boot_button_.PressDown();
    app.RunScheduled();
    assert(board.codec.volume == 45 && board.codec.writes == 5);
    assert(shown_volume == 45);

    board.volume_up_button_.PressDown();
    app.RunScheduled();
    assert(board.codec.volume == 50 && board.codec.writes == 6);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source_file = Path(directory) / 'buttons.cc'
            source_file.write_text(cpp)
            binary = Path(directory) / 'buttons'
            subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra',
                            str(source_file), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
