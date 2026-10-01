#include "audio_service.h"
#include <esp_log.h>
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
#include <esp_heap_caps.h>
#include <freertos/idf_additions.h>
#endif
#include <algorithm>
#include <cstdlib>
#include <cstring>

#define RATE_CVT_CFG(_src_rate, _dest_rate, _channel)        \
    (esp_ae_rate_cvt_cfg_t)                                  \
    {                                                        \
        .src_rate        = (uint32_t)(_src_rate),            \
        .dest_rate       = (uint32_t)(_dest_rate),           \
        .channel         = (uint8_t)(_channel),              \
        .bits_per_sample = ESP_AUDIO_BIT16,                  \
        .complexity      = 2,                                \
        .perf_type       = ESP_AE_RATE_CVT_PERF_TYPE_SPEED,  \
    }

#define OPUS_DEC_CFG(_sample_rate, _frame_duration_ms)                                                    \
    (esp_opus_dec_cfg_t)                                                                                  \
    {                                                                                                     \
        .sample_rate    = (uint32_t)(_sample_rate),                                                       \
        .channel        = ESP_AUDIO_MONO,                                                                 \
        .frame_duration = (esp_opus_dec_frame_duration_t)AS_OPUS_GET_FRAME_DRU_ENUM(_frame_duration_ms),  \
        .self_delimited = false,                                                                          \
    }

#if CONFIG_USE_AUDIO_PROCESSOR
#include "processors/afe_audio_processor.h"
#else
#include "processors/no_audio_processor.h"
#endif

#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32P4
#include "wake_words/afe_wake_word.h"
#include "wake_words/custom_wake_word.h"
#else
#include "wake_words/esp_wake_word.h"
#endif

#define TAG "AudioService"

// Sentient overlay: synthetic mic-side audio injection hook (v1 patch 0004
// inlined for v2 rescope).
//
// When the esp32-devtool HTTP `POST /audio/inject` endpoint has been called,
// `cube_audio_inject_provider` (sentient_cube.cc) pushes PCM16 mono samples
// into `audio_inject_ring` (main/audio/audio_inject_ring.cc). `ReadAudioData()`
// then pulls samples from that ring in place of the real ES7210 codec read
// path, so HIL tests can drive the wake-word + uplink pipeline without a
// physical mic.
//
// The default weak implementation below returns 0 (inactive). The strong
// override lives in main/audio/audio_inject_ring.cc and wins at link time
// whenever the inject ring has been initialized.
extern "C" int agent_audio_inject_pop_samples(int16_t* buf,
                                              int target_samples,
                                              int sample_rate)
    __attribute__((weak));
extern "C" int agent_audio_inject_pop_samples(int16_t* /*buf*/,
                                              int /*target_samples*/,
                                              int /*sample_rate*/) {
    return 0;
}

extern "C" void __attribute__((weak)) agent_audio_inject_begin_capture(void) {}
extern "C" void __attribute__((weak)) agent_audio_inject_end_capture(void) {}

AudioService::AudioService() {
    event_group_ = xEventGroupCreate();
}

AudioService::~AudioService() {
    if (event_group_ != nullptr) {
        vEventGroupDelete(event_group_);
    }
    if (opus_encoder_ != nullptr) {
        esp_opus_enc_close(opus_encoder_);
    }
    if (opus_decoder_ != nullptr) {
        esp_opus_dec_close(opus_decoder_);
    }
    if (input_resampler_ != nullptr) {
        esp_ae_rate_cvt_close(input_resampler_);
    }
    if (output_resampler_ != nullptr) {
        esp_ae_rate_cvt_close(output_resampler_);
    }
}

void AudioService::Initialize(AudioCodec* codec) {
    codec_ = codec;
    codec_->Start();

    esp_opus_dec_cfg_t opus_dec_cfg = OPUS_DEC_CFG(codec->output_sample_rate(), OPUS_FRAME_DURATION_MS);
    auto ret = esp_opus_dec_open(&opus_dec_cfg, sizeof(esp_opus_dec_cfg_t), &opus_decoder_);
    if (opus_decoder_ == nullptr) {
        ESP_LOGE(TAG, "Failed to create audio decoder, error code: %d", ret);
    } else {
        decoder_sample_rate_ = codec->output_sample_rate();
        decoder_duration_ms_ = OPUS_FRAME_DURATION_MS;
        decoder_frame_size_ = decoder_sample_rate_ / 1000 * OPUS_FRAME_DURATION_MS;
    }
    esp_opus_enc_config_t opus_enc_cfg = AS_OPUS_ENC_CONFIG();
    ret = esp_opus_enc_open(&opus_enc_cfg, sizeof(esp_opus_enc_config_t), &opus_encoder_);
    if (opus_encoder_ == nullptr) {
        ESP_LOGE(TAG, "Failed to create audio encoder, error code: %d", ret);
    } else {
        encoder_sample_rate_ = 16000;
        encoder_duration_ms_ = OPUS_FRAME_DURATION_MS;
        esp_opus_enc_get_frame_size(opus_encoder_, &encoder_frame_size_, &encoder_outbuf_size_);
        encoder_frame_size_ = encoder_frame_size_ / sizeof(int16_t);
    }

    if (codec->input_sample_rate() != 16000) {
        esp_ae_rate_cvt_cfg_t input_resampler_cfg = RATE_CVT_CFG(
            codec->input_sample_rate(), ESP_AUDIO_SAMPLE_RATE_16K, codec->input_channels());
        auto resampler_ret = esp_ae_rate_cvt_open(&input_resampler_cfg, &input_resampler_);
        if (input_resampler_ == nullptr) {
            ESP_LOGE(TAG, "Failed to create input resampler, error code: %d", resampler_ret);
        }
    }

#if CONFIG_USE_AUDIO_PROCESSOR
    audio_processor_ = std::make_unique<AfeAudioProcessor>();
#else
    audio_processor_ = std::make_unique<NoAudioProcessor>();
#endif

    audio_processor_->OnOutput([this](std::vector<int16_t>&& data, uint32_t generation) {
        HandleProcessorOutput(std::move(data), generation);
    });

    audio_processor_->OnVadStateChange([this](bool speaking) {
        voice_detected_ = speaking;
        if (callbacks_.on_vad_change) {
            callbacks_.on_vad_change(speaking);
        }
    });

    esp_timer_create_args_t audio_power_timer_args = {
        .callback = [](void* arg) {
            AudioService* audio_service = (AudioService*)arg;
            audio_service->CheckAndUpdateAudioPowerState();
        },
        .arg = this,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "audio_power_timer",
        .skip_unhandled_events = true,
    };
    esp_timer_create(&audio_power_timer_args, &audio_power_timer_);
}

