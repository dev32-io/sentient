"""Host regression for production RecordPcm full-frame acquisition and mono output."""
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/audio/audio_service.cc'


def record_pcm_source():
    text = SOURCE.read_text()
    start = text.index('bool AudioService::RecordPcm(')
    opening = text.index('{', start)
    depth = 0
    for pos in range(opening, len(text)):
        depth += (text[pos] == '{') - (text[pos] == '}')
        if depth == 0:
            return text[start:pos + 1]
    raise AssertionError('RecordPcm body not found')


class RecordPcmBoundaryTest(unittest.TestCase):
    def test_full_frame_reads_exact_mono_output_and_read_failures(self):
        cpp = r'''
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <vector>
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGI(...) ((void)0)
#define TAG "test"
struct Codec {
    int input_channels() const { return 2; }
};
struct AudioService {
    Codec* codec_ = nullptr;
    int reads = 0;
    int fail_on_read = 0;
    std::chrono::steady_clock::time_point last_input_time_;
    bool ReadAudioData(std::vector<int16_t>& chunk, int rate, int samples) {
        ++reads;
        assert(rate == 16000 && samples == 480);
        if (reads == fail_on_read) return false;
        chunk.resize(samples * 2);
        for (int i = 0; i < samples; ++i) {
            chunk[2 * i] = static_cast<int16_t>(((reads - 2) * 480 + i) % 30000);
            chunk[2 * i + 1] = -12345;
        }
        return true;
    }
    bool RecordPcm(int16_t*, size_t, int);
};
''' + record_pcm_source() + r'''
int main() {
    Codec codec;
    for (size_t count : {size_t(1), size_t(480), size_t(481), size_t(16000)}) {
        AudioService service;
        service.codec_ = &codec;
        std::vector<int16_t> dst(count + 1, -22222);
        assert(service.RecordPcm(dst.data(), count, 16000));
        assert(service.reads == 1 + static_cast<int>((count + 479) / 480));
        for (size_t i = 0; i < count; ++i)
            assert(dst[i] == static_cast<int16_t>(i % 30000));
        assert(dst[count] == -22222);
    }
    for (int failed_read : {1, 3}) {
        AudioService service;
        service.codec_ = &codec;
        service.fail_on_read = failed_read;
        std::vector<int16_t> dst(481);
        assert(!service.RecordPcm(dst.data(), 481, 16000));
        assert(service.reads == failed_read);
    }
}
'''
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'record_pcm.cc'
            file.write_text(cpp)
            binary = Path(directory) / 'record_pcm'
            subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                            str(file), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
