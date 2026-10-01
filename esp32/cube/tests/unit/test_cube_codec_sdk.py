"""Actual codec core + I2S adapter; driver boundary models failed DMA replacement."""
from pathlib import Path
import sys
from test_cube_security2_sdk import ROOT, run


def test_actual_codec_reconfiguration_failure_and_retry(tmp_path):
    component = ROOT / 'firmware/managed_components/espressif__esp_codec_dev'
    inc = tmp_path / 'include'
    for directory in ('freertos', 'driver', 'hal'):
        (inc / directory).mkdir(parents=True, exist_ok=True)
    (inc / 'esp_err.h').write_text('''#pragma once
#include <stdint.h>
#include <stddef.h>
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 257
#define ESP_ERR_INVALID_ARG 258
#define ESP_ERR_INVALID_STATE 259
#define ESP_ERR_NOT_FOUND 261
#define ESP_ERR_NOT_SUPPORTED 262
''')
    (inc / 'esp_log.h').write_text('''#pragma once
#define ESP_LOGE(...)
#define ESP_LOGW(...)
#define ESP_LOGI(...)
#define ESP_LOGD(...)
''')
    (inc / 'freertos/FreeRTOS.h').write_text('#pragma once\n')
    (inc / 'esp_idf_version.h').write_text('''#pragma once
#define ESP_IDF_VERSION_VAL(a,b,c) ((a)*10000+(b)*100+(c))
#define ESP_IDF_VERSION ESP_IDF_VERSION_VAL(5,5,2)
''')
    (inc / 'hal/i2s_types.h').write_text('''#pragma once
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"
#define SOC_I2S_SUPPORTS_TDM 1
#define SOC_I2S_HW_VERSION_1 0
#define I2S_COMM_MODE_STD 1
#define I2S_COMM_MODE_TDM 2
#define I2S_DIR_RX 0
#define I2S_SLOT_MODE_MONO 1
#define I2S_SLOT_MODE_STEREO 2
#define I2S_STD_SLOT_BOTH 3
#define I2S_MCLK_MULTIPLE_384 384
struct host_channel {int mode,dir,bytes;bool dma_ok,running;};
typedef struct host_channel* i2s_chan_handle_t;
typedef int i2s_clock_src_t;
typedef int i2s_std_slot_mask_t;
typedef int i2s_tdm_slot_mask_t;
typedef struct {int mode,dir;i2s_chan_handle_t pair_chan;} i2s_chan_info_t;
typedef struct {int sample_rate_hz,clk_src,mclk_multiple;} i2s_std_clk_config_t;
typedef i2s_std_clk_config_t i2s_tdm_clk_config_t;
typedef struct {int data_bit_width,slot_bit_width,slot_mode,slot_mask,total_slot,ws_width;bool left_align;} i2s_std_slot_config_t;
typedef i2s_std_slot_config_t i2s_tdm_slot_config_t;
#define I2S_STD_CLK_DEFAULT_CONFIG(rate) {rate,0,256}
#define I2S_TDM_CLK_DEFAULT_CONFIG(rate) {rate,0,256}
#define I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(bits,mode) {bits,bits,mode,3,2,bits,true}
#define I2S_TDM_PHILIPS_SLOT_DEFAULT_CONFIG(bits,mode,mask) {bits,bits,mode,mask,4,bits,false}
int i2s_channel_get_info(i2s_chan_handle_t,i2s_chan_info_t*);
int i2s_channel_enable(i2s_chan_handle_t);
int i2s_channel_disable(i2s_chan_handle_t);
int i2s_channel_reconfig_std_slot(i2s_chan_handle_t,const i2s_std_slot_config_t*);
int i2s_channel_reconfig_tdm_slot(i2s_chan_handle_t,const i2s_tdm_slot_config_t*);
int i2s_channel_reconfig_std_clock(i2s_chan_handle_t,const i2s_std_clk_config_t*);
int i2s_channel_reconfig_tdm_clock(i2s_chan_handle_t,const i2s_tdm_clk_config_t*);
int i2s_channel_read(i2s_chan_handle_t,void*,size_t,size_t*,int);
int i2s_channel_write(i2s_chan_handle_t,const void*,size_t,size_t*,int);
''')
    for name in ('std', 'tdm', 'pdm'):
        (inc / f'driver/i2s_{name}.h').write_text('#include "hal/i2s_types.h"\n')
    objects = []
    includes = [inc, component, component / 'include', component / 'interface']
    sources = ['esp_codec_dev.c', 'platform/audio_codec_data_i2s.c', 'esp_codec_dev_if.c',
               'esp_codec_dev_vol.c', 'audio_codec_sw_vol.c']
    for i, name in enumerate(sources):
        source = component / name
        if i < 2:
            patched = tmp_path / source.name
            run(sys.executable, ROOT / 'firmware/scripts/patch_codec_errors.py', source, patched)
            source = patched
        obj = tmp_path / f'codec{i}.o'
        run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-include', 'stdlib.h',
            *[f'-I{x}' for x in includes], '-c', source, '-o', obj)
        objects.append(obj)
    binary = tmp_path / 'codec'
    run('cc', '-std=gnu11', '-g', '-fsanitize=address', *[f'-I{x}' for x in includes],
        Path(__file__).with_name('codec_sdk_host.c'), *objects, '-lm', '-o', binary)
    run(binary)