void AudioService::Start() {
    service_stopped_ = false;
    xEventGroupClearBits(event_group_, AS_EVENT_AUDIO_TESTING_RUNNING | AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING);

    esp_timer_start_periodic(audio_power_timer_, 1000000);

#if CONFIG_USE_AUDIO_PROCESSOR
    /* Start the audio input task */
    if (xTaskCreatePinnedToCore([](void* arg) {
        AudioService* audio_service = (AudioService*)arg;
        audio_service->AudioInputTask();
        vTaskDelete(NULL);
    }, "audio_input", 2048 * 3, this, 8, &audio_input_task_handle_, 0) != pdPASS) {
        ESP_LOGE(TAG, "audio_input task allocation failed");
        std::abort();
    }

    /* Start the audio output task */
    if (xTaskCreate([](void* arg) {
        AudioService* audio_service = (AudioService*)arg;
        audio_service->AudioOutputTask();
        vTaskDelete(NULL);
    }, "audio_output", 2048 * 2, this, 4, &audio_output_task_handle_) != pdPASS) {
        ESP_LOGE(TAG, "audio_output task allocation failed");
        std::abort();
    }
#else
    /* Start the audio input task */
    if (xTaskCreate([](void* arg) {
        AudioService* audio_service = (AudioService*)arg;
        audio_service->AudioInputTask();
        vTaskDelete(NULL);
    }, "audio_input", 2048 * 2, this, 8, &audio_input_task_handle_) != pdPASS) {
        ESP_LOGE(TAG, "audio_input task allocation failed");
        std::abort();
    }

    /* Start the audio output task */
    if (xTaskCreate([](void* arg) {
        AudioService* audio_service = (AudioService*)arg;
        audio_service->AudioOutputTask();
        vTaskDelete(NULL);
    }, "audio_output", 2048, this, 4, &audio_output_task_handle_) != pdPASS) {
        ESP_LOGE(TAG, "audio_output task allocation failed");
        std::abort();
    }
#endif

    // Cube's CPU-only codec/queue worker never writes flash/NVS. Keep its full
    // stack in PSRAM; reserve internal RAM for BLE, Wi-Fi and flash-owning tasks.
    // Flash/NVS owners stay on internal stacks; IDF suspends other tasks while
    // flash cache is disabled. Do not add flash operations to this worker.
    auto opus_task = [](void* arg) {
        AudioService* audio_service = (AudioService*)arg;
        audio_service->OpusCodecTask();
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
        vTaskDeleteWithCaps(NULL);
#else
        vTaskDelete(NULL);
#endif
    };
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE
    auto created = xTaskCreateWithCaps(opus_task, "opus_codec", 2048 * 12, this, 2,
                                      &opus_codec_task_handle_, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
#else
    auto created = xTaskCreate(opus_task, "opus_codec", 2048 * 12, this, 2, &opus_codec_task_handle_);
#endif
    if (created != pdPASS) {
        ESP_LOGE(TAG, "opus_codec task allocation failed");
        std::abort();
    }
}

void AudioService::Stop() {
    esp_timer_stop(audio_power_timer_);
    service_stopped_ = true;
    xEventGroupSetBits(event_group_, AS_EVENT_AUDIO_TESTING_RUNNING |
        AS_EVENT_WAKE_WORD_RUNNING |
        AS_EVENT_AUDIO_PROCESSOR_RUNNING);

    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    if (capture_energy_.Accepts(send_generation_))
        capture_energy_.state = CaptureEnergySnapshot::State::Retired;
#endif
    audio_encode_queue_.clear();
    audio_decode_queue_.clear();
    audio_playback_queue_.clear();
    audio_testing_queue_.clear();
    audio_queue_cv_.notify_all();
}

bool AudioService::ReadAudioData(std::vector<int16_t>& data, int sample_rate, int samples, uint32_t capture_generation) {
    (void)capture_generation;

    // Sentient overlay: if the audio injection hook is active, bypass the
    // codec read entirely and return synthetic mono samples at the rate the
    // caller requested. The hook returns 0 when inactive, so the real ES7210
    // path runs unchanged in normal operation.
    //
    // The downstream pipeline (AudioInputTask + AfeWakeWord::Feed) expects
    // `samples * input_channels` packed int16 — for audio-testing path, the
    // first channel is treated as the mic. Duplicate the mono inject buffer
    // across channels so the existing channel-extraction code is a no-op.
    {
        int ch = codec_ != nullptr ? codec_->input_channels() : 1;
        if (ch < 1) ch = 1;
        std::vector<int16_t> mono(samples);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
        const auto modes = xEventGroupGetBits(event_group_) & (AS_EVENT_AUDIO_TESTING_RUNNING |
            AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING);
        uint32_t generation;
        {
            std::lock_guard<std::mutex> lock(audio_queue_mutex_);
            generation = send_generation_;
        }
#endif
        int got = agent_audio_inject_pop_samples(mono.data(), samples, sample_rate);
        if (got > 0) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
            // Codec reads supply real-time backpressure; injection must too.
            // One frame deadline, no catch-up bursts after scheduling stalls.
            // Never hold queue/processor locks while waiting. Stop/restart drops
            // this popped frame within one tick; ordinary mic reads are unchanged.
            // Round partial frames up to a tick (10 ms on Cube). Using the
            // tick clock avoids doubling each 10 ms frame by chasing sub-tick
            // wall-clock phase after vTaskDelay wakes at a tick boundary.
            const TickType_t started = xTaskGetTickCount();
            const TickType_t duration = (static_cast<uint64_t>(got) * configTICK_RATE_HZ +
                                         sample_rate - 1) / sample_rate;
            while (true) {
                {
                    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
                    if (service_stopped_ || generation != send_generation_) return false;
                }
                // Graceful release clears input admission, but joins this read.
                // Cancel retires generation above; only non-capture modes use bits.
                if (!(modes & AS_EVENT_AUDIO_PROCESSOR_RUNNING) &&
                    (xEventGroupGetBits(event_group_) & modes) != modes) return false;
                if (static_cast<TickType_t>(xTaskGetTickCount() - started) >= duration) break;
                vTaskDelay(1);
            }
#endif
            std::vector<int16_t> out(static_cast<size_t>(got) * ch);
            for (int i = 0; i < got; i++) {
                for (int c = 0; c < ch; c++) {
                    out[i * ch + c] = mono[i];
                }
            }
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
            if (capture_generation) {
                std::lock_guard<std::mutex> lock(audio_queue_mutex_);
                if (accepting_send_ && capture_generation == send_generation_ &&
                    capture_energy_.Accepts(capture_generation))
                    capture_energy_.injected_samples += got;
            }
#endif
            data = std::move(out);
            last_input_time_ = std::chrono::steady_clock::now();
            debug_statistics_.input_count++;
            return true;
        }
    }

    if (!codec_->input_enabled()) {
        esp_timer_stop(audio_power_timer_);
        esp_timer_start_periodic(audio_power_timer_, AUDIO_POWER_CHECK_INTERVAL_MS * 1000);
        codec_->EnableInput(true);
    }

    const bool needs_resampling = codec_->input_sample_rate() != sample_rate;
    if (needs_resampling && input_resampler_ == nullptr) return false;
    data.resize(needs_resampling ? samples * codec_->input_sample_rate() / sample_rate * codec_->input_channels()
                                 : samples * codec_->input_channels());
    if (!codec_->InputData(data)) return false;
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    // Cube's pinned BoxAudioCodec selects ES7210 slots 0 (M), 1 (R).
    // Do not meter the reference, rate-converter output, or other capture modes.
    if (capture_generation) {
        const auto frame = CaptureEnergy::Measure(data.data(), data.size(), codec_->input_channels());
        std::lock_guard<std::mutex> lock(audio_queue_mutex_);
        if (accepting_send_ && capture_generation == send_generation_ &&
            capture_energy_.Accepts(capture_generation))
            capture_energy_.native_mic.Merge(frame);
    }
#endif
    if (needs_resampling && input_resampler_ != nullptr) {
        std::lock_guard<std::mutex> lock(input_resampler_mutex_);
        const int channels = codec_->input_channels();
        uint32_t in_sample_num = data.size() / channels;
        uint32_t output_samples = 0;
        auto max_ret = esp_ae_rate_cvt_get_max_out_sample_num(input_resampler_, in_sample_num, &output_samples);
        if (max_ret != ESP_AE_ERR_OK || output_samples == 0 ||
            output_samples > data.max_size() / channels) {
            ESP_LOGE(TAG, "Input resampler max failed request=%d input=%u max_ret=%d max=%u",
                     samples, (unsigned)in_sample_num, (int)max_ret, (unsigned)output_samples);
            return false;
        }
        std::vector<int16_t> resampled(static_cast<size_t>(output_samples) * channels);
        uint32_t actual_output = output_samples;
        auto process_ret = esp_ae_rate_cvt_process(input_resampler_, (esp_ae_sample_t)data.data(), in_sample_num,
                                                    (esp_ae_sample_t)resampled.data(), &actual_output);
        if (process_ret != ESP_AE_ERR_OK || actual_output == 0 || actual_output > output_samples ||
            static_cast<size_t>(actual_output) * channels > resampled.size()) {
            ESP_LOGE(TAG, "Input resampler process failed request=%d input=%u max=%u process_ret=%d actual=%u allocated=%u",
                     samples, (unsigned)in_sample_num, (unsigned)output_samples,
                     (int)process_ret, (unsigned)actual_output, (unsigned)resampled.size());
            return false;
        }
        resampled.resize(static_cast<size_t>(actual_output) * channels);
        data = std::move(resampled);
    }

    /* Update the last input time */
    last_input_time_ = std::chrono::steady_clock::now();
    debug_statistics_.input_count++;

#if CONFIG_USE_AUDIO_DEBUGGER
    // Audio debugging: send raw audio data
    if (audio_debugger_ == nullptr) {
        audio_debugger_ = std::make_unique<AudioDebugger>();
    }
    audio_debugger_->Feed(data);
#endif

    return true;
}

