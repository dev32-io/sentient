#ifndef DUMMY_AUDIO_PROCESSOR_H
#define DUMMY_AUDIO_PROCESSOR_H

#include <vector>
#include <functional>
#include <atomic>
#include <mutex>

#include "audio_processor.h"
#include "audio_codec.h"

class NoAudioProcessor : public AudioProcessor {
public:
    NoAudioProcessor() = default;
    ~NoAudioProcessor() = default;

    void Initialize(AudioCodec* codec, int frame_duration_ms, srmodel_list_t* models_list) override;
    void Feed(std::vector<int16_t>&& data, uint32_t capture_generation) override;
    bool Start(uint32_t capture_generation) override;
    bool Stop() override;
    bool IsRunning() override;
    void OnOutput(std::function<void(std::vector<int16_t>&& data, uint32_t capture_generation)> callback) override;
    void OnVadStateChange(std::function<void(bool speaking)> callback) override;
    size_t GetFeedSize() override;
    void EnableDeviceAec(bool enable) override;

private:
    AudioCodec* codec_ = nullptr;
    int frame_samples_ = 0;
    std::vector<int16_t> output_buffer_;
    std::function<void(std::vector<int16_t>&& data, uint32_t capture_generation)> output_callback_;
    std::function<void(bool speaking)> vad_state_change_callback_;
    std::atomic<bool> is_running_ = false;
    std::timed_mutex feed_mutex_;
    uint32_t capture_generation_ = 0;
    std::atomic<bool> stopped_cleanly_ = true;
};

#endif 