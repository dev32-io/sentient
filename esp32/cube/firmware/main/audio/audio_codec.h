#ifndef _AUDIO_CODEC_H
#define _AUDIO_CODEC_H

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <driver/i2s_std.h>

#include <vector>
#include <string>
#include <functional>

#include "board.h"

#define AUDIO_CODEC_DMA_DESC_NUM 6
// 120 frames/desc (was 240). 240 @ 24kHz × 4-slot-16bit × 6 desc = 11.5 KB
// of internal SRAM per RX chain. Post-Phase-6a (transcript labels, devtool
// companion, SentientWsProtocol, TLS pinning) the free SRAM at IDLE is
// ~13 KB / 2.5 KB min — esp_codec_dev_open's i2s_tdm_set_slot reconfig
// allocates a fresh descriptor chain before freeing the boot-init chain,
// needs ~2× headroom, OOMs, panics. Halving frame count cuts each chain
// to ~5.7 KB. Latency cost: 5 ms/buffer at 24 kHz — imperceptible.
#define AUDIO_CODEC_DMA_FRAME_NUM 120

class AudioCodec {
public:
    AudioCodec();
    virtual ~AudioCodec();
    
    virtual void SetOutputVolume(int volume);
    virtual void SetInputGain(float gain);
    virtual void EnableInput(bool enable);
    virtual void EnableOutput(bool enable);

    virtual void OutputData(std::vector<int16_t>& data);
    virtual bool InputData(std::vector<int16_t>& data);
    virtual void Start();

    inline bool duplex() const { return duplex_; }
    inline bool input_reference() const { return input_reference_; }
    inline int input_sample_rate() const { return input_sample_rate_; }
    inline int output_sample_rate() const { return output_sample_rate_; }
    inline int input_channels() const { return input_channels_; }
    inline int output_channels() const { return output_channels_; }
    inline int output_volume() const { return output_volume_; }
    inline float input_gain() const { return input_gain_; }
    inline bool input_enabled() const { return input_enabled_; }
    inline bool output_enabled() const { return output_enabled_; }

protected:
    i2s_chan_handle_t tx_handle_ = nullptr;
    i2s_chan_handle_t rx_handle_ = nullptr;

    bool duplex_ = false;
    bool input_reference_ = false;
    bool input_enabled_ = false;
    bool output_enabled_ = false;
    int input_sample_rate_ = 0;
    int output_sample_rate_ = 0;
    int input_channels_ = 1;
    int output_channels_ = 1;
    int output_volume_ = 70;
    float input_gain_ = 0.0;

    virtual int Read(int16_t* dest, int samples) = 0;
    virtual int Write(const int16_t* data, int samples) = 0;
};

#endif // _AUDIO_CODEC_H