void AudioService::AudioInputTask() {
    while (true) {
        EventBits_t bits = xEventGroupWaitBits(event_group_, AS_EVENT_AUDIO_TESTING_RUNNING |
            AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING,
            pdFALSE, pdFALSE, portMAX_DELAY);

        if (service_stopped_) {
            break;
        }

        /* Used for audio testing in NetworkConfiguring mode by clicking the BOOT button */
        if (bits & AS_EVENT_AUDIO_TESTING_RUNNING) {
            if (audio_testing_queue_.size() >= AUDIO_TESTING_MAX_DURATION_MS / OPUS_FRAME_DURATION_MS) {
                ESP_LOGW(TAG, "Audio testing queue is full, stopping audio testing");
                EnableAudioTesting(false);
                continue;
            }
            std::vector<int16_t> data;
            int samples = OPUS_FRAME_DURATION_MS * 16000 / 1000;
            if (ReadAudioData(data, 16000, samples)) {
                // If input channels is 2, we need to fetch the left channel data
                if (codec_->input_channels() == 2) {
                    auto mono_data = std::vector<int16_t>(data.size() / 2);
                    for (size_t i = 0, j = 0; i < mono_data.size(); ++i, j += 2) {
                        mono_data[i] = data[j];
                    }
                    data = std::move(mono_data);
                }
                PushTaskToEncodeQueue(kAudioTaskTypeEncodeToTestingQueue, std::move(data));
                continue;
            }
        }

        /* Feed the wake word and/or audio processor */
        if (bits & (AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING)) {
            std::lock_guard<std::timed_mutex> producer(input_capture_mutex_);
            bits &= xEventGroupGetBits(event_group_);
            if (!(bits & (AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING))) continue;
            int samples = 160; // 10ms
            std::vector<int16_t> data;
            // Capture before codec read: an old DMA read finishing after a
            // fast restart must not be fed into the new processor capture.
            uint32_t capture_generation;
            {
                std::lock_guard<std::mutex> lock(audio_queue_mutex_);
                capture_generation = send_generation_;
            }
            if (ReadAudioData(data, 16000, samples,
                              (bits & AS_EVENT_AUDIO_PROCESSOR_RUNNING) ? capture_generation : 0)) {
                if (bits & AS_EVENT_WAKE_WORD_RUNNING) {
                    wake_word_->Feed(data);
                }
                if (bits & AS_EVENT_AUDIO_PROCESSOR_RUNNING) {
                    audio_processor_->Feed(std::move(data), capture_generation);
                }
                continue;
            }
            if (bits & AS_EVENT_AUDIO_PROCESSOR_RUNNING) {
                std::lock_guard<std::mutex> lock(audio_queue_mutex_);
                if (capture_generation == send_generation_) send_failed_ = true;
                audio_queue_cv_.notify_all();
            }
        }

        // Read timeout/error should not terminate the input task.
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    ESP_LOGW(TAG, "Audio input task stopped");
}

void AudioService::AudioOutputTask() {
    while (true) {
        std::unique_lock<std::mutex> lock(audio_queue_mutex_);
        audio_queue_cv_.wait(lock, [this]() { return (!playback_deferred_ && !audio_playback_queue_.empty()) || service_stopped_; });
        if (service_stopped_) {
            break;
        }

        auto task = std::move(audio_playback_queue_.front());
        audio_playback_queue_.pop_front();
        auto generation = decode_generation_;
        output_in_flight_ = true;
        output_playback_epoch_ = task->playback_epoch;
        audio_queue_cv_.notify_all();
        lock.unlock();

        if (!codec_->output_enabled()) {
            esp_timer_stop(audio_power_timer_);
            esp_timer_start_periodic(audio_power_timer_, AUDIO_POWER_CHECK_INTERVAL_MS * 1000);
            codec_->EnableOutput(true);
        }

        bool played = codec_->OutputData(task->pcm);
        if (played) {
            last_output_time_ = std::chrono::steady_clock::now();
            debug_statistics_.playback_count++;
        } else {
            ESP_LOGE(TAG, "audio.playback_failed generation=%lu", (unsigned long)generation);
        }

        lock.lock();
        const bool failed = !played && generation == decode_generation_ && !failed_playback_epochs_.count(task->playback_epoch);
        if (failed) FailPlaybackOwner(task->playback_epoch);
#if CONFIG_USE_SERVER_AEC
        /* Record the timestamp for server AEC */
        if (played && generation == decode_generation_ && task->timestamp > 0) {
            timestamp_queue_.push_back(task->timestamp);
        }
#endif
        output_in_flight_ = false;
        bool drained = played && !failed_playback_epochs_.count(task->playback_epoch) && audio_decode_queue_.empty() && !decoding_ && audio_playback_queue_.empty();
        audio_queue_cv_.notify_all();
        lock.unlock();
        if (failed && callbacks_.on_playback_failed) {
            callbacks_.on_playback_failed(task->playback_epoch, generation);
        }
        if (drained && callbacks_.on_playback_drained) {
            callbacks_.on_playback_drained();
        }
    }

    ESP_LOGW(TAG, "Audio output task stopped");
}

void AudioService::OpusCodecTask() {
    while (true) {
        std::unique_lock<std::mutex> lock(audio_queue_mutex_);
        audio_queue_cv_.wait(lock, [this]() {
            return service_stopped_ ||
                (!audio_encode_queue_.empty() && audio_send_queue_.size() < MAX_SEND_PACKETS_IN_QUEUE) ||
                (!audio_decode_queue_.empty() && audio_playback_queue_.size() < MAX_PLAYBACK_TASKS_IN_QUEUE);
        });
        if (service_stopped_) {
            break;
        }

        /* Decode the audio from decode queue */
        if (!audio_decode_queue_.empty() && audio_playback_queue_.size() < MAX_PLAYBACK_TASKS_IN_QUEUE) {
            auto packet = std::move(audio_decode_queue_.front());
            audio_decode_queue_.pop_front();
            decoding_ = true;
            decoding_playback_epoch_ = packet->playback_epoch;
            auto generation = decode_generation_;
            audio_queue_cv_.notify_all();
            lock.unlock();

            auto task = std::make_unique<AudioTask>();
            task->type = kAudioTaskTypeDecodeToPlaybackQueue;
            task->timestamp = packet->timestamp;
            task->playback_epoch = packet->playback_epoch;

            bool decode_failed = true;
            SetDecodeSampleRate(packet->sample_rate, packet->frame_duration, packet->pcm);
            if (packet->pcm || opus_decoder_ != nullptr) {
                task->pcm.resize(decoder_frame_size_);
                esp_audio_dec_in_raw_t raw = {
                    .buffer = (uint8_t *)(packet->payload.data()),
                    .len = (uint32_t)(packet->payload.size()),
                    .consumed = 0,
                    .frame_recover = ESP_AUDIO_DEC_RECOVERY_NONE,
                };
                esp_audio_dec_out_frame_t out_frame = {
                    .buffer = (uint8_t *)(task->pcm.data()),
                    .len = (uint32_t)(task->pcm.size() * sizeof(int16_t)),
                    .decoded_size = 0,
                };
                esp_audio_dec_info_t dec_info = {};
                std::unique_lock<std::mutex> decoder_lock(decoder_mutex_);
                // Reset at FIFO decoder ownership boundary, never when a newer
                // wire start arrives while older packets still await decoding.
                if (decoder_playback_epoch_ != packet->playback_epoch || decoder_owner_generation_ != generation) {
                    if (opus_decoder_) esp_opus_dec_reset(opus_decoder_);
                    if (output_resampler_) esp_ae_rate_cvt_reset(output_resampler_);
                    decoder_playback_epoch_ = packet->playback_epoch;
                    decoder_owner_generation_ = generation;
                }
                auto ret = ESP_AUDIO_ERR_OK;
                if (packet->pcm) {
                    if (packet->payload.empty() || packet->payload.size() % 2) ret = ESP_AUDIO_ERR_FAIL;
                    else {
                        task->pcm.resize(packet->payload.size() / 2);
                        for (size_t i = 0; i < task->pcm.size(); ++i)
                            task->pcm[i] = static_cast<int16_t>(packet->payload[2*i] | (uint16_t(packet->payload[2*i+1]) << 8));
                        out_frame.decoded_size = packet->payload.size();
                    }
                } else ret = esp_opus_dec_decode(opus_decoder_, &raw, &out_frame, &dec_info);
                decoder_lock.unlock();
                if (ret == ESP_AUDIO_ERR_OK) {
                    task->pcm.resize(out_frame.decoded_size / sizeof(int16_t));
                    decode_failed = task->pcm.empty();
                    if (decoder_sample_rate_ != codec_->output_sample_rate() && output_resampler_ == nullptr) {
                        task->pcm.clear(); decode_failed = true;
                    }
                    if (decoder_sample_rate_ != codec_->output_sample_rate() && output_resampler_ != nullptr) {
                        uint32_t target_size = 0;
                        auto max_ret = esp_ae_rate_cvt_get_max_out_sample_num(output_resampler_, task->pcm.size(), &target_size);
                        if (max_ret != ESP_AE_ERR_OK ||
                            target_size > task->pcm.max_size()) {
                            ESP_LOGE(TAG, "Output resampler max failed ret=%d input=%u max=%u",
                                     (int)max_ret, (unsigned)task->pcm.size(), (unsigned)target_size);
                            task->pcm.clear(); decode_failed = true;
                        } else {
                            target_size = std::max(target_size, uint32_t(1));
                            std::vector<int16_t> resampled(target_size);
                            uint32_t actual_output = target_size;
                            auto process_ret = esp_ae_rate_cvt_process(output_resampler_, (esp_ae_sample_t)task->pcm.data(),
                                                                        task->pcm.size(), (esp_ae_sample_t)resampled.data(),
                                                                        &actual_output);
                            if (process_ret != ESP_AE_ERR_OK || actual_output > target_size ||
                                actual_output > resampled.size()) {
                                ESP_LOGE(TAG, "Output resampler process failed ret=%d max=%u actual=%u allocated=%u",
                                         (int)process_ret, (unsigned)target_size, (unsigned)actual_output,
                                         (unsigned)resampled.size());
                                task->pcm.clear(); decode_failed = true;
                            } else {
                                // Success with zero output consumed/buffered valid input.
                                decode_failed = false;
                                resampled.resize(actual_output);
                                task->pcm = std::move(resampled);
                            }
                        }
                    }
                    lock.lock();
                    if (generation == decode_generation_ &&
                        !failed_playback_epochs_.count(task->playback_epoch) && !task->pcm.empty()) {
                        audio_playback_queue_.push_back(std::move(task));
                    }
                    audio_queue_cv_.notify_all();
                    debug_statistics_.decode_count++;
                } else {
                    ESP_LOGE(TAG, "Failed to decode audio after resize, error code: %d", ret);
                    lock.lock();
                }
            } else {
                ESP_LOGE(TAG, "Audio decoder is not configured");
                lock.lock();
            }
            debug_statistics_.decode_count++;
            decoding_ = false;
            const bool failed = decode_failed && generation == decode_generation_;
            if (failed) FailPlaybackOwner(packet->playback_epoch);
            bool drained = !failed && generation == decode_generation_ &&
                !failed_playback_epochs_.count(packet->playback_epoch) && audio_decode_queue_.empty() &&
                audio_playback_queue_.empty() && !output_in_flight_;
            audio_queue_cv_.notify_all();
            lock.unlock();
            if (failed && callbacks_.on_playback_failed) callbacks_.on_playback_failed(packet->playback_epoch, generation);
            if (drained && callbacks_.on_playback_drained) {
                callbacks_.on_playback_drained();
            }
            lock.lock();
        }
        /* Encode the audio to send queue */
        if (!audio_encode_queue_.empty() && audio_send_queue_.size() < MAX_SEND_PACKETS_IN_QUEUE) {
            auto task = std::move(audio_encode_queue_.front());
            audio_encode_queue_.pop_front();
            auto generation = task->send_generation;
            encoding_to_send_ = task->type == kAudioTaskTypeEncodeToSendQueue;
            audio_queue_cv_.notify_all();
            lock.unlock();

            auto packet = std::make_unique<AudioStreamPacket>();
            packet->frame_duration = OPUS_FRAME_DURATION_MS;
            packet->sample_rate = 16000;
            packet->timestamp = task->timestamp;

            if (opus_encoder_ != nullptr && task->pcm.size() == encoder_frame_size_) {
                std::vector<uint8_t> buf(encoder_outbuf_size_);
                esp_audio_enc_in_frame_t in = {
                    .buffer = (uint8_t *)(task->pcm.data()),
                    .len = (uint32_t)(encoder_frame_size_ * sizeof(int16_t)),
                };
                esp_audio_enc_out_frame_t out = {
                    .buffer = buf.data(),
                    .len = (uint32_t)encoder_outbuf_size_,
                    .encoded_bytes = 0,
                };
                auto ret = esp_opus_enc_process(opus_encoder_, &in, &out);
                if (ret == ESP_AUDIO_ERR_OK) {
                    packet->payload.assign(buf.data(), buf.data() + out.encoded_bytes);

                    if (task->type == kAudioTaskTypeEncodeToSendQueue) {
                        bool queued = false;
                        {
                            std::lock_guard<std::mutex> lock2(audio_queue_mutex_);
                            if (generation == send_generation_) {
                                audio_send_queue_.push_back(std::move(packet));
                                queued = true;
                            }
                        }
                        if (queued && callbacks_.on_send_queue_available) {
                            callbacks_.on_send_queue_available();
                        }
                    } else if (task->type == kAudioTaskTypeEncodeToTestingQueue) {
                        std::lock_guard<std::mutex> lock2(audio_queue_mutex_);
                        audio_testing_queue_.push_back(std::move(packet));
                    }
                    debug_statistics_.encode_count++;
                } else {
                    ESP_LOGE(TAG, "Failed to encode audio, error code: %d", ret);
                }
            } else {
                ESP_LOGE(TAG, "Failed to encode audio: encoder not configured or invalid frame size (got %u, expected %u)",
                         task->pcm.size(), encoder_frame_size_);
            }
            lock.lock();
            if (task->type == kAudioTaskTypeEncodeToSendQueue &&
                generation == send_generation_ && packet != nullptr) {
                send_failed_ = true;
            }
            encoding_to_send_ = false;
            audio_queue_cv_.notify_all();
        }
    }

    ESP_LOGW(TAG, "Opus codec task stopped");
}

void AudioService::SetDecodeSampleRate(int sample_rate, int frame_duration, bool pcm) {
    if (decoder_pcm_ == pcm && (pcm || opus_decoder_) && decoder_sample_rate_ == sample_rate && decoder_duration_ms_ == frame_duration &&
        (sample_rate == codec_->output_sample_rate() || output_resampler_)) {
        return;
    }
    std::unique_lock<std::mutex> decoder_lock(decoder_mutex_);
    if (opus_decoder_ != nullptr) {
        esp_opus_dec_close(opus_decoder_);
        opus_decoder_ = nullptr;
    }
    decoder_lock.unlock();
    if (!pcm) {
        esp_opus_dec_cfg_t opus_dec_cfg = OPUS_DEC_CFG(sample_rate, frame_duration);
        auto ret = esp_opus_dec_open(&opus_dec_cfg, sizeof(esp_opus_dec_cfg_t), &opus_decoder_);
        if (opus_decoder_ == nullptr) {
            ESP_LOGE(TAG, "Failed to create audio decoder, error code: %d", ret);
            return;
        }
    }
    decoder_pcm_ = pcm;
    decoder_sample_rate_ = sample_rate;
    decoder_duration_ms_ = frame_duration;
    decoder_frame_size_ = decoder_sample_rate_ / 1000 * frame_duration;

    auto codec = Board::GetInstance().GetAudioCodec();
    if (decoder_sample_rate_ != codec->output_sample_rate()) {
        ESP_LOGI(TAG, "Resampling audio from %d to %d", decoder_sample_rate_, codec->output_sample_rate());
        if (output_resampler_ != nullptr) {
            esp_ae_rate_cvt_close(output_resampler_);
            output_resampler_ = nullptr;
        }
        esp_ae_rate_cvt_cfg_t output_resampler_cfg = RATE_CVT_CFG(
            decoder_sample_rate_, codec->output_sample_rate(), ESP_AUDIO_MONO);
        auto resampler_ret = esp_ae_rate_cvt_open(&output_resampler_cfg, &output_resampler_);
        if (output_resampler_ == nullptr) {
            ESP_LOGE(TAG, "Failed to create output resampler, error code: %d", resampler_ret);
        }
    }
}

void AudioService::HandleProcessorOutput(std::vector<int16_t>&& pcm, uint32_t capture_generation) {
    PushTaskToEncodeQueue(kAudioTaskTypeEncodeToSendQueue, std::move(pcm), capture_generation);
}

void AudioService::PushTaskToEncodeQueue(AudioTaskType type, std::vector<int16_t>&& pcm, uint32_t capture_generation) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    const auto energy = type == kAudioTaskTypeEncodeToSendQueue
        ? CaptureEnergy::Measure(pcm.data(), pcm.size()) : CaptureEnergy{};
#endif
    auto task = std::make_unique<AudioTask>();
    task->type = type;
    task->pcm = std::move(pcm);
    /* Push the task to the encode queue */
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);

    // Reject stale source before binding producer or waiting for queue space.
    if (type == kAudioTaskTypeEncodeToSendQueue) {
        if (!accepting_send_ || capture_generation != send_generation_) return;
        task->send_generation = capture_generation;
        ++send_producers_;
        audio_queue_cv_.notify_all();
    }

    /* If the task is to send queue, we need to set the timestamp */
    if (type == kAudioTaskTypeEncodeToSendQueue && !timestamp_queue_.empty()) {
        if (timestamp_queue_.size() <= MAX_TIMESTAMPS_IN_QUEUE) {
            task->timestamp = timestamp_queue_.front();
        } else {
            ESP_LOGW(TAG, "Timestamp queue (%u) is full, dropping timestamp", timestamp_queue_.size());
        }
        timestamp_queue_.pop_front();
    }

    bool space = audio_queue_cv_.wait_for(lock, std::chrono::seconds(4), [this, &task]() {
        return service_stopped_ ||
               (task->type == kAudioTaskTypeEncodeToSendQueue && task->send_generation != send_generation_) ||
               audio_encode_queue_.size() < MAX_ENCODE_TASKS_IN_QUEUE;
    });
    if (!space && type == kAudioTaskTypeEncodeToSendQueue) send_failed_ = true;
    if (space && !service_stopped_ &&
        (task->type != kAudioTaskTypeEncodeToSendQueue || task->send_generation == send_generation_)) {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
        if (type == kAudioTaskTypeEncodeToSendQueue && capture_energy_.Accepts(capture_generation))
            capture_energy_.encoder_input.Merge(energy);
#endif
        audio_encode_queue_.push_back(std::move(task));
    }
    if (type == kAudioTaskTypeEncodeToSendQueue) --send_producers_;
    audio_queue_cv_.notify_all();
}

