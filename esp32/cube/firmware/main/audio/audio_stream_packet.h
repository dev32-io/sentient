#pragma once

#include <cstdint>
#include <vector>

struct AudioStreamPacket {
    bool pcm = false; // PCM16LE; otherwise raw Opus packet.
    int sample_rate = 0;
    int frame_duration = 0;
    uint32_t timestamp = 0;
    uint32_t playback_epoch = 0; // Local downlink owner; zero for unowned sounds/uplink.
    std::vector<uint8_t> payload;
};
