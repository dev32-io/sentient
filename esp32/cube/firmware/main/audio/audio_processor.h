#ifndef AUDIO_PROCESSOR_H
#define AUDIO_PROCESSOR_H

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

#include <model_path.h>
#include "audio_codec.h"

class AudioProcessor {
public:
    virtual ~AudioProcessor() = default;
    
    virtual void Initialize(AudioCodec* codec, int frame_duration_ms, srmodel_list_t* models_list) = 0;
    // Feed/read and output retain the immutable capture token. Stop acknowledges
    // completion of in-flight callbacks and buffer reset; false means no safe
    // capture transition (caller must cancel, never commit a partial tail).
    virtual void Feed(std::vector<int16_t>&& data, uint32_t capture_generation) = 0;
    virtual bool Start(uint32_t capture_generation) = 0;
    virtual bool Stop() = 0;
    virtual bool IsRunning() = 0;
    virtual void OnOutput(std::function<void(std::vector<int16_t>&& data, uint32_t capture_generation)> callback) = 0;
    virtual void OnVadStateChange(std::function<void(bool speaking)> callback) = 0;
    virtual size_t GetFeedSize() = 0;
    virtual void EnableDeviceAec(bool enable) = 0;
};

#endif