uint32_t AudioService::DecodeGeneration() {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    return decode_generation_;
}

DecodeQueueResult AudioService::PushPacketToDecodeQueue(std::unique_ptr<AudioStreamPacket> packet,
                                                        uint32_t generation, bool wait) {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);
    if (generation != decode_generation_) return DecodeQueueResult::Stale;
    if (failed_playback_epochs_.count(packet->playback_epoch)) return DecodeQueueResult::Failed;
    if (packet->playback_epoch && packet->playback_epoch < latest_playback_epoch_) return DecodeQueueResult::Stale;
    latest_playback_epoch_ = std::max(latest_playback_epoch_, packet->playback_epoch);
    PrunePlaybackFailures();
    audio_queue_cv_.notify_all();
    if (wait && !playback_deferred_ && audio_decode_queue_.size() >= MAX_DECODE_PACKETS_IN_QUEUE) {
        if (!audio_queue_cv_.wait_for(lock, std::chrono::seconds(5), [this, generation, epoch = packet->playback_epoch]() {
                return service_stopped_ || failed_playback_epochs_.count(epoch) || generation != decode_generation_ ||
                       (epoch && epoch < latest_playback_epoch_) ||
                       audio_decode_queue_.size() < MAX_DECODE_PACKETS_IN_QUEUE;
            })) return DecodeQueueResult::Timeout;
    }
    if (generation != decode_generation_) return DecodeQueueResult::Stale;
    if (service_stopped_) return DecodeQueueResult::Stopped;
    if (packet->playback_epoch && packet->playback_epoch < latest_playback_epoch_) return DecodeQueueResult::Stale;
    if (failed_playback_epochs_.count(packet->playback_epoch)) return DecodeQueueResult::Failed;
    if (audio_decode_queue_.size() >= MAX_DECODE_PACKETS_IN_QUEUE) return DecodeQueueResult::Full;
    audio_decode_queue_.push_back(std::move(packet));
    audio_queue_cv_.notify_all();
    return DecodeQueueResult::Queued;
}

