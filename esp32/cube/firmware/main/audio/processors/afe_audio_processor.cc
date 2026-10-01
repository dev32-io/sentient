#include "afe_audio_processor.h"
#include <esp_log.h>
#include <chrono>
#include <cstdlib>
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
#include <esp_heap_caps.h>
#include <freertos/idf_additions.h>
#endif

#define PROCESSOR_RUNNING 0x01

#define TAG "AfeAudioProcessor"

AfeAudioProcessor::AfeAudioProcessor()
    : afe_data_(nullptr) {
    event_group_ = xEventGroupCreate();
}

void AfeAudioProcessor::Initialize(AudioCodec* codec, int frame_duration_ms, srmodel_list_t* models_list) {
    codec_ = codec;
    frame_samples_ = frame_duration_ms * 16000 / 1000;

    // Pre-allocate output buffer capacity
    output_buffer_.reserve(frame_samples_);

    int ref_num = codec_->input_reference() ? 1 : 0;

    std::string input_format;
    for (int i = 0; i < codec_->input_channels() - ref_num; i++) {
        input_format.push_back('M');
    }
    for (int i = 0; i < ref_num; i++) {
        input_format.push_back('R');
    }

    srmodel_list_t *models;
    if (models_list == nullptr) {
        models = esp_srmodel_init("model");
    } else {
        models = models_list;
    }

    char* ns_model_name = esp_srmodel_filter(models, ESP_NSNET_PREFIX, NULL);
    char* vad_model_name = esp_srmodel_filter(models, ESP_VADN_PREFIX, NULL);
    
    afe_config_t* afe_config = afe_config_init(input_format.c_str(), NULL, AFE_TYPE_VC, AFE_MODE_HIGH_PERF);
    afe_config->aec_mode = AEC_MODE_VOIP_HIGH_PERF;
    afe_config->vad_mode = VAD_MODE_0;
    afe_config->vad_min_noise_ms = 100;
    if (vad_model_name != nullptr) {
        afe_config->vad_model_name = vad_model_name;
    }

    if (ns_model_name != nullptr) {
        afe_config->ns_init = true;
        afe_config->ns_model_name = ns_model_name;
        afe_config->afe_ns_mode = AFE_NS_MODE_NET;
    } else {
        afe_config->ns_init = false;
    }

    afe_config->agc_init = false;
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    afe_config->afe_linear_gain = CONFIG_CUBE_AFE_GAIN_PERCENT / 100.0f;
#endif
    afe_config->memory_alloc_mode = AFE_MEMORY_ALLOC_MORE_PSRAM;

#ifdef CONFIG_USE_DEVICE_AEC
    afe_config->aec_init = true;
    afe_config->vad_init = false;
#else
    afe_config->aec_init = false;
    afe_config->vad_init = true;
#endif

    afe_iface_ = esp_afe_handle_from_config(afe_config);
    afe_data_ = afe_iface_->create_from_config(afe_config);
    
    // Fetch/reset + queue callbacks do not write flash/NVS. As with opus_codec,
    // keep full stack in PSRAM; flash owners remain on internal stacks and IDF
    // suspends this worker during cache-off operations. Do not add flash calls.
    if (afe_data_ == nullptr || event_group_ == nullptr) {
        ESP_LOGE(TAG, "AFE allocation failed");
        std::abort();
    }
    auto worker = [](void* arg) {
        auto this_ = (AfeAudioProcessor*)arg;
        this_->AudioProcessorTask();
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
        vTaskDeleteWithCaps(NULL);
#else
        vTaskDelete(NULL);
#endif
    };
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    auto created = xTaskCreateWithCaps(worker, "audio_communication", 4096, this, 3,
                                       nullptr, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    auto created = xTaskCreate(worker, "audio_communication", 4096, this, 3, nullptr);
#endif
    if (created != pdPASS) {
        ESP_LOGE(TAG, "AFE worker allocation failed");
        std::abort();
    }
}

AfeAudioProcessor::~AfeAudioProcessor() {
    if (afe_data_ != nullptr) {
        afe_iface_->destroy(afe_data_);
    }
    vEventGroupDelete(event_group_);
}

size_t AfeAudioProcessor::GetFeedSize() {
    if (afe_data_ == nullptr) {
        return 0;
    }
    return afe_iface_->get_feed_chunksize(afe_data_);
}

void AfeAudioProcessor::Feed(std::vector<int16_t>&& data, uint32_t capture_generation) {
    if (afe_data_ == nullptr) {
        return;
    }

    std::lock_guard<std::timed_mutex> lock(input_buffer_mutex_);
    // Check running state inside lock to avoid TOCTOU race with Stop()
    if (!running_ || stop_requested_ || capture_generation != capture_generation_) {
        return;
    }
    input_buffer_.insert(input_buffer_.end(), data.begin(), data.end());
    size_t chunk_size = afe_iface_->get_feed_chunksize(afe_data_) * codec_->input_channels();
    while (!stop_requested_ && input_buffer_.size() >= chunk_size) {
        // ESP-SR 2.3.1 returns sr_rb_write's positive count on success,
        // zero on feed-ring-full (not ESP_FAIL). Never retry consumed DSP input.
        const int result = afe_iface_->feed(afe_data_, input_buffer_.data());
        if (result <= 0) {
            ESP_LOGE(TAG, "AFE feed failed generation=%lu result=%d staged_samples=%u",
                     (unsigned long)capture_generation_, result,
                     (unsigned)(input_buffer_.size() / codec_->input_channels()));
            feed_failed_ = true;
            stop_requested_ = true;
            running_ = false;
            xEventGroupSetBits(event_group_, PROCESSOR_RUNNING);
            return;
        }
        fed_samples_ += chunk_size / codec_->input_channels();
        input_buffer_.erase(input_buffer_.begin(), input_buffer_.begin() + chunk_size);
    }
}

bool AfeAudioProcessor::Start(uint32_t capture_generation) {
    std::unique_lock<std::timed_mutex> lock(input_buffer_mutex_, std::defer_lock);
    if (!lock.try_lock_for(std::chrono::seconds(5)) || !stopped_ || !reset_ok_) return false;
    feed_failed_ = false;
    fed_samples_ = fetched_samples_ = 0;
    capture_generation_ = capture_generation;
    stop_requested_ = false;
    stopped_ = false;
    running_ = true;
    xEventGroupSetBits(event_group_, PROCESSOR_RUNNING);
    return true;
}

bool AfeAudioProcessor::Stop(bool drain) {
    if (!drain) stop_requested_ = true;
    std::unique_lock<std::timed_mutex> lock(input_buffer_mutex_, std::defer_lock);
    if (!lock.try_lock_for(std::chrono::seconds(5))) return false;
    if (stopped_) return reset_ok_ && !feed_failed_;
    if (drain && !feed_failed_) {
        // Producer is joined by AudioService first. Preserve its partial feed.
        if (!input_buffer_.empty()) {
            input_buffer_.resize(afe_iface_->get_feed_chunksize(afe_data_) * codec_->input_channels(), 0);
            if (afe_iface_->feed(afe_data_, input_buffer_.data()) <= 0) feed_failed_ = true;
            else fed_samples_ += input_buffer_.size() / codec_->input_channels();
            input_buffer_.clear();
        }
        draining_ = !feed_failed_;
        drain_deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds(4);
    }
    stop_requested_ = true;
    running_ = false;
    // Wake worker even if it has not entered fetch yet. Worker owns fetch and
    // reset: never reset AFE storage concurrently with fetch_with_delay.
    xEventGroupSetBits(event_group_, PROCESSOR_RUNNING);
    return stopped_cv_.wait_for(lock, std::chrono::seconds(5), [this] { return stopped_; }) && reset_ok_ && !feed_failed_;
}

bool AfeAudioProcessor::IsRunning() {
    std::lock_guard<std::timed_mutex> lock(input_buffer_mutex_);
    return running_ && !stop_requested_;
}

void AfeAudioProcessor::OnOutput(std::function<void(std::vector<int16_t>&& data, uint32_t capture_generation)> callback) {
    output_callback_ = callback;
}

void AfeAudioProcessor::OnVadStateChange(std::function<void(bool speaking)> callback) {
    vad_state_change_callback_ = callback;
}

void AfeAudioProcessor::AudioProcessorTask() {
    auto fetch_size = afe_iface_->get_fetch_chunksize(afe_data_);
    auto feed_size = afe_iface_->get_feed_chunksize(afe_data_);
    ESP_LOGI(TAG, "Audio communication task started, feed size: %d fetch size: %d",
        feed_size, fetch_size);

    while (true) {
        xEventGroupWaitBits(event_group_, PROCESSOR_RUNNING, pdFALSE, pdTRUE, portMAX_DELAY);

        uint32_t generation;
        {
            std::lock_guard<std::timed_mutex> lock(input_buffer_mutex_);
            if (draining_ && std::chrono::steady_clock::now() >= drain_deadline_) {
                draining_ = false;
                feed_failed_ = true;
            }
            if ((!running_ || stop_requested_) && !draining_) {
                // No in-flight fetch or callback remains. Drop staged PCM and
                // AFE ring data before permitting another capture to start.
                input_buffer_.clear();
                output_buffer_.clear();
                is_speaking_ = false;
                reset_ok_ = afe_iface_->reset_buffer(afe_data_) == 1;
                if (!reset_ok_) ESP_LOGE(TAG, "AFE reset_buffer failed");
                stopped_ = true;
                xEventGroupClearBits(event_group_, PROCESSOR_RUNNING);
                stopped_cv_.notify_all();
                continue;
            }
            generation = capture_generation_;
        }
        // ESP-SR accepts a tick timeout, unlike fetch(portMAX_DELAY). Stop
        // waits for this fetch and callback; no concurrent reset or feed.
        auto res = afe_iface_->fetch_with_delay(afe_data_, pdMS_TO_TICKS(100));
        if (res == nullptr || res->ret_value == ESP_FAIL) {
            bool finish_tail = false;
            {
                std::lock_guard<std::timed_mutex> lock(input_buffer_mutex_);
                // Empty fetch is a wait timeout, not EOS. Retry outstanding
                // returned-data work until bounded deadline (not DSP-tail proof).
                if (draining_ && fetched_samples_ < fed_samples_ &&
                    std::chrono::steady_clock::now() < drain_deadline_) continue;
                if (draining_ && fetched_samples_ < fed_samples_) feed_failed_ = true;
                finish_tail = draining_ && !feed_failed_;
                draining_ = false;
            }
            if (finish_tail && !output_buffer_.empty() && output_callback_) {
                output_buffer_.resize(frame_samples_, 0);
                output_callback_(std::move(output_buffer_), generation);
                output_buffer_.clear();
            }
            if (res != nullptr) {
                ESP_LOGI(TAG, "Error code: %d", res->ret_value);
            }
            continue;
        }

        {
            std::lock_guard<std::timed_mutex> lock(input_buffer_mutex_);
            fetched_samples_ += res->data_size / sizeof(int16_t);
        }

        // VAD state change
        if (vad_state_change_callback_) {
            if (res->vad_state == VAD_SPEECH && !is_speaking_) {
                is_speaking_ = true;
                vad_state_change_callback_(true);
            } else if (res->vad_state == VAD_SILENCE && is_speaking_) {
                is_speaking_ = false;
                vad_state_change_callback_(false);
            }
        }

        if (output_callback_) {
            size_t samples = res->data_size / sizeof(int16_t);
            
            // Add data to buffer
            output_buffer_.insert(output_buffer_.end(), res->data, res->data + samples);
            
            // Output complete frames when buffer has enough data
            while (output_buffer_.size() >= frame_samples_) {
                if (output_buffer_.size() == frame_samples_) {
                    // If buffer size equals frame size, move the entire buffer
                    output_callback_(std::move(output_buffer_), generation);
                    output_buffer_.clear();
                    output_buffer_.reserve(frame_samples_);
                } else {
                    // If buffer size exceeds frame size, copy one frame and remove it
                    output_callback_(std::vector<int16_t>(output_buffer_.begin(), output_buffer_.begin() + frame_samples_), generation);
                    output_buffer_.erase(output_buffer_.begin(), output_buffer_.begin() + frame_samples_);
                }
            }
        }
    }
}

void AfeAudioProcessor::EnableDeviceAec(bool enable) {
    if (enable) {
#if CONFIG_USE_DEVICE_AEC
        afe_iface_->disable_vad(afe_data_);
        afe_iface_->enable_aec(afe_data_);
#else
        ESP_LOGE(TAG, "Device AEC is not supported");
#endif
    } else {
        afe_iface_->disable_aec(afe_data_);
        afe_iface_->enable_vad(afe_data_);
    }
}

#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
bool AfeAudioProcessor::GetCaptureSampleCounts(uint32_t generation, size_t& fed, size_t& fetched) {
    std::unique_lock<std::timed_mutex> lock(input_buffer_mutex_, std::try_to_lock);
    if (!lock.owns_lock() || !stopped_ || capture_generation_ != generation) return false;
    fed = fed_samples_;
    fetched = fetched_samples_;
    return true;
}
#endif
