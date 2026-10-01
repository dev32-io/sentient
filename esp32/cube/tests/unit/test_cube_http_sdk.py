"""Real Cube adapter + IDF HTTP parser/client/transport, scripted socket boundary."""
from pathlib import Path
import subprocess
from test_cube_security2_sdk import IDF, ROOT, run, sdk_host_build


def test_actual_http_adapter(tmp_path):
    inc, _ = sdk_host_build(tmp_path)
    (inc / 'freertos').mkdir()
    (inc / 'freertos/FreeRTOS.h').write_text('''#pragma once
#include <stdbool.h>
#define pdMS_TO_TICKS(x) (x)
#define pdTRUE 1
''')
    (inc / 'freertos/task.h').write_text('''#pragma once
extern "C" void vTaskDelay(int);
''')
    (inc / 'freertos/semphr.h').write_text('''#pragma once
extern "C" {
typedef int* SemaphoreHandle_t;
SemaphoreHandle_t xSemaphoreCreateBinary();
void vSemaphoreDelete(SemaphoreHandle_t);
int xSemaphoreTake(SemaphoreHandle_t,int);
int xSemaphoreGive(SemaphoreHandle_t);
}
''')
    (inc / 'lwip').mkdir()
    (inc / 'lwip/dns.h').write_text('''#pragma once
extern "C" {
typedef struct {char text[48];} ip_addr_t;
typedef void (*dns_found_callback)(const char*,const ip_addr_t*,void*);
#define ERR_OK 0
#define ERR_INPROGRESS -5
int ipaddr_aton(const char*,ip_addr_t*);
char* ipaddr_ntoa_r(const ip_addr_t*,char*,int);
int dns_gethostbyname(const char*,ip_addr_t*,dns_found_callback,void*);
}
''')
    (inc / 'lwip/tcpip.h').write_text('''#pragma once
extern "C" int tcpip_try_callback(void(*)(void*),void*);
''')
    (inc / 'esp_heap_caps.h').write_text('''#pragma once
#include <stddef.h>
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_SPIRAM 4
static inline size_t heap_caps_get_free_size(int) { return 16000; }
static inline size_t heap_caps_get_largest_free_block(int) { return 7680; }
''')
    (inc / 'esp_timer.h').write_text('''#pragma once
#include <stdint.h>
extern "C" int64_t esp_timer_get_time(void);
''')
    (inc / 'sdkconfig.h').write_text('''#include <stdio.h>
#define unlikely(x) (x)
#define CONFIG_ESP_HTTP_CLIENT_ENABLE_HTTPS 1
#define CONFIG_ESP_HTTP_CLIENT_ENABLE_CUSTOM_TRANSPORT 1
#define CONFIG_MBEDTLS_CERTIFICATE_BUNDLE 1
#define CONFIG_ESP_HTTP_CLIENT_EVENT_POST_TIMEOUT 0
''')
    (inc / 'esp_assert.h').write_text('#define ESP_STATIC_ASSERT _Static_assert\n')
    (inc / 'esp_tls.h').write_text('''#pragma once
#include "esp_err.h"
typedef struct {int unused;} psk_hint_key_t;
typedef int esp_tls_addr_family_t;
#define ESP_TLS_AF_UNSPEC 0
#define ESP_TLS_AF_INET 1
#define ESP_TLS_AF_INET6 2
typedef int esp_tls_proto_ver_t;
#define ESP_TLS_VER_ANY 0
#define ESP_TLS_VER_TLS_MAX 3
typedef int esp_tls_dyn_buf_strategy_t;
#define ESP_TLS_DYN_BUF_RX_STATIC 1
#define ESP_TLS_DYN_BUF_STRATEGY_MAX 5
typedef int esp_tls_ecdsa_curve_t;
#define ESP_TLS_ECDSA_CURVE_MAX 3
typedef struct esp_tls_last_error {int last_error;} esp_tls_last_error_t;
#define ESP_ERR_ESP_TLS_TCP_CLOSED_FIN 1
#define ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT 2
#define ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST 3
#define ESP_TLS_ERR_TYPE_SYSTEM 0
static inline int esp_tls_get_and_clear_error_type(void*p,int t,int*out){(void)p;(void)t;*out=0;return 0;}
static inline int esp_tls_get_and_clear_last_error(void*p,int*a,int*b){(void)p;if(a)*a=0;if(b)*b=0;return 0;}
''')
    http = IDF / 'components/esp_http_client'
    transport = IDF / 'components/tcp_transport'
    includes = [inc, http / 'include', http / 'lib/include', transport / 'include', transport / 'private_include',
                IDF / 'components/http_parser', ROOT / 'firmware/main/boards/sentient-cube']
    sources = [http / 'esp_http_client.c', http / 'lib/http_header.c', http / 'lib/http_utils.c',
               IDF / 'components/http_parser/http_parser.c', transport / 'transport.c']
    objects = []
    for i, source in enumerate(sources):
        obj = tmp_path / f'http{i}.o'
        run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-include', inc / 'sdkconfig.h',
            *[f'-I{x}' for x in includes], '-c', source, '-o', obj)
        objects.append(obj)
    run('c++', '-std=c++17', '-g', '-fsanitize=address', *[f'-I{x}' for x in includes],
        Path(__file__).parent / 'http_sdk_host.cc', *objects, '-o', tmp_path / 'http')
    run(tmp_path / 'http')