void AudioService::ClearSendQueue() {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    if (capture_energy_.state == CaptureEnergySnapshot::State::Capturing ||
        capture_energy_.state == CaptureEnergySnapshot::State::Draining)
        capture_energy_.state = CaptureEnergySnapshot::State::Retired;
#endif
    ++send_generation_;
    accepting_send_ = false;
    send_failed_ = false;
    audio_encode_queue_.erase(
        std::remove_if(audio_encode_queue_.begin(), audio_encode_queue_.end(),
                       [](const auto& task) { return task->type == kAudioTaskTypeEncodeToSendQueue; }),
        audio_encode_queue_.end());
    audio_send_queue_.clear();
    audio_queue_cv_.notify_all();
}

bool AudioService::WaitForSendEncoding() {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);
    // Bounded: do not commit while producers, encoder, or queued packets remain.
    bool drained = audio_queue_cv_.wait_for(lock, std::chrono::seconds(5), [this]() {
        return send_failed_ || (!send_producers_ && !encoding_to_send_ &&
               audio_send_queue_.empty() &&
               std::none_of(audio_encode_queue_.begin(), audio_encode_queue_.end(),
                            [](const auto& task) { return task->type == kAudioTaskTypeEncodeToSendQueue; }));
    });
    return drained && !send_failed_;
}

