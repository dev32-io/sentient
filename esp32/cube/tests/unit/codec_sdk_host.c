#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_codec_dev_os.h"
#include "hal/i2s_types.h"

static int fail_mode=-1, replacements, enables, locks, codec_failure;
static bool short_io;
static i2s_chan_handle_t rx,tx;
void* esp_codec_dev_mutex_create(void) {return malloc(1);}
int esp_codec_dev_mutex_lock(void* p,int ms) {assert(p && ms==1000 && !locks);++locks;return 0;}
int esp_codec_dev_mutex_unlock(void* p) {assert(p && locks==1);--locks;return 0;}
void esp_codec_dev_mutex_destroy(void* p) {free(p);}
void esp_codec_dev_sleep(int ms) {(void)ms;}
int i2s_channel_get_info(i2s_chan_handle_t c,i2s_chan_info_t* out) {
    assert(c);out->mode=c->mode;out->dir=c->dir;out->pair_chan=c==rx?tx:rx;return 0;
}
int i2s_channel_enable(i2s_chan_handle_t c) {
    // IDF rejects duplicate enable; starting missing descriptors would panic.
    assert(c && c->dma_ok && c->bytes>0 && !c->running);
    if((fail_mode==2 && c==rx) || (fail_mode==3 && c==tx))return ESP_FAIL;
    c->running=true;++enables;return 0;
}
int i2s_channel_disable(i2s_chan_handle_t c) {
    assert(c && c->running);
    if((fail_mode==6 && c==rx) || (fail_mode==7 && c==tx))return ESP_FAIL;
    c->running=false;return 0;
}
static int slot(i2s_chan_handle_t c,const i2s_std_slot_config_t* cfg) {
    assert(c && !c->running);
    assert(cfg->data_bit_width==16 && cfg->ws_width==32);
    assert(cfg->slot_bit_width==(c==tx ? 32 : 16));
    int active=cfg->slot_mode==I2S_SLOT_MODE_MONO ? 1 :
               c->mode==I2S_COMM_MODE_STD ? 2 : __builtin_popcount(cfg->slot_mask);
    int bytes=120*active*cfg->data_bit_width/8;
    if(bytes!=c->bytes) {
        ++replacements;
        c->dma_ok=false;c->bytes=0; // IDF frees old descriptors first.
        if((fail_mode==0 && c==rx) || (fail_mode==1 && c==tx))return ESP_ERR_NO_MEM;
        c->bytes=bytes;c->dma_ok=true;
    }
    return 0;
}
int i2s_channel_reconfig_std_slot(i2s_chan_handle_t c,const i2s_std_slot_config_t* cfg) {return slot(c,cfg);}
int i2s_channel_reconfig_tdm_slot(i2s_chan_handle_t c,const i2s_tdm_slot_config_t* cfg) {return slot(c,cfg);}
static int clock_config(i2s_chan_handle_t c,const i2s_std_clk_config_t* cfg) {
    assert(!c->running && cfg->sample_rate_hz==24000 && cfg->mclk_multiple==256);
    return ((fail_mode==4 && c==rx) || (fail_mode==5 && c==tx)) ? ESP_FAIL : 0;
}
int i2s_channel_reconfig_std_clock(i2s_chan_handle_t c,const i2s_std_clk_config_t* cfg) {return clock_config(c,cfg);}
int i2s_channel_reconfig_tdm_clock(i2s_chan_handle_t c,const i2s_tdm_clk_config_t* cfg) {return clock_config(c,cfg);}
int i2s_channel_read(i2s_chan_handle_t c,void* data,size_t size,size_t* bytes,int ms) {
    assert(c->running && tx->running && c->dma_ok && ms==1000);memset(data,0,size);*bytes=short_io?size/2:size;return 0;
}
int i2s_channel_write(i2s_chan_handle_t c,const void* data,size_t size,size_t* bytes,int ms) {
    (void)data;assert(c->running && c->dma_ok && ms==1000);*bytes=short_io?size/2:size;return 0;
}
static int codec_enable(const audio_codec_if_t* c,bool enable) {(void)c;return codec_failure==(enable?1:2)?ESP_FAIL:0;}
static int codec_vol(const audio_codec_if_t* c,float v) {(void)c;(void)v;return 0;}
static int codec_mute(const audio_codec_if_t* c,bool mute) {(void)c;(void)mute;return codec_failure==3?ESP_FAIL:0;}
static const audio_codec_if_t codec={.enable=codec_enable,.set_vol=codec_vol,.mute_mic=codec_mute};
static esp_codec_dev_sample_info_t in_fs={.bits_per_sample=16,.channel=4,.channel_mask=3,.sample_rate=24000};
static esp_codec_dev_sample_info_t out_fs={.bits_per_sample=16,.channel=1,.sample_rate=24000};
static unsigned char samples[16];

