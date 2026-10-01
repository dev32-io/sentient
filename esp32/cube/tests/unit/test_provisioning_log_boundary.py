"""Provisioning diagnostics must not disclose local network credentials."""
from pathlib import Path
import re
import subprocess


def test_blufi_diagnostics_do_not_log_network_credentials():
    source = (Path(__file__).resolve().parents[2] /
              "firmware/main/boards/common/blufi.cpp").read_text()
    calls = re.findall(r"ESP_LOG\w+\s*\(.*?\);", source, re.DOTALL)
    for call in calls:
        assert not re.search(r"password|passwd|psk|sta_ssid|ap\.ssid|sta\.ssid", call,
                             re.IGNORECASE), "Provisioning log exposes network credentials"


def test_full_length_wifi_fields_remain_bounded(tmp_path):
    include = Path(__file__).resolve().parents[2] / "firmware/main/boards/common"
    source = tmp_path / "check.cc"
    source.write_text('''
#include "wifi_credential_field.h"
#include <cassert>
int main() {
    struct { uint8_t ssid[32]; uint8_t password[64]; uint8_t guard; } value{};
    uint8_t input[65]; memset(input, 'x', sizeof(input));
    value.guard = 0xab;
    assert(copy_wifi_credential_field(value.ssid, input, 32));
    assert(strnlen(reinterpret_cast<char*>(value.ssid), 32) == 32);
    assert(value.password[0] == 0);
    assert(copy_wifi_credential_field(value.password, input, 64));
    assert(strnlen(reinterpret_cast<char*>(value.password), 64) == 64);
    assert(value.guard == 0xab);
    assert(!copy_wifi_credential_field(value.ssid, input, 33));
    assert(!copy_wifi_credential_field(value.password, input, 65));
    assert(!copy_wifi_credential_field(value.password, input, -1));
    assert(!copy_wifi_credential_field(value.password, nullptr, 1));
    assert(value.password[0] == 'x');
    assert(copy_wifi_credential_field(value.password, input, 8));
    assert(value.password[8] == 0 && value.password[63] == 0);
    assert(copy_wifi_credential_field(value.password, nullptr, 0));
    assert(value.password[0] == 0);
}
''')
    binary = tmp_path / "check"
    subprocess.run(["c++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                    "-I", str(include), str(source), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