bool AudioService::IsPlaybackDrained(uint32_t epoch) {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    return (!epoch || epoch >= latest_playback_epoch_) && !failed_playback_epochs_.count(epoch) && audio_decode_queue_.empty() && !decoding_ &&
           audio_playback_queue_.empty() && !output_in_flight_;
}

std::unique_ptr<AudioStreamPacket> AudioService::PopPacketFromSendQueue() {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    if (audio_send_queue_.empty()) {
        return nullptr;
    }
    auto packet = std::move(audio_send_queue_.front());
    audio_send_queue_.pop_front();
    audio_queue_cv_.notify_all();
    return packet;
}

void AudioService::EncodeWakeWord() {
    if (wake_word_) {
        wake_word_->EncodeWakeWordData();
    }
}

const std::string& AudioService::GetLastWakeWord() const {
    return wake_word_->GetLastDetectedWakeWord();
}

std::unique_ptr<AudioStreamPacket> AudioService::PopWakeWordPacket() {
    auto packet = std::make_unique<AudioStreamPacket>();
    if (wake_word_->GetWakeWordOpus(packet->payload)) {
        return packet;
    }
    return nullptr;
}

void AudioService::EnableWakeWordDetection(bool enable) {
    if (!wake_word_) {
        return;
    }

    ESP_LOGD(TAG, "%s wake word detection", enable ? "Enabling" : "Disabling");
    if (enable) {
        if (!wake_word_initialized_) {
            if (!wake_word_->Initialize(codec_, models_list_)) {
                ESP_LOGE(TAG, "Failed to initialize wake word");
                return;
            }
            wake_word_initialized_ = true;
        }
        // Reset input resampler to clear cached data from previous mode (e.g. AudioProcessor)
        // This prevents buffer overflow when switching between different feed sizes
        {
            std::lock_guard<std::mutex> lock(input_resampler_mutex_);
            if (input_resampler_ != nullptr) {
                esp_ae_rate_cvt_reset(input_resampler_);
            }
        }
        wake_word_->Start();
        xEventGroupSetBits(event_group_, AS_EVENT_WAKE_WORD_RUNNING);
    } else {
        wake_word_->Stop();
        xEventGroupClearBits(event_group_, AS_EVENT_WAKE_WORD_RUNNING);
    }
}

bool AudioService::EnableVoiceProcessing(bool enable, bool drain) {
    ESP_LOGD(TAG, "%s voice processing", enable ? "Enabling" : "Disabling");
    if (enable) {
        if (!audio_processor_initialized_) {
            audio_processor_->Initialize(codec_, OPUS_FRAME_DURATION_MS, models_list_);
            audio_processor_initialized_ = true;
        }

        /* Do not start capture while old software-owned output is pending. */
        if (!ResetDecoder()) return false;
        // Prepare physical input before Application advertises Listening.
        last_input_time_ = std::chrono::steady_clock::now();
        if (!codec_->input_enabled()) {
            esp_timer_stop(audio_power_timer_);
            esp_timer_start_periodic(audio_power_timer_, AUDIO_POWER_CHECK_INTERVAL_MS * 1000);
            codec_->EnableInput(true);
            if (!codec_->input_enabled()) return false;
            vTaskDelay(pdMS_TO_TICKS(120));
        }
        last_input_time_ = std::chrono::steady_clock::now();
        // Reset input resampler to clear cached data from previous mode (e.g. WakeWord)
        // This prevents buffer overflow when switching between different feed sizes
        {
            std::lock_guard<std::mutex> lock(input_resampler_mutex_);
            if (input_resampler_ != nullptr) {
                esp_ae_rate_cvt_reset(input_resampler_);
            }
        }
        // Every start gets a fresh token, even if caller did not clear queue.
        ClearSendQueue();
        uint32_t generation;
        {
            std::lock_guard<std::mutex> lock(audio_queue_mutex_);
            generation = send_generation_;
            accepting_send_ = true;
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
            const uint64_t epoch = capture_energy_.epoch + 1;
            capture_energy_ = {};
            capture_energy_.epoch = epoch;
            capture_energy_.generation = generation;
            capture_energy_.native_rate_hz = codec_->input_sample_rate();
            capture_energy_.state = CaptureEnergySnapshot::State::Capturing;
#endif
        }
        if (!audio_processor_->Start(generation)) {
            ESP_LOGE(TAG, "Audio processor start failed");
            std::lock_guard<std::mutex> lock(audio_queue_mutex_);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
            capture_energy_.state = CaptureEnergySnapshot::State::Failed;
#endif
            accepting_send_ = false;
            send_failed_ = true;
            audio_queue_cv_.notify_all();
            return false;
        }
        agent_audio_inject_begin_capture();
        xEventGroupSetBits(event_group_, AS_EVENT_AUDIO_PROCESSOR_RUNNING);
    } else {
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
        uint64_t retiring_epoch;
        uint32_t retiring_generation;
        {
            std::lock_guard<std::mutex> lock(audio_queue_mutex_);
            retiring_epoch = capture_energy_.epoch;
            retiring_generation = capture_energy_.generation;
            if (capture_energy_.state == CaptureEnergySnapshot::State::Capturing)
                capture_energy_.state = drain ? CaptureEnergySnapshot::State::Draining
                                             : CaptureEnergySnapshot::State::Retired;
        }
#endif
        xEventGroupClearBits(event_group_, AS_EVENT_AUDIO_PROCESSOR_RUNNING);
        if (!drain) ClearSendQueue(); // Retire before blocked producer/encoder resumes.
        std::unique_lock<std::timed_mutex> producer(input_capture_mutex_, std::defer_lock);
        const bool joined = producer.try_lock_for(std::chrono::seconds(5));
        // Flush returned PCM and AFE/encoder staging. Native rate converter has
        // no documented flush/delay API; internal filter-tail guarantee remains
        // an integration gap, not established by these queue/drain checks.
        bool stopped = joined && (!audio_processor_initialized_ || audio_processor_->Stop(drain));
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
        size_t fed = 0, fetched = 0;
        const bool counts_available = joined && audio_processor_initialized_ &&
            audio_processor_->GetCaptureSampleCounts(retiring_generation, fed, fetched);
#endif
        {
            std::lock_guard<std::mutex> lock(audio_queue_mutex_);
            accepting_send_ = false;
            if (!stopped) send_failed_ = true;
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
            if (capture_energy_.epoch == retiring_epoch && retiring_epoch &&
                (capture_energy_.state == CaptureEnergySnapshot::State::Draining ||
                 capture_energy_.state == CaptureEnergySnapshot::State::Retired)) {
                capture_energy_.afe_counts_available = counts_available;
                capture_energy_.afe_fed_samples = fed;
                capture_energy_.afe_fetched_samples = fetched;
                capture_energy_.state = (!stopped || send_failed_) ? CaptureEnergySnapshot::State::Failed
                    : drain ? CaptureEnergySnapshot::State::Complete : CaptureEnergySnapshot::State::Retired;
            }
#endif
            audio_queue_cv_.notify_all();
        }
        agent_audio_inject_end_capture();
        if (!stopped) ESP_LOGE(TAG, "Audio processor stop/reset timed out or failed");
        return stopped;
    }
    return true;
}