int main(void) {
    // All initial DMA/clock/start failures, with and without a live speaker peer.
    for(int reference=0;reference<2;++reference)
    for(int peer=0;peer<2;++peer) for(int mode=0;mode<6;++mode) {
        in_fs.channel_mask=reference?3:1;
        struct host_channel input={I2S_COMM_MODE_TDM,0,960,true,false};
        struct host_channel output={I2S_COMM_MODE_STD,1,480,true,false};
        rx=&input;tx=&output;fail_mode=-1;replacements=enables=0;
        audio_codec_i2s_cfg_t cfg={.port=0,.rx_handle=rx,.tx_handle=tx};
        const audio_codec_data_if_t* data=audio_codec_new_i2s_data(&cfg);assert(data);
        esp_codec_dev_cfg_t devcfg={.dev_type=ESP_CODEC_DEV_TYPE_IN,.codec_if=&codec,.data_if=data};
        esp_codec_dev_handle_t in=esp_codec_dev_new(&devcfg);assert(in);
        devcfg.dev_type=ESP_CODEC_DEV_TYPE_OUT;
        esp_codec_dev_handle_t out=esp_codec_dev_new(&devcfg);assert(out);
        if(peer) assert(esp_codec_dev_open(out,&out_fs)==0);
        fail_mode=mode;
        int ret=esp_codec_dev_open(in,&in_fs);
        if(peer && (mode==1 || mode==3 || mode==5)) {
            // Fixed bus: opening RX must never touch live TX allocation/clock/start.
            assert(ret==0);
        } else {
            assert(ret==(mode<2 ? ESP_ERR_NO_MEM : ESP_FAIL));
            assert(esp_codec_dev_read(in,samples,sizeof(samples))!=0);
            assert(tx->running==(bool)peer && !rx->running);
            if(peer) assert(esp_codec_dev_write(out,samples,sizeof(samples))==0);
            fail_mode=-1;
            assert(esp_codec_dev_open(in,&in_fs)==0);
        }
        assert(rx->running && tx->running);
        assert(esp_codec_dev_read(in,samples,sizeof(samples))==0);
        fail_mode=-1;
        assert(esp_codec_dev_open(out,&out_fs)==0);
        assert(esp_codec_dev_write(out,samples,sizeof(samples))==0);
        short_io=true;
        assert(esp_codec_dev_read(in,samples,sizeof(samples))!=0);
        assert(esp_codec_dev_write(out,samples,sizeof(samples))!=0);
        short_io=false;
        // Warm close -> speaker-only -> idle -> capture: no late allocations.
        assert(esp_codec_dev_close(in)==0);
        assert(tx->running); // RX may be kept running for TX; ADC is disabled.
        assert(esp_codec_dev_close(out)==0);
        assert(!rx->running && !tx->running);
        int before=replacements;
        fail_mode=1;
        assert(esp_codec_dev_open(out,&out_fs)==0);
        assert(esp_codec_dev_write(out,samples,sizeof(samples))==0);
        assert(esp_codec_dev_close(out)==0);
        assert(esp_codec_dev_open(in,&in_fs)==0);
        assert(replacements==before && tx->bytes==240 && rx->bytes==(reference?480:240));
        // Output open failure/retry while capture is active cannot stop either
        // actual channel (TX already runs as RX's clock, even with OUT closed).
        codec_failure=1;
        assert(esp_codec_dev_open(out,&out_fs)==ESP_FAIL);
        assert(rx->running && tx->running);
        assert(esp_codec_dev_read(in,samples,sizeof(samples))==0);
        codec_failure=0;
        assert(esp_codec_dev_open(out,&out_fs)==0);
        assert(esp_codec_dev_close(out)==0);
        assert(rx->running && tx->running);
        assert(esp_codec_dev_read(in,samples,sizeof(samples))==0);
        // Codec shutdown failure is propagated, IO invalidated, close retry real.
        codec_failure=2;
        assert(esp_codec_dev_close(in)==ESP_FAIL);
        assert(esp_codec_dev_read(in,samples,sizeof(samples))!=0);
        assert(esp_codec_dev_open(in,&in_fs)==ESP_FAIL);
        codec_failure=0;fail_mode=-1;
        assert(esp_codec_dev_close(in)==0);
        // Driver shutdown failure and retry cannot leave stale running flags.
        for(int stop=6;stop<=7;++stop) {
            assert(esp_codec_dev_open(in,&in_fs)==0);
            fail_mode=stop;
            assert(esp_codec_dev_close(in)==ESP_FAIL);
            fail_mode=-1;
            assert(esp_codec_dev_close(in)==0);
            assert(!rx->running && !tx->running);
        }
        // Hardware codec enable failure must not damage live speaker state.
        assert(esp_codec_dev_open(out,&out_fs)==0);
        codec_failure=1;
        assert(esp_codec_dev_open(in,&in_fs)==ESP_FAIL);
        assert(tx->running && esp_codec_dev_write(out,samples,sizeof(samples))==0);
        codec_failure=3; // Restoring input mute is also part of opening.
        assert(esp_codec_dev_open(in,&in_fs)==ESP_FAIL);
        assert(tx->running && esp_codec_dev_write(out,samples,sizeof(samples))==0);
        codec_failure=0;
        assert(esp_codec_dev_open(in,&in_fs)==0);
        assert(rx->running && tx->running && !locks);
        // Reject rate changes, not silently retune a running peer.
        assert(esp_codec_dev_close(in)==0);
        in_fs.sample_rate=16000;
        assert(esp_codec_dev_open(in,&in_fs)!=0 && tx->running);
        in_fs.sample_rate=24000;
        esp_codec_dev_delete(in);esp_codec_dev_delete(out);
        assert(!rx->running && !tx->running);
        audio_codec_delete_data_if(data);
    }
}