def test_box_open_failure_does_not_publish_samples(tmp_path):
    from test_cube_gateway_lifecycle import function
    import subprocess
    source = (ROOT / 'firmware/main/audio/codecs/box_audio_codec.cc').read_text()
    getter = function(source, 'bool BoxAudioCodec::GetMic1GainRegister(')
    methods = '\n'.join(function(source, signature) for signature in (
        'void BoxAudioCodec::EnableInput(', 'void BoxAudioCodec::EnableOutput(',
        'int BoxAudioCodec::Read(', 'int BoxAudioCodec::Write('))
    base_source = (ROOT / 'firmware/main/audio/audio_codec.cc').read_text()
    base = '\n'.join(function(base_source, marker) for marker in ('bool AudioCodec::InputData(', 'bool AudioCodec::OutputData('))
    constructor = function(source, 'BoxAudioCodec::BoxAudioCodec(')
    play = function((ROOT / 'firmware/main/audio/audio_service.cc').read_text(), 'bool AudioService::PlayPcm(')
    program = r'''
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <future>
#include <mutex>
#include <shared_mutex>
#include <vector>
template<typename... T> void host_log(T...) {}
#define ESP_LOGE(...) host_log(__VA_ARGS__)
#define TAG "BoxAudioCodec"
#define ESP_LOGW(...)
#define ESP_LOGI(...)
#define CONFIG_BOARD_TYPE_SENTIENT_CUBE 1
#define ESP_ERROR_CHECK(call) do { int error=(call); if(error) throw error; } while(0)
constexpr int ESP_OK=0,ESP_FAIL=-1;
using gpio_num_t=int;
using i2c_port_t=int;
constexpr int I2S_NUM_0=0,ESP_CODEC_DEV_WORK_MODE_DAC=1,ESP_CODEC_DEV_TYPE_OUT=2,ESP_CODEC_DEV_TYPE_IN=1;
constexpr int ES7210_SEL_MIC1=1,ES7210_SEL_MIC2=2,ES7210_SEL_MIC3=4,ES7210_SEL_MIC4=8;
struct audio_codec_i2s_cfg_t {int port,rx_handle,tx_handle;};
struct audio_codec_i2c_cfg_t {int port,addr;void* bus_handle;};
struct es8311_codec_cfg_t {int ctrl_if,gpio_if,codec_mode,pa_pin;bool use_mclk;struct {float pa_voltage,codec_dac_voltage;} hw_gain;};
struct es7210_codec_cfg_t {int ctrl_if,mic_selected;};
struct esp_codec_dev_cfg_t {int dev_type,codec_if,data_if;};
int audio_codec_new_i2s_data(audio_codec_i2s_cfg_t*) {return 1;}
int audio_codec_new_i2c_ctrl(audio_codec_i2c_cfg_t*) {return 1;}
int audio_codec_new_gpio() {return 1;}
int es8311_codec_new(es8311_codec_cfg_t*) {return 1;}
int es7210_codec_new(es7210_codec_cfg_t*) {return 1;}
int esp_codec_dev_new(esp_codec_dev_cfg_t* c) {return c->dev_type;}

#define ESP_CODEC_DEV_MAKE_CHANNEL_MASK(n) (1U<<(n))
constexpr int ESP_CODEC_DEV_OK=0;
struct esp_codec_dev_sample_info_t {int bits_per_sample,channel;unsigned channel_mask,sample_rate;int mclk_multiple;};
struct SystemInfo {static void LogHeap(const char*) {}};
int open_error=-1,close_error=0,io_error=0,reads=0,writes=0,closes=0;
int reg_error=0,reg_value=0x1d,reg_reads=0, gain_calls=0, gain_db=-1, gain_mask=0, open_mask=0;
int esp_codec_dev_open(int dev,esp_codec_dev_sample_info_t* fs) {if(dev==1) open_mask=fs->channel_mask;return open_error;}
int esp_codec_dev_close(int) {++closes;return close_error;}
int esp_codec_dev_set_in_channel_gain(int,unsigned mask,float db) {++gain_calls;gain_mask=mask;gain_db=db;return 0;}
int esp_codec_dev_read_reg(int,int reg,int* value) {assert(reg==0x43);++reg_reads;*value=reg_value;return reg_error;}
int esp_codec_dev_set_out_vol(int,int) {return 0;}
int esp_codec_dev_read(int,void*,size_t) {++reads;return io_error;}
int esp_codec_dev_write(int,void*,size_t) {++writes;return io_error;}
struct AudioCodec {
    bool input_enabled_=false,output_enabled_=false;
    void EnableInput(bool value) {input_enabled_=value;}
    void EnableOutput(bool value) {output_enabled_=value;}
    virtual int Read(int16_t*,int)=0;
    virtual int Write(const int16_t*,int)=0;
    bool OutputData(std::vector<int16_t>&);
    bool duplex_=false;
    int input_channels_=0,input_sample_rate_=0;
    bool InputData(std::vector<int16_t>&);
};
struct BoxAudioCodec : AudioCodec {
    std::shared_mutex data_if_mutex_;
    bool input_reference_=true;
    int output_sample_rate_=24000,input_dev_=1,output_dev_=2,output_volume_=70;
    float input_gain_=30;
#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    int mic1_gain_reg43_=-1;
    bool GetMic1GainRegister(int&);
#endif
    void EnableInput(bool);
    void EnableOutput(bool);
    int Read(int16_t*,int) override;
    int Write(const int16_t*,int) override;
    BoxAudioCodec() = default;
    BoxAudioCodec(void*,int,int,gpio_num_t,gpio_num_t,gpio_num_t,gpio_num_t,gpio_num_t,gpio_num_t,uint8_t,uint8_t,bool,int mic1_gain_db=30);
    int tx_handle_=1,rx_handle_=2,data_if_=0,out_ctrl_if_=0,in_ctrl_if_=0,gpio_if_=0,out_codec_if_=0,in_codec_if_=0;
    void CreateDuplexChannels(int,int,int,int,int) {}
    bool output_enabled() {return output_enabled_;}
    int output_sample_rate() {return output_sample_rate_;}
};
constexpr int AUDIO_POWER_CHECK_INTERVAL_MS=1000;
void esp_timer_stop(int) {}
void esp_timer_start_periodic(int,int) {}
struct AudioService {
    BoxAudioCodec* codec_;
    int audio_power_timer_=0;
    std::chrono::steady_clock::time_point last_output_time_;
    bool PlayPcm(const int16_t*,size_t,int);
};
''' + base + '\n#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE\n' + getter + '\n#endif\n' + methods + constructor.replace('!= NULL', '!= 0') + play + r'''
int main() {
    BoxAudioCodec box;std::vector<int16_t> samples(16);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    int actual = -2;
    assert(!box.GetMic1GainRegister(actual) && actual==-2);
#endif
    box.EnableInput(true);box.EnableOutput(true);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    assert(!box.GetMic1GainRegister(actual) && reg_reads==0);
#endif
    assert(!box.input_enabled_ && !box.output_enabled_ && closes==2);
    assert(!box.InputData(samples) && box.Write(samples.data(),samples.size())==0 && !reads && !writes);
    open_error=0;
    box.EnableInput(true);box.EnableOutput(true);
    assert(box.input_enabled_ && box.output_enabled_);
    assert(open_mask==3 && gain_mask==1 && gain_db==30 && gain_calls==1);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    assert(box.GetMic1GainRegister(actual) && actual==0x1d); // Driver, not requested gain.
    {   // Diagnostic must not wait for an in-progress codec lifecycle operation.
        std::unique_lock<std::shared_mutex> lock(box.data_if_mutex_);
        auto query = std::async(std::launch::async, [&] { return box.GetMic1GainRegister(actual); });
        bool prompt = query.wait_for(std::chrono::milliseconds(500)) == std::future_status::ready;
        lock.unlock(); // Release before checking: regression must fail, not hang test.
        assert(prompt && !query.get() && actual==0x1d);
    }
#endif
    box.EnableInput(false); // Last readback survives successful close.
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    assert(box.GetMic1GainRegister(actual) && actual==0x1d);
    reg_error=-1;
    box.EnableInput(true);
    assert(box.input_enabled_ && !box.GetMic1GainRegister(actual));
    reg_error=0;
#else
    assert(reg_reads==0);
    box.EnableInput(true);
    assert(reg_reads==0);
#endif
    assert(box.InputData(samples) && box.Write(samples.data(),samples.size())==16);
    io_error=-1;
    assert(!box.InputData(samples) && box.Write(samples.data(),samples.size())==0);
    AudioService service{};service.codec_=&box;
    assert(!service.PlayPcm(samples.data(),samples.size(),24000));
    io_error=0;
    assert(service.PlayPcm(samples.data(),samples.size(),24000));
    close_error=-1;
    box.EnableInput(false);box.EnableOutput(false);
    assert(box.input_enabled_ && box.output_enabled_); // No unchecked shutdown claim.
    close_error=0;
    box.EnableInput(false);box.EnableOutput(false);
    assert(!box.input_enabled_ && !box.output_enabled_);
    open_error=-1;
    assert(!service.PlayPcm(samples.data(),samples.size(),24000));
    // Execute actual constructor (factories/channel setup stubbed): init cannot
    // return after failed capture prime or failed ADC close.
    for(int phase=0;phase<3;++phase) {
        open_error=phase==0?-1:0;
        close_error=phase==1?-1:0;
        bool initialized=false;
        try {
            BoxAudioCodec primed(nullptr,24000,24000,0,0,0,0,0,0,0,0,true);
            initialized=true;
            assert(!primed.input_enabled_ && !primed.output_enabled_);
        } catch(int error) {assert(error!=0);}
        assert(initialized==(phase==2));
    }
    reg_value=0x1d; // MIC1 enable bit + observed 36-dB nibble, not synthesized from request.
    BoxAudioCodec tuned(nullptr,24000,24000,0,0,0,0,0,0,0,0,true,36);
    assert(gain_db==36 && gain_mask==1 && open_mask==3);
#if CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE
    assert(tuned.GetMic1GainRegister(actual) && actual==reg_value);
    assert((actual & 0x0f)==13);
    tuned.EnableInput(true);
    reg_error=-1;
    tuned.EnableInput(false);
    tuned.EnableInput(true);
    assert(!tuned.GetMic1GainRegister(actual));
    tuned.EnableInput(false);
    reg_error=0;
    reg_value=0x1a;
    tuned.EnableInput(true);
    assert(tuned.GetMic1GainRegister(actual) && actual==reg_value);
    tuned.EnableInput(false);
    assert(tuned.GetMic1GainRegister(actual) && actual==reg_value);
#else
    assert(reg_reads==0);
    tuned.EnableInput(true);
    tuned.EnableInput(false);
    tuned.EnableInput(true);
    assert(reg_reads==0 && gain_db==36 && gain_mask==1);
#endif
}

'''
    (tmp_path / 'box.cc').write_text(program)
    for debug in (1, 0):
        binary = tmp_path / f'box-{debug}'
        subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-fsanitize=address', '-pthread',
                        f'-DCONFIG_ESP32_DEVTOOL_COMPANION_ENABLE={debug}',
                        str(tmp_path / 'box.cc'), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
    board = (ROOT / 'firmware/main/boards/sentient-cube/sentient_cube.cc').read_text()
    kconfig = (ROOT / 'firmware/main/Kconfig.projbuild').read_text()
    dump = (ROOT / 'firmware/main/devtool_verbs/audio_misc.cc').read_text()
    assert 'AUDIO_INPUT_REFERENCE,\n            CONFIG_CUBE_MIC1_GAIN_DB);' in board
    assert 'config CUBE_MIC1_GAIN_DB' in kconfig and 'default 36' in kconfig
    assert 'mic1_gain_requested_db' in dump and 'mic1_gain_reg43' in dump
    assert 'cJSON_AddNullToObject(out_result, "mic1_gain_reg43")' in dump
    guard = '#if CONFIG_BOARD_TYPE_SENTIENT_CUBE && CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE'
    header = (ROOT / 'firmware/main/audio/codecs/box_audio_codec.h').read_text()
    assert header.count(guard) == 2  # Retained field and getter absent in release.
    assert source.count(guard) == 3  # Getter, reset, and I2C read absent in release.
    assert guard + '\nextern "C" bool cube_mic1_gain_register' in board