void AudioService::EnableAudioTesting(bool enable) {
    ESP_LOGI(TAG, "%s audio testing", enable ? "Enabling" : "Disabling");
    if (enable) {
        xEventGroupSetBits(event_group_, AS_EVENT_AUDIO_TESTING_RUNNING);
    } else {
        xEventGroupClearBits(event_group_, AS_EVENT_AUDIO_TESTING_RUNNING);
        /* Copy audio_testing_queue_ to audio_decode_queue_ */
        std::lock_guard<std::mutex> lock(audio_queue_mutex_);
        audio_decode_queue_ = std::move(audio_testing_queue_);
        audio_queue_cv_.notify_all();
    }
}

void AudioService::EnableDeviceAec(bool enable) {
    ESP_LOGI(TAG, "%s device AEC", enable ? "Enabling" : "Disabling");
    if (!audio_processor_initialized_) {
        audio_processor_->Initialize(codec_, OPUS_FRAME_DURATION_MS, models_list_);
        audio_processor_initialized_ = true;
    }

    audio_processor_->EnableDeviceAec(enable);
}

void AudioService::SetCallbacks(AudioServiceCallbacks& callbacks) {
    callbacks_ = callbacks;
}

void AudioService::PlaySound(const std::string_view& ogg) {
    if (!codec_->output_enabled()) {
        esp_timer_stop(audio_power_timer_);
        esp_timer_start_periodic(audio_power_timer_, AUDIO_POWER_CHECK_INTERVAL_MS * 1000);
        codec_->EnableOutput(true);
    }

    const auto* buf = reinterpret_cast<const uint8_t*>(ogg.data());
    size_t size = ogg.size();

    auto demuxer = std::make_unique<OggDemuxer>();
    auto generation = DecodeGeneration();
    demuxer->OnDemuxerFinished([this, generation](const uint8_t* data, int sample_rate, size_t size){
        auto packet = std::make_unique<AudioStreamPacket>();
        packet->sample_rate = sample_rate;
        packet->frame_duration = 60;
        packet->payload.resize(size);
        std::memcpy(packet->payload.data(), data, size);
        auto result = PushPacketToDecodeQueue(std::move(packet), generation, true);
        if (result != DecodeQueueResult::Queued && result != DecodeQueueResult::Stale) {
            ESP_LOGW(TAG, "PlaySound decode queue unavailable: reason=%d", static_cast<int>(result));
        }
    });
    demuxer->Reset();
    demuxer->Process(buf, size);
}

bool AudioService::PlayPcm(const int16_t* samples, size_t sample_count, int sample_rate) {
    if (samples == nullptr || sample_count == 0) {
        ESP_LOGW(TAG, "PlayPcm rejected: empty buffer");
        return false;
    }
    if (codec_ == nullptr) {
        ESP_LOGW(TAG, "PlayPcm rejected: codec not initialized");
        return false;
    }
    if (sample_rate <= 0 || sample_rate > 48000) {
        ESP_LOGW(TAG, "PlayPcm rejected: bad sample_rate=%d", sample_rate);
        return false;
    }
    const int target_rate = codec_->output_sample_rate();
    ESP_LOGI(TAG, "PlayPcm samples=%u input_rate=%d target_rate=%d",
             (unsigned)sample_count, sample_rate, target_rate);

    std::vector<int16_t> resampled;

    if (sample_rate == target_rate) {
        resampled.assign(samples, samples + sample_count);
    } else {
        // TODO(Phase 5+): Replace naive linear interpolation with
        // esp_ae_rate_cvt for production audio quality. Linear interp
        // is sufficient for Phase 3 sine tones and test PCM blobs.
        const float ratio = (float)target_rate / (float)sample_rate;
        const size_t out_count = (size_t)((float)sample_count * ratio);
        resampled.resize(out_count);
        for (size_t i = 0; i < out_count; ++i) {
            const float src_idx_f = (float)i / ratio;
            const size_t src_idx = (size_t)src_idx_f;
            const float frac = src_idx_f - (float)src_idx;
            const int16_t a = samples[std::min(src_idx, sample_count - 1)];
            const int16_t b = samples[std::min(src_idx + 1, sample_count - 1)];
            resampled[i] = (int16_t)((float)a * (1.0f - frac) + (float)b * frac);
        }
    }

    if (!codec_->output_enabled()) {
        esp_timer_stop(audio_power_timer_);
        esp_timer_start_periodic(audio_power_timer_, AUDIO_POWER_CHECK_INTERVAL_MS * 1000);
        codec_->EnableOutput(true);
    }

    if (!codec_->OutputData(resampled)) {
        ESP_LOGE(TAG, "PlayPcm codec output failed");
        return false;
    }
    last_output_time_ = std::chrono::steady_clock::now();
    ESP_LOGI(TAG, "PlayPcm done samples_out=%u", (unsigned)resampled.size());
    return true;
}

