#ifndef AFE_AUDIO_PROCESSOR_H
#define AFE_AUDIO_PROCESSOR_H

#include <esp_afe_sr_models.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/event_groups.h>

#include <string>
#include <vector>
#include <functional>
#include <mutex>
#include <condition_variable>
#include <atomic>

#include "audio_processor.h"
#include "audio_codec.h"

class AfeAudioProcessor : public AudioProcessor {
public:
    AfeAudioProcessor();
    ~AfeAudioProcessor();

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
    EventGroupHandle_t event_group_ = nullptr;
    const esp_afe_sr_iface_t* afe_iface_ = nullptr;
    esp_afe_sr_data_t* afe_data_ = nullptr;
    std::function<void(std::vector<int16_t>&& data, uint32_t capture_generation)> output_callback_;
    std::function<void(bool speaking)> vad_state_change_callback_;
    AudioCodec* codec_ = nullptr;
    int frame_samples_ = 0;
    bool is_speaking_ = false;
    std::vector<int16_t> input_buffer_;
    std::timed_mutex input_buffer_mutex_;
    std::condition_variable_any stopped_cv_;
    std::atomic<bool> stop_requested_ = true;
    bool running_ = false;
    bool stopped_ = true;
    bool reset_ok_ = true;
    uint32_t capture_generation_ = 0;
    std::vector<int16_t> output_buffer_;

    void AudioProcessorTask();
};

#endif 