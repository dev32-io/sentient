#pragma once

#include "sdkconfig.h"

#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
#include <cstddef>
#include <cstdint>
#include <limits>

// Content-free PCM16 aggregates. No storage, locks, or allocation. AudioService's
// queue mutex owns published values; producers reduce each frame outside it.
struct CaptureEnergy {
    uint64_t samples = 0, squares = 0, clipped = 0;
    uint32_t peak = 0;
    bool valid = true;

    static CaptureEnergy Measure(const int16_t* pcm, size_t count, size_t stride = 1) {
        CaptureEnergy result;
        if (!stride || count > std::numeric_limits<uint64_t>::max() / (uint64_t{1} << 30)) {
            result.valid = false;
            return result;
        }
        for (size_t i = 0; i < count; i += stride) {
            const int32_t value = pcm[i];
            const uint32_t magnitude = value < 0 ? -value : value;
            result.squares += static_cast<uint64_t>(magnitude) * magnitude;
            if (magnitude > result.peak) result.peak = magnitude;
            result.clipped += value == -32768 || value == 32767;
            ++result.samples;
        }
        return result;
    }

    void Merge(const CaptureEnergy& frame) {
        // At most 2^34-1 samples (~12 days at 16 kHz): even all -32768
        // cannot overflow uint64 sum-of-squares. Longer capture is unavailable.
        constexpr uint64_t limit = std::numeric_limits<uint64_t>::max() / (uint64_t{1} << 30);
        if (!valid || !frame.valid || frame.samples > limit - samples) {
            valid = false;
            return;
        }
        samples += frame.samples;
        squares += frame.squares;
        clipped += frame.clipped;
        if (frame.peak > peak) peak = frame.peak;
    }
};

struct CaptureEnergySnapshot {
    enum class State { Idle, Capturing, Draining, Complete, Retired, Failed };
    uint64_t epoch = 0;
    uint32_t generation = 0;
    State state = State::Idle;
    int native_rate_hz = 0;
    int encoder_rate_hz = 16000;
    uint64_t injected_samples = 0;
    bool afe_counts_available = false; // finalized only, per-channel samples at 16 kHz
    size_t afe_fed_samples = 0, afe_fetched_samples = 0; // fed includes feed padding

    bool Accepts(uint32_t owner) const {
        return generation == owner && (state == State::Capturing || state == State::Draining);
    }
    CaptureEnergy native_mic; // physical channel 0 before rate conversion; no injection/padding
    CaptureEnergy encoder_input; // accepted mono queue input, including injection/AFE padding
};
#endif
