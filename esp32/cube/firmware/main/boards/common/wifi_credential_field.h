#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

// ESP-IDF Wi-Fi fields may occupy the entire array (32-byte SSID / 64-byte PSK).
// Never append a terminator beyond the field; consumers must use bounded lengths.
template <size_t N>
bool copy_wifi_credential_field(uint8_t (&dst)[N], const uint8_t* src, int length) {
    if (length < 0 || static_cast<size_t>(length) > N || (length && !src)) return false;
    std::memset(dst, 0, N);
    if (length) std::memcpy(dst, src, static_cast<size_t>(length));
    return true;
}
