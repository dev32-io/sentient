"""Exercise CMake trust selection and actual HTTP/WSS configuration consumers.
Only disposable trust fixtures; never read operator certificates or headers.
"""
from pathlib import Path
import subprocess
import pytest

MAIN = Path(__file__).resolve().parents[2] / 'firmware/main'


@pytest.mark.parametrize('prod,present', [(False, False), (False, True), (True, False), (True, True)])
def test_profile_trust_reaches_both_consumers(tmp_path, prod, present):
    cmake = (MAIN / 'CMakeLists.txt').read_text()
    start = cmake.index('set(SENTIENT_EMBED_TXTFILES "")')
    gate = cmake[start:cmake.index("\nendif()", start) + len("\nendif()")]
    if present:
        (tmp_path / 'sentient_dev_gateway.crt').write_text('disposable trust fixture')
    script = tmp_path / 'trust.cmake'
    script.write_text(f'''set(CONFIG_BOARD_TYPE_SENTIENT_CUBE ON)
set(CONFIG_SENTIENT_PROD_BUILD {'ON' if prod else 'OFF'})
{gate}
file(WRITE "${{CMAKE_CURRENT_LIST_DIR}}/selected" "${{SENTIENT_DEV_TLS_CERT}};${{SENTIENT_EMBED_TXTFILES}}")
''')
    subprocess.run(['cmake', '-P', str(script)], check=True)
    selected, embedded = (tmp_path / 'selected').read_text().split(';')
    enabled = present and not prod
    assert selected == str(int(enabled))
    assert embedded == ('sentient_dev_gateway.crt' if enabled else '')

    # Execute production configuration statements, rather than duplicate their
    # preprocessor guards in the test. Adapter/SDK checks cover transport below.
    app = (MAIN / 'application.cc').read_text()
    start = app.index('    SentientWsProtocolConfig cfg;')
    ws = app[start:app.index('    WireSentientWsCallbacks(cfg);', start)]
    hardware = (MAIN / 'boards/sentient-cube/cube_hardware.cc').read_text()
    start = hardware.index('    esp_http_client_config_t config{};')
    http = hardware[start:hardware.index('    return cube_http_post(config, payload);', start)]
    source = tmp_path / 'trust.cc'
    source.write_text(r'''
#include <cassert>
#include <string>
int esp_crt_bundle_attach(void*) { return 0; }
struct SentientWsProtocolConfig {
    std::string gateway_url, token, device_id;
    const char* cert_pem = nullptr;
};
struct esp_http_client_config_t {
    const char* url = nullptr;
    const char* cert_pem = nullptr;
    int (*crt_bundle_attach)(void*) = nullptr;
};
extern "C" const char fixture[] asm("_binary_sentient_dev_gateway_crt_start") = "disposable trust fixture";
int main() {
    struct { std::string url, token, device_id; int revision; }
        credentials{"wss://disposable.test/ws", "disposable", "fixture-id", 7};
    int cube_token_revision_ = 0;
''' + ws + r'''
    std::string url = "https://disposable.test/api/v1/devices/redeem";
''' + http + f'''
    assert(cfg.cert_pem == {'fixture' if enabled else 'nullptr'});
    assert(config.cert_pem == {'fixture' if enabled else 'nullptr'});
    assert(config.crt_bundle_attach == {'nullptr' if enabled else 'esp_crt_bundle_attach'});
    assert(cfg.gateway_url == credentials.url && cfg.token == credentials.token);
    assert(cfg.device_id == credentials.device_id && cube_token_revision_ == 7);
    assert(config.url == url.c_str());
}}
''')
    binary = tmp_path / 'trust'
    subprocess.run(['c++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    f'-DCONFIG_SENTIENT_PROD_BUILD={int(prod)}',
                    f'-DSENTIENT_DEV_TLS_CERT={selected}', str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
