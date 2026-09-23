"""Exercise production NoAudioProcessor capture/feed methods without IDF or hardware."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'firmware/main/audio/processors/no_audio_processor.cc'


def method(name):
    match = re.search(rf'^(?:bool|void) NoAudioProcessor::{name}\([^\n]*\) \{{.*?^\}}',
                      SOURCE.read_text(), re.MULTILINE | re.DOTALL)
    if not match:
        raise AssertionError(f'missing NoAudioProcessor::{name}')
    return match.group()


class ProcessorCaptureBoundaryTest(unittest.TestCase):
    def test_staged_and_late_input_cannot_cross_capture(self):
        cpp = r'''
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
#include <vector>
struct Codec { int input_channels() { return 1; } };
struct NoAudioProcessor {
    Codec* codec_ = nullptr;
    int frame_samples_ = 2;
    std::vector<int16_t> output_buffer_;
    std::function<void(std::vector<int16_t>&&, uint32_t)> output_callback_;
    std::atomic<bool> is_running_ = false;
    std::timed_mutex feed_mutex_;
    uint32_t capture_generation_ = 0;
    std::atomic<bool> stopped_cleanly_ = true;
    void Feed(std::vector<int16_t>&&, uint32_t);
    bool Start(uint32_t);
    bool Stop();
};
''' + '\n'.join(method(name) for name in ('Feed', 'Start', 'Stop')) + r'''
int main() {
    Codec codec;
    NoAudioProcessor p;
    p.codec_ = &codec;
    std::vector<std::vector<int16_t>> frames;
    std::vector<uint32_t> generations;
    p.output_callback_ = [&](std::vector<int16_t>&& data, uint32_t generation) {
        frames.push_back(std::move(data));
        generations.push_back(generation);
    };
    assert(p.Start(1));
    p.Feed({10}, 1);                  // partial old frame staged
    assert(p.Stop());                // stop drops partial frame
    assert(p.Start(2));
    p.Feed({11, 12}, 1);              // delayed read from prior capture
    p.Feed({20, 21}, 2);
    assert(frames.size() == 1);
    assert((frames[0] == std::vector<int16_t>{20, 21}));
    assert(generations[0] == 2);
    assert(p.Stop());
}
'''
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'processor.cc'
            source.write_text(cpp)
            binary = Path(directory) / 'processor'
            subprocess.run(['c++', '-std=c++17', '-pthread', str(source), '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
