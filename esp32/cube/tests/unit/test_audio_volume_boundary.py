"""Exercise production codec volume bounds and zero persistence without IDF."""
from pathlib import Path
import subprocess
import tempfile
import unittest

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


def function(source, marker):
    start = source.index(marker)
    opening = source.index('{', start)
    depth = 0
    for pos in range(opening, len(source)):
        depth += (source[pos] == '{') - (source[pos] == '}')
        if depth == 0:
            return source[start:pos + 1]
    raise AssertionError(f'unclosed function: {marker}')


class AudioVolumeBoundaryTest(unittest.TestCase):
    def test_clamps_hardware_and_saved_volume_and_restores_zero(self):
        audio = (MAIN / 'audio/audio_codec.cc').read_text()
        box = (MAIN / 'audio/codecs/box_audio_codec.cc').read_text()
        production = '\n'.join(function(audio, marker) for marker in (
            'void AudioCodec::Start()', 'void AudioCodec::SetOutputVolume('))
        setter = function(box, 'void BoxAudioCodec::SetOutputVolume(')
        enable_output = function(box, 'void BoxAudioCodec::EnableOutput(')
        self.assertIn('if (output_enabled_)', setter)
        self.assertIn('esp_codec_dev_set_out_vol(output_dev_, output_volume_)', enable_output)
        production += '\n' + setter
        cpp = r'''
#include <algorithm>
#include <cassert>
#include <mutex>
#include <shared_mutex>
#include <string>
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define TAG "test"
#define ESP_ERROR_CHECK(call) assert((call) == 0)
int saved_volume = 70, hardware_volume = -1;
struct Settings {
    bool write;
    int pending = 0;
    bool dirty = false;
    Settings(const std::string&, bool write = false) : write(write) {}
    ~Settings() { if (dirty) saved_volume = pending; }
    int GetInt(const std::string&, int fallback) { (void)fallback; return saved_volume; }
    void SetInt(const std::string&, int value) { pending = value; dirty = true; }
};
struct AudioCodec {
    int output_volume_ = 70;
    int output_volume() const { return output_volume_; }
    void Start();
    void SetOutputVolume(int);
};
struct BoxAudioCodec : AudioCodec {
    std::shared_mutex data_if_mutex_;
    int output_dev_ = 0;
    bool output_enabled_ = false;
    void SetOutputVolume(int);
};
int esp_codec_dev_set_out_vol(int, int volume) { hardware_volume = volume; return 0; }
''' + production + r'''
int main() {
    saved_volume = 0;
    AudioCodec restored;
    restored.Start();
    assert(restored.output_volume() == 0);

    restored.SetOutputVolume(-5);
    assert(restored.output_volume() == 0 && saved_volume == 0);
    AudioCodec next_boot;
    next_boot.Start();
    assert(next_boot.output_volume() == 0);

    restored.SetOutputVolume(105);
    assert(restored.output_volume() == 100 && saved_volume == 100);
    saved_volume = 150;
    AudioCodec clamped_on_start;
    clamped_on_start.Start();
    assert(clamped_on_start.output_volume() == 100);

    BoxAudioCodec box;
    box.SetOutputVolume(-5);
    assert(hardware_volume == -1 && box.output_volume() == 0 && saved_volume == 0);
    box.SetOutputVolume(60);
    assert(hardware_volume == -1 && box.output_volume() == 60 && saved_volume == 60);
    box.output_enabled_ = true;
    box.SetOutputVolume(105);
    assert(hardware_volume == 100 && box.output_volume() == 100 && saved_volume == 100);
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'volume.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'volume'
            subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra',
                            str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
