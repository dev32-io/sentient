"""Cube-only fixed 64-BCLK duplex bus and checked codec lifecycle (pinned SDK)."""
from pathlib import Path
import hashlib
import sys


CUBE_FIXED_FORMAT = r'''
/* Cube owns one duplex interface. Driver state is separate from client intent:
 * RX needs master TX, and an active RX must not be stopped underneath TX. */
static int cube_run(i2s_data_t *data, bool input, bool output)
{
    bool tx = input || output;
    bool rx = input || (output && data->rx_running);
    int ret;
    if (tx) {
        ret = _i2s_drv_enable(data, true, true);
        if (ret != ESP_CODEC_DEV_OK) return ret;
    }
    ret = _i2s_drv_enable(data, false, rx);
    if (ret != ESP_CODEC_DEV_OK) return ret;
    return _i2s_drv_enable(data, true, tx);
}

static int _i2s_data_enable(const audio_codec_data_if_t *h, esp_codec_dev_type_t type, bool enable)
{
    i2s_data_t *data = (i2s_data_t *)h;
    if (!data || !data->is_open) return ESP_CODEC_DEV_WRONG_STATE;
    int ret = _i2s_lock(data, __func__);
    if (ret != ESP_CODEC_DEV_OK) return ret;
    bool input = (type & ESP_CODEC_DEV_TYPE_IN) ? enable : data->in_enable;
    bool output = (type & ESP_CODEC_DEV_TYPE_OUT) ? enable : data->out_enable;
    if ((input || output) && !data->out_fs.sample_rate) {
        ret = ESP_CODEC_DEV_WRONG_STATE;
    } else if (input && !data->in_fs.sample_rate) {
        ret = ESP_CODEC_DEV_WRONG_STATE;
    } else {
        ret = cube_run(data, input, output);
        if (ret == ESP_CODEC_DEV_OK) {
            data->in_enable = input;
            data->out_enable = output;
        } else {
            /* Keep actual flags on every successful driver transition, including
             * rollback failure. Next close/open reconciles instead of trusting
             * stale client intent. Never stop an already-running peer on open. */
            int rollback = cube_run(data, data->in_enable, data->out_enable);
            if (rollback != ESP_CODEC_DEV_OK) ret = rollback;
        }
    }
    _i2s_unlock(data);
    return ret;
}

static int _i2s_data_set_fmt(const audio_codec_data_if_t *h, esp_codec_dev_type_t type,
                             esp_codec_dev_sample_info_t *fs)
{
    i2s_data_t *data = (i2s_data_t *)h;
    if (!data || !data->is_open || !fs) return ESP_CODEC_DEV_INVALID_ARG;
    /* Preserve PCM payloads, masks and rate. Only bus slot width is fixed.
     * Reject unsupported requests before touching either live channel. */
    bool input = type == ESP_CODEC_DEV_TYPE_IN;
    if ((!input && type != ESP_CODEC_DEV_TYPE_OUT) || fs->bits_per_sample != 16 ||
        !fs->sample_rate || fs->sample_rate >= 192000 ||
        (fs->mclk_multiple && fs->mclk_multiple != 256) ||
        (input ? (fs->channel != 4 || (fs->channel_mask != 1 && fs->channel_mask != 3))
               : (fs->channel != 1 || fs->channel_mask != 0))) {
        return ESP_CODEC_DEV_NOT_SUPPORT;
    }
    int ret = _i2s_lock(data, __func__);
    if (ret != ESP_CODEC_DEV_OK) return ret;
    if ((data->out_fs.sample_rate && data->out_fs.sample_rate != fs->sample_rate) ||
        (input && data->in_fs.sample_rate && data->in_fs.channel_mask != fs->channel_mask)) {
        ret = ESP_CODEC_DEV_NOT_SUPPORT;
        goto done;
    }
    if (!data->out_fs.sample_rate) {
        esp_codec_dev_sample_info_t tx = *fs;
        tx.channel = 2;
        tx.channel_mask = 1;
        ret = set_drv_fs(data->out_handle, true, 32, data->clk_src, &tx);
        if (ret != ESP_CODEC_DEV_OK) goto done;
        data->out_fs = tx;
    }
    if (input && !data->in_fs.sample_rate) {
        ret = set_drv_fs(data->in_handle, false, 16, data->clk_src, fs);
        if (ret == ESP_CODEC_DEV_OK) data->in_fs = *fs;
    }
done:
    _i2s_unlock(data);
    return ret;
}

'''