bool AudioService::RecordPcm(int16_t* dst, size_t sample_count, int sample_rate) {
    if (dst == nullptr) {
        ESP_LOGW(TAG, "RecordPcm rejected: null dst");
        return false;
    }
    if (sample_count == 0) {
        ESP_LOGW(TAG, "RecordPcm rejected: sample_count=0");
        return false;
    }
    if (codec_ == nullptr) {
        ESP_LOGW(TAG, "RecordPcm rejected: codec not initialized");
        return false;
    }
    if (sample_rate <= 0 || sample_rate > 48000) {
        ESP_LOGW(TAG, "RecordPcm rejected: bad sample_rate=%d", sample_rate);
        return false;
    }
    // Hard cap matching the documented contract. The doc-block above says
    // "<= 1 second of audio per call"; enforce it so a runaway caller cannot
    // stall the synchronous devtool verb task for tens of seconds.
    const size_t kMaxSamples = static_cast<size_t>(sample_rate);
    if (sample_count > kMaxSamples) {
        ESP_LOGW(TAG, "RecordPcm rejected: sample_count=%u > 1s cap=%u",
                 (unsigned)sample_count, (unsigned)kMaxSamples);
        return false;
    }

    // Frame size in samples at the REQUESTED rate. ReadAudioData internally
    // handles resampling from codec_->input_sample_rate() to sample_rate.
    constexpr int kFrameMs = 30;
    constexpr int kWarmupFrames = 1;
    const int frame_samples = sample_rate * kFrameMs / 1000;
    if (frame_samples == 0) {
        ESP_LOGW(TAG, "RecordPcm rejected: frame_samples=0 (rate=%d)", sample_rate);
        return false;
    }

    // ReadAudioData returns `samples_received * channels` interleaved int16
    // (ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...). On sentient-cube the codec has
    // channels = 2 (mic + AEC reference). We strided-extract channel 0 to
    // produce mono samples for the caller. Default to 1 if codec is somehow
    // mis-reporting (defensive — shouldn't happen given the validation above).
    int channels = codec_->input_channels();
    if (channels < 1) channels = 1;

    ESP_LOGI(TAG, "RecordPcm samples=%u rate=%d frame=%d channels=%d",
             (unsigned)sample_count, sample_rate, frame_samples, channels);

    // Warmup: discard initial frames so codec settles. ReadAudioData
    // implicitly calls EnableInput(true) on its first invocation.
    for (int i = 0; i < kWarmupFrames; ++i) {
        std::vector<int16_t> warmup;
        if (!ReadAudioData(warmup, sample_rate, frame_samples)) {
            ESP_LOGW(TAG, "RecordPcm warmup ReadAudioData failed");
            return false;
        }
    }

    size_t collected = 0;
    while (collected < sample_count) {
        std::vector<int16_t> chunk;
        // Short-tail resampler call preceded heap corruption in observed capture;
        // read a full frame even at the tail, then copy only requested mono samples.
        if (!ReadAudioData(chunk, sample_rate, frame_samples)) {
            ESP_LOGW(TAG, "RecordPcm ReadAudioData failed at collected=%u",
                     (unsigned)collected);
            return false;
        }
        // chunk.size() is `mic_samples_received * channels`. Strided extract
        // channel 0; clamp to remaining destination capacity.
        const size_t mic_samples_received =
            chunk.size() / static_cast<size_t>(channels);
        const size_t to_copy =
            std::min(mic_samples_received, sample_count - collected);
        for (size_t i = 0; i < to_copy; ++i) {
            dst[collected + i] = chunk[i * static_cast<size_t>(channels)];
        }
        collected += to_copy;
    }

    last_input_time_ = std::chrono::steady_clock::now();
    ESP_LOGI(TAG, "RecordPcm done collected=%u", (unsigned)collected);
    return true;
}

bool AudioService::IsIdle() {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    return audio_encode_queue_.empty() && audio_decode_queue_.empty() && !decoding_ &&
           audio_playback_queue_.empty() && !output_in_flight_ && audio_testing_queue_.empty();
}

void AudioService::WaitForPlaybackQueueEmpty() {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);
    audio_queue_cv_.wait(lock, [this]() { 
        return service_stopped_ || (audio_decode_queue_.empty() && !decoding_ &&
                                    audio_playback_queue_.empty() && !output_in_flight_);
    });
}

bool AudioService::ResetDecoder() {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_);
    std::unique_lock<std::mutex> decoder_lock(decoder_mutex_);
    if (opus_decoder_ != nullptr) {
        esp_opus_dec_reset(opus_decoder_);
    }
    decoder_lock.unlock();
    timestamp_queue_.clear();
    ++decode_generation_;
    failed_playback_epochs_.clear();
    latest_playback_epoch_ = 0;
    audio_decode_queue_.clear();
    audio_playback_queue_.clear();
    audio_testing_queue_.clear();
    audio_queue_cv_.notify_all();
    // OutputData may block on hardware. Wait without holding queue/decoder locks;
    // failure leaves capture disabled rather than treating old PCM as drained.
    if (!audio_queue_cv_.wait_for(lock, std::chrono::seconds(5), [this]() {
            return !output_in_flight_;
        })) {
        ESP_LOGW(TAG, "Decoder reset timed out waiting for output handoff");
        return false;
    }
    return true;
}

void AudioService::CheckAndUpdateAudioPowerState() {
    auto now = std::chrono::steady_clock::now();
    auto input_elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_input_time_).count();
    auto output_elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_output_time_).count();
    if (input_elapsed > AUDIO_POWER_TIMEOUT_MS && codec_->input_enabled()) {
        codec_->EnableInput(false);
    }
    if (output_elapsed > AUDIO_POWER_TIMEOUT_MS && codec_->output_enabled()) {
        // Keep TX clock when duplex RX is active; otherwise RX may stall on some boards.
        if (!(codec_->duplex() && codec_->input_enabled())) {
            codec_->EnableOutput(false);
        }
    }
    if (!codec_->input_enabled() && !codec_->output_enabled()) {
        esp_timer_stop(audio_power_timer_);
    }
}

void AudioService::SetModelsList(srmodel_list_t* models_list) {
    models_list_ = models_list;

#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32P4
    if (esp_srmodel_filter(models_list_, ESP_MN_PREFIX, NULL) != nullptr) {
        wake_word_ = std::make_unique<CustomWakeWord>();
    } else if (esp_srmodel_filter(models_list_, ESP_WN_PREFIX, NULL) != nullptr) {
        wake_word_ = std::make_unique<AfeWakeWord>();
    } else {
        wake_word_ = nullptr;
    }
#else
    if (esp_srmodel_filter(models_list_, ESP_WN_PREFIX, NULL) != nullptr) {
        wake_word_ = std::make_unique<EspWakeWord>();
    } else {
        wake_word_ = nullptr;
    }
#endif

    if (wake_word_) {
        wake_word_->OnWakeWordDetected([this](const std::string& wake_word) {
            if (callbacks_.on_wake_word_detected) {
                callbacks_.on_wake_word_detected(wake_word);
            }
        });
    }
}

bool AudioService::IsAfeWakeWord() {
#if CONFIG_IDF_TARGET_ESP32S3 || CONFIG_IDF_TARGET_ESP32P4
    return wake_word_ != nullptr && dynamic_cast<AfeWakeWord*>(wake_word_.get()) != nullptr;
#else
    return false;
#endif
}

void AudioService::DeferPlayback(bool defer) {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    playback_deferred_ = defer;
    audio_queue_cv_.notify_all();
}

void AudioService::DiscardPlayback(uint32_t epoch, uint32_t generation) {
    std::lock_guard<std::mutex> lock(audio_queue_mutex_);
    if (generation != decode_generation_) return;
    FailPlaybackOwner(epoch);
    audio_queue_cv_.notify_all();
}

void AudioService::FailPlaybackOwner(uint32_t epoch) {
    failed_playback_epochs_.insert(epoch);
    PrunePlaybackFailures();
    auto same_owner = [epoch](const auto& item) { return item->playback_epoch == epoch; };
    audio_decode_queue_.erase(std::remove_if(audio_decode_queue_.begin(), audio_decode_queue_.end(), same_owner), audio_decode_queue_.end());
    audio_playback_queue_.erase(std::remove_if(audio_playback_queue_.begin(), audio_playback_queue_.end(), same_owner), audio_playback_queue_.end());
}

void AudioService::PrunePlaybackFailures() {
    for (auto it = failed_playback_epochs_.begin(); it != failed_playback_epochs_.end();) {
        const auto epoch = *it;
        if (epoch == 0 || epoch == latest_playback_epoch_ ||
            (decoding_ && epoch == decoding_playback_epoch_) ||
            (output_in_flight_ && epoch == output_playback_epoch_)) ++it;
        else it = failed_playback_epochs_.erase(it);
    }
}

#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
bool AudioService::GetCaptureEnergy(CaptureEnergySnapshot& snapshot) {
    std::unique_lock<std::mutex> lock(audio_queue_mutex_, std::try_to_lock);
    if (!lock.owns_lock() || !capture_energy_.epoch) return false;
    snapshot = capture_energy_;
    return true;
}
#endif
