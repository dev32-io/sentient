"""Compile actual build-local Security2/SRP + SDK protobuf/mbedTLS under ASan.
Python supplies independent native-compatible SRP arithmetic, never firmware crypto.
Requires local ESP-IDF 5.5.2 and host clang/cmake; no device or network.
"""
from pathlib import Path
import hashlib
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
IDF = Path(os.environ.get('IDF_PATH', Path.home() / 'esp/esp-idf'))


def run(*args, **kwargs):
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def sdk_host_build(tmp):
    """Shared with HTTP SDK adapter check. Only platform services are stubbed."""
    inc = tmp / 'include'
    inc.mkdir()
    (inc / 'esp_err.h').write_text('''#pragma once
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_INVALID_SIZE 0x104
#define ESP_ERR_NOT_FOUND 0x105
#define ESP_ERR_NOT_SUPPORTED 0x106
#define ESP_ERR_TIMEOUT 0x107
#define ESP_ERR_INVALID_RESPONSE 0x108
#define ESP_ERR_INVALID_CRC 0x109
static inline const char* esp_err_to_name(int e) { (void)e; return "host-error"; }
''')
    (inc / 'esp_log.h').write_text('''#pragma once
#include <assert.h>
#include <stdlib.h>
#define static_assert _Static_assert
#define ESP_LOGE(...)
#define ESP_LOGW(...)
#define ESP_LOGI(...)
#define ESP_LOGD(...)
#define ESP_LOGV(...)
#define ESP_LOG_LEVEL(...)
#define ESP_LOG_BUFFER_HEX_LEVEL(...)
#define ESP_LOG_WARN 2
#define ESP_LOG_DEBUG 4
typedef int esp_log_level_t;
''')
    (inc / 'esp_event.h').write_text('''#pragma once
#include "esp_err.h"
#define ESP_EVENT_DECLARE_BASE(n) extern const char* n
#define ESP_EVENT_DEFINE_BASE(n) const char* n = #n
#define portMAX_DELAY 0
static inline int esp_event_post(const char* b,int id,const void* d,size_t n,int t) {
(void)b;(void)id;(void)d;(void)n;(void)t;return 0;
}
''')
    (inc / 'esp_check.h').write_text('''#pragma once
#include "esp_err.h"
#define ESP_RETURN_ON_FALSE(a,b,...) do { if (!(a)) return (b); } while(0)
#define ESP_GOTO_ON_FALSE(a,b,label,...) do { if (!(a)) {ret=(b);goto label;} } while(0)
#define ESP_GOTO_ON_ERROR(a,label,...) do {ret=(a); if(ret) goto label;} while(0)
''')
    (inc / 'esp_random.h').write_text('''#pragma once
#include <stdlib.h>
#include <stdint.h>
static inline void esp_fill_random(void* p,size_t n) { arc4random_buf(p,n); }
static inline uint32_t esp_random(void) { return arc4random(); }
''')
    (inc / 'endian.h').write_text('''#pragma once
#include <libkern/OSByteOrder.h>
#define htobe32(x) OSSwapHostToBigInt32(x)
#define be32toh(x) OSSwapBigToHostInt32(x)
''')
    (inc / 'alloc.h').write_text('''#pragma once
#include <stdlib.h>
#include <time.h>
time_t test_time(time_t*);
#define MBEDTLS_PLATFORM_TIME_MACRO test_time
void* test_malloc(size_t);
void* test_calloc(size_t,size_t);
void* test_realloc(void*,size_t);
void test_free(void*);
#define malloc test_malloc
#define calloc test_calloc
#define realloc test_realloc
#define free test_free
''')
    (tmp / 'alloc.c').write_text('''#include <stdlib.h>
#include <assert.h>
#include <time.h>
static time_t shift;
void test_time_shift(time_t n) {shift=n;}
time_t test_time(time_t* out) {time_t n=time(NULL)+shift;if(out)*out=n;return n;}
static long live, fail=-1, calls;
void test_fail(long n) {fail=n;calls=0;}
long test_live(void) {return live;}
long test_calls(void) {return calls;}
static int denied(void) {return calls++ == fail;}
void* test_malloc(size_t n) {if(denied())return NULL;void*p=malloc(n?n:1);if(p)++live;return p;}
void* test_calloc(size_t n,size_t s) {if(denied())return NULL;void*p=calloc(n?n:1,s?s:1);if(p)++live;return p;}
void* test_realloc(void*p,size_t n) {if(denied())return NULL;void*q=realloc(p,n?n:1);if(q&&!p)++live;return q;}
void test_free(void*p) {if(p){assert(live>0);--live;free(p);}}
''')
    mbed = IDF / 'components/mbedtls/mbedtls'
    flags = f'-fsanitize=address -fno-omit-frame-pointer -include {inc}/alloc.h'
    run('cmake', '-S', mbed, '-B', tmp / 'mbed', '-DENABLE_PROGRAMS=OFF', '-DENABLE_TESTING=OFF',
        f'-DCMAKE_C_FLAGS={flags}', stdout=subprocess.DEVNULL)
    run('cmake', '--build', tmp / 'mbed', '-j8', stdout=subprocess.DEVNULL)
    return inc, mbed