def patch(source: str, name: str) -> str:
    hashes = {
        'esp_codec_dev.c': 'b7a17e2ad412f4c08e0e9324aea0f217a49305510fd80e7ef3420fb31d7fd2ce',
        'audio_codec_data_i2s.c': 'b30d62d4e3e4a2dbfcdb95c6b137109f88997a19281236c6f8fe16a8f52dc9d7',
    }
    if hashlib.sha256(source.encode()).hexdigest() != hashes[name]:
        raise ValueError('Codec source changed; review Cube error propagation before building')
    if name == 'audio_codec_data_i2s.c':
        # Cube-only build substitution. Keep SDK slot/clock programming, but fix
        # the bus at 64 BCLK/frame: TX mono PCM16 in 32-bit slots, RX 4x16.
        # Channels arrive READY (not RUNNING) from Box. No peer expansion exists.
        source = source.replace('    bool                         in_disable_pending;',
                                '    bool                         tx_running;\n    bool                         rx_running;\n    bool                         in_disable_pending;')
        for field in ('in_disable_pending', 'out_disable_pending', 'in_reconfig', 'out_reconfig'):
            source = source.replace(f'    bool                         {field};\n', '')
        source = source.replace('    esp_codec_dev_sample_info_t  fs;\n', '')
        source = source.replace('    memset(&i2s_data->fs, 0, sizeof(esp_codec_dev_sample_info_t));\n', '')
        a = source.index('static i2s_data_t *get_paired(')
        b = source.index('static int _i2s_drv_enable(', a)
        source = source[:a] + source[b:]
        source = source.replace('''    int ret;
    if (enable) {''', '''    bool *running = playback ? &i2s_data->tx_running : &i2s_data->rx_running;
    if (*running == enable) return ESP_CODEC_DEV_OK;
    int ret;
    if (enable) {''')
        source = source.replace('return ret == ESP_OK ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_DRV_ERR;',
                                '*running = ret == ESP_OK ? enable : *running;\n    return ret;')
        a = source.index('static uint8_t get_bits(')
        b = source.index('static int set_drv_fs(', a)
        source = source[:a] + source[b:]
        a = source.index('static int set_drv_fs(')
        b = source.index('static int set_fs(', a)
        source = source[:a] + source[a:b].replace('return ESP_CODEC_DEV_DRV_ERR;', 'return ret;') + source[b:]
        a = source.index('static int set_fs(')
        b = source.index('#endif  /* ESP_IDF_VERSION', a)
        source = source[:a] + source[b:]
        a = source.index('static int _i2s_data_enable(')
        b = source.index('static int _i2s_data_read(', a)
        source = source[:a] + CUBE_FIXED_FORMAT + source[b:]
        # Cube never silently fabricates IO during peer format changes.
        a = source.index('    if (i2s_data->in_reconfig) {')
        b = source.index('    int ret = i2s_channel_read', a)
        source = source[:a] + source[b:]
        a = source.index('    if (i2s_data->out_reconfig) {')
        b = source.index('    int ret = i2s_channel_write', a)
        source = source[:a] + source[b:]
        # IDF may return OK with short IO when disable interrupts a transfer.
        source = source.replace('return ret == 0 ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_DRV_ERR;',
                                'return ret == 0 && bytes_read == size ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_DRV_ERR;', 1)
        source = source.replace('return ret == 0 ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_DRV_ERR;',
                                'return ret == 0 && bytes_written == size ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_DRV_ERR;', 1)
        # New callers must not proceed after a timed-out adapter lock.
        a = source.index('static void _i2s_lock(')
        b = source.index('static void _i2s_unlock(', a)
        source = source[:a] + '''static int _i2s_lock(i2s_data_t *data, const char *func)
{
    (void)func;
    esp_codec_dev_mutex_handle_t mutex = get_mutex(data);
    return mutex ? esp_codec_dev_mutex_lock(mutex, DEFAULT_WAIT_TIMEOUT) : ESP_CODEC_DEV_NO_MEM;
}

''' + source[b:]
    else:
        # Open restores hardware gain/mute too; those failures are initialization
        # failures, not optional settings. Only absent capabilities may be skipped.
        a = source.index('static void _update_codec_setting(')
        b = source.index('esp_codec_dev_handle_t esp_codec_dev_new(', a)
        settings = source[a:b].replace('static void', 'static int', 1)
        settings = settings.replace('    esp_codec_dev_handle_t h', '    int ret;\n    esp_codec_dev_handle_t h')
        for call in ('esp_codec_dev_set_out_vol(h, dev->volume)',
                     'esp_codec_dev_set_out_mute(h, dev->muted)',
                     'esp_codec_dev_set_in_gain(h, dev->mic_gain)',
                     'esp_codec_dev_set_in_mute(h, dev->mic_muted)'):
            settings = settings.replace(f'        {call};', f'''        ret = {call};
        if (ret != ESP_CODEC_DEV_OK && ret != ESP_CODEC_DEV_NOT_SUPPORT) return ret;''')
        settings = settings.replace('\n}\n', '\n    return ESP_CODEC_DEV_OK;\n}\n')
        source = source[:a] + settings + source[b:]
        source = source.replace('    _update_codec_setting(dev);', '''    ret = _update_codec_setting(dev);
    if (ret != ESP_CODEC_DEV_OK) goto open_failed;''')
        source = source.replace('''        codec->mute(codec, mute);
        return ESP_CODEC_DEV_OK;''', '''        return codec->mute(codec, mute);''')
        source = source.replace('''        codec->set_mic_gain(codec, (int) db);
        dev->mic_gain = db;
        return ESP_CODEC_DEV_OK;''', '''        ret = codec->set_mic_gain(codec, (int) db);
        if (ret == ESP_CODEC_DEV_OK) dev->mic_gain = db;
        return ret;''')
        source = source.replace('''        codec->mute_mic(codec, mute);
        dev->mic_muted = mute;
        return ESP_CODEC_DEV_OK;''', '''        ret = codec->mute_mic(codec, mute);
        if (ret == ESP_CODEC_DEV_OK) dev->mic_muted = mute;
        return ret;''')
        source = source.replace('''        codec->set_mic_channel_gain(codec, channel_mask, (int) db);
        return ESP_CODEC_DEV_OK;''', '''        return codec->set_mic_channel_gain(codec, channel_mask, (int) db);''')
        source = source.replace('''        codec->set_vol(codec, db_value);
        return ESP_CODEC_DEV_OK;''', '''        return codec->set_vol(codec, db_value);''')
        source = source.replace('    bool                         disable_when_closed;',
                                '    bool                         disable_when_closed;\n    bool                         cleanup_pending;')
        source = source.replace('''    if (dev->input_opened || dev->output_opened) {''', '''    if (dev->cleanup_pending) {
        int cleanup = esp_codec_dev_close(handle);
        if (cleanup != ESP_CODEC_DEV_OK) return cleanup;
    }
    if (dev->input_opened || dev->output_opened) {''')
        source = source.replace('''    if (dev->output_opened == false && dev->input_opened == false) {''', '''    if (!dev->cleanup_pending && !dev->output_opened && !dev->input_opened) {''')
        source = source.replace('''    const audio_codec_if_t *codec = dev->codec_if;
    if (dev->disable_when_closed && codec) {''', '''    int ret = ESP_CODEC_DEV_OK;
    dev->cleanup_pending = true;
    dev->output_opened = dev->input_opened = false;
    const audio_codec_if_t *codec = dev->codec_if;
    if (dev->disable_when_closed && codec) {''')
        source = source.replace('            codec->enable(codec, false);', '            ret = codec->enable(codec, false);')
        source = source.replace('        data_if->enable(data_if, dev->dev_caps, false);', '''        int data_ret = data_if->enable(data_if, dev->dev_caps, false);
        if (ret == ESP_CODEC_DEV_OK) ret = data_ret;''')
        source = source.replace('''    dev->output_opened = dev->input_opened = false;
    return ESP_CODEC_DEV_OK;''', '''    dev->cleanup_pending = ret != ESP_CODEC_DEV_OK;
    return ret;''')
        source = source.replace('''    if (data_if->set_fmt) {
        data_if->set_fmt(data_if, dev->dev_caps, fs);
    }
    if (data_if->enable) {
        data_if->enable(data_if, dev->dev_caps, true);
    }''', '''    int ret = ESP_CODEC_DEV_OK;
    if (data_if->set_fmt) ret = data_if->set_fmt(data_if, dev->dev_caps, fs);
    if (ret != ESP_CODEC_DEV_OK) goto open_failed;
    if (data_if->enable) ret = data_if->enable(data_if, dev->dev_caps, true);
    if (ret != ESP_CODEC_DEV_OK) goto open_failed;''')
        source = source.replace('''            if (codec->set_fs(codec, fs) != 0) {
                return ESP_CODEC_DEV_NOT_SUPPORT;
            }''', '''            ret = codec->set_fs(codec, fs);
            if (ret != ESP_CODEC_DEV_OK) goto open_failed;''')
        source = source.replace('''            if (codec->enable(codec, true) != ESP_CODEC_DEV_OK) {
                ESP_LOGE(TAG, "Fail to enable codec");
                return ESP_CODEC_DEV_DRV_ERR;
            }''', '''            ret = codec->enable(codec, true);
            if (ret != ESP_CODEC_DEV_OK) goto open_failed;''')
        source = source.replace('''    ESP_LOGI(TAG, "Open codec device OK");
    return ESP_CODEC_DEV_OK;
}''', '''    ESP_LOGI(TAG, "Open codec device OK");
    return ESP_CODEC_DEV_OK;
open_failed:;
    /* Invalidate IO and retain failed cleanup for the next close/open retry. */
    int cleanup = esp_codec_dev_close(handle);
    return cleanup != ESP_CODEC_DEV_OK ? cleanup : ret;
}''')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text(), source.name)
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
