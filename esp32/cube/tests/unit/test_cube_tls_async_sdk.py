"""Actual SDK TLS/transport polling and error ownership; scripted socket/crypto edge."""
from pathlib import Path
import sys
from test_cube_security2_sdk import IDF, ROOT, run, sdk_host_build


def test_sdk_async_connect_after_poll_timeout(tmp_path):
    inc, mbed = sdk_host_build(tmp_path)
    tls = IDF / 'components/esp-tls'
    transport = IDF / 'components/tcp_transport'
    (inc / 'sdkconfig.h').write_text('''#pragma once
#define CONFIG_IDF_TARGET_LINUX 1
#define CONFIG_ESP_TLS_USING_MBEDTLS 1
''')
    (inc / 'esp_compiler.h').write_text('''#pragma once
#include <stddef.h>
#define ESP_COMPILER_DIAGNOSTIC_PUSH_IGNORE(x)
#define ESP_COMPILER_DIAGNOSTIC_POP(x)
#define __containerof(ptr,type,member) ((type*)((char*)(ptr)-offsetof(type,member)))
''')
    (inc / 'esp_assert.h').write_text('#define ESP_STATIC_ANALYZER_CHECK(a,b) do { if(a) return b; } while(0)\n')
    (inc / 'mbedtls').mkdir()
    (inc / 'mbedtls/esp_debug.h').write_text('#pragma once\n')
    includes = [inc, tls, tls / 'private_include', transport / 'include', transport / 'private_include',
                mbed / 'include', IDF / 'components/http_parser']
    patch = ROOT / 'firmware/scripts/patch_tls_async.py'
    for name, source in [('esp_tls.c', tls / 'esp_tls.c'), ('transport_ssl.c', transport / 'transport_ssl.c')]:
        run(sys.executable, patch, source, tmp_path / name)
    sources = [tmp_path / 'esp_tls.c', tmp_path / 'transport_ssl.c',
               tls / 'esp_tls_error_capture.c', tls / 'esp_tls_platform_port.c',
               transport / 'transport.c', transport / 'transport_internal.c']
    objects = []
    for i, source in enumerate(sources):
        obj = tmp_path / f'tls{i}.o'
        run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-ffunction-sections', '-DESP_PLATFORM',
            '-include', inc / 'sdkconfig.h', '-include', inc / 'esp_log.h', '-include', inc / 'esp_assert.h',
            '-Dselect=test_select', '-Dconnect=test_connect', '-Dgetsockopt=test_getsockopt',
            *[f'-I{x}' for x in includes], '-c', source, '-o', obj)
        objects.append(obj)
    run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-Wl,-dead_strip',
        '-include', inc / 'sdkconfig.h', *[f'-I{x}' for x in includes],
        Path(__file__).with_name('tls_async_sdk_host.c'), *objects, '-o', tmp_path / 'tls')
    run(tmp_path / 'tls')
    # Same executable boundary against unpatched SDK reproduces the stuck poll.
    run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-ffunction-sections', '-DESP_PLATFORM',
        '-include', inc / 'sdkconfig.h', '-include', inc / 'esp_log.h', '-include', inc / 'esp_assert.h',
        '-Dselect=test_select', '-Dconnect=test_connect', '-Dgetsockopt=test_getsockopt',
        *[f'-I{x}' for x in includes], '-c', tls / 'esp_tls.c', '-o', objects[0])
    run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-Wl,-dead_strip',
        '-include', inc / 'sdkconfig.h', *[f'-I{x}' for x in includes],
        Path(__file__).with_name('tls_async_sdk_host.c'), *objects, '-o', tmp_path / 'upstream')
    run(tmp_path / 'upstream', 'upstream')