def test_actual_security2_sdk(tmp_path):
    inc, mbed = sdk_host_build(tmp_path)
    proto = IDF / 'components/protocomm'
    scripts = ROOT / 'firmware/scripts'
    for name, source in [('security2', 'security/security2.c'),
                         ('srp_security', 'crypto/srp6a/esp_srp.c'),
                         ('srp_mpi', 'crypto/srp6a/esp_srp_mpi.c')]:
        run(sys.executable, scripts / f'patch_{name}.py', proto / f'src/{source}', tmp_path / f'{name}.c')
    # SDK group bytes; independent client arithmetic and minimal-width encoding.
    original = (proto / 'src/crypto/srp6a/esp_srp.c').read_text()
    group = original.split('static const char N_3072[] = {')[1].split('};')[0]
    import re
    Nbytes = bytes(int(x, 16) for x in re.findall(r'0x([0-9A-Fa-f]{2})', group))
    N = int.from_bytes(Nbytes, 'big')
    def H(*xs): return hashlib.sha512(b''.join(xs)).digest()
    def minimal(n): return n.to_bytes((n.bit_length()+7)//8, 'big')
    salt = bytes(range(32))  # Leading zero salt retained in proof.
    user, password = b'cube', b'disposable-host-test'
    x = int.from_bytes(H(salt, H(user, b':', password)), 'big')
    v = pow(5, x, N)
    # Fixed vectors include ordinary 384 and native 383-byte public keys.
    exponents = []
    for a in range(1, 3000):
        exponent = int.from_bytes(H(str(a).encode())[:32], 'big')
        A = minimal(pow(5, exponent, N))
        if len(A) == 384 and not exponents: exponents.append(exponent)
        if len(A) == 383:
            exponents.append(exponent)
            break
    assert len(exponents) == 2
    exponents.append(1)  # Smallest valid minimal encoding A=5, proof still unpadded.
    # Generate client proof at runtime from server B via a small subprocess
    # protocol: C harness writes B to stdout; Python returns M/HAMK/K on stdin.
    vectors = '\n'.join(','.join(str(b) for b in minimal(pow(5, a, N))) for a in exponents)
    arrays = '\n'.join(f'unsigned char A{i}[]={{ {line} }};' for i,line in enumerate(vectors.splitlines()))
    data = f'''unsigned char salt[]={{ {','.join(map(str,salt))} }};
unsigned char verifier[]={{ {','.join(map(str,minimal(v)))} }};
unsigned char modulus[]={{ {','.join(map(str,Nbytes))} }};
{arrays}
'''
    harness = (Path(__file__).parent / 'security2_sdk_host.c').read_text()
    (tmp_path / 'harness.c').write_text(data + harness)
    includes = [inc, mbed / 'include', proto / 'include/security', proto / 'include/crypto/srp6a',
                proto / 'src/crypto/srp6a', proto / 'proto-c', IDF / 'components/protobuf-c/protobuf-c']
    sources = [tmp_path / f'{n}.c' for n in ['security2', 'srp_security', 'srp_mpi', 'harness']]
    sources += list((proto / 'proto-c').glob('*.pb-c.c'))
    sources += [IDF / 'components/protobuf-c/protobuf-c/protobuf-c/protobuf-c.c']
    objects = []
    for i, source in enumerate(sources):
        obj = tmp_path / f'{i}.o'
        rng_hooks = ['-Dmbedtls_ctr_drbg_seed=test_seed', '-Dmbedtls_ctr_drbg_random=test_random'] if source.name == 'security2.c' else []
        run('cc', '-std=gnu11', '-g', '-fsanitize=address', '-fno-omit-frame-pointer',
            '-DCONFIG_ESP_PROTOCOMM_SUPPORT_SECURITY_VERSION_2=1', *rng_hooks, '-include', inc / 'alloc.h',
            *[f'-I{x}' for x in includes], '-c', source, '-o', obj)
        objects.append(obj)
    run('cc', '-g', '-fsanitize=address', tmp_path / 'alloc.c', *objects,
        tmp_path / 'mbed/library/libmbedcrypto.a', '-o', tmp_path / 'security')
    process = subprocess.Popen([str(tmp_path / 'security')], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               text=True)
    k = int.from_bytes(H(Nbytes, (5).to_bytes(384, 'big')), 'big')
    for line in process.stdout:
        if line.startswith('mbedtls_mpi_'): continue  # SDK sanitized allocation-failure diagnostic.
        parts = line.split()
        assert parts[0] == 'B', line
        index, Bhex = int(parts[1]), parts[2]
        Braw = bytes.fromhex(Bhex)
        B = int.from_bytes(Braw, 'big')
        a = exponents[index]
        Araw = minimal(pow(5, a, N))
        u = int.from_bytes(H(Araw.rjust(384,b'\0'), Braw.rjust(384,b'\0')), 'big')
        S = pow((B-k*v) % N, a+u*x, N)
        K = H(minimal(S))
        M = H(bytes(a^b for a,b in zip(H(Nbytes), H((5).to_bytes(384,'big')))), H(user), salt, Araw, Braw, K)
        HAMK = H(Araw, M, K)
        process.stdin.write((M+HAMK+K).hex()+'\n')
        process.stdin.flush()
    assert process.wait() == 0
