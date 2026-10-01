#pragma once
#include <atomic>
#include <cstring>
#include <new>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <lwip/dns.h>
#include <lwip/tcpip.h>

namespace sentient::cube {
// esp_tls's async connect still calls blocking getaddrinfo. Resolve first on
// lwIP's core, with a bounded wait. A late DNS callback owns its reference;
// at most one abandoned lookup may remain until lwIP's own timeout fires.
struct CubeDnsLookup {
    inline static std::atomic<bool> busy{false};
    std::atomic<unsigned> references{2};
    SemaphoreHandle_t done = nullptr;
    char host[254]{};
    ip_addr_t address{};
    bool valid = false;
    void release() {
        if (references.fetch_sub(1) == 1) {
            vSemaphoreDelete(done);
            delete this;
            busy.store(false);
        }
    }
    static void complete(const char*, const ip_addr_t* address, void* context) {
        auto* self = static_cast<CubeDnsLookup*>(context);
        if (address) { self->address = *address; self->valid = true; }
        xSemaphoreGive(self->done);
        self->release();
    }
};
inline bool cube_resolve(const char* host, int64_t deadline, char* address, size_t size) {
    ip_addr_t literal{};
    if (ipaddr_aton(host, &literal)) return ipaddr_ntoa_r(&literal, address, size) != nullptr;
    if (strlen(host) >= sizeof(CubeDnsLookup::host) || CubeDnsLookup::busy.exchange(true)) return false;
    auto* lookup = new(std::nothrow) CubeDnsLookup;
    if (!lookup) { CubeDnsLookup::busy.store(false); return false; }
    lookup->done = xSemaphoreCreateBinary();
    if (!lookup->done) { delete lookup; CubeDnsLookup::busy.store(false); return false; }
    strcpy(lookup->host, host);
    auto err = tcpip_try_callback([](void* context) {
        auto* self = static_cast<CubeDnsLookup*>(context);
        auto result = dns_gethostbyname(self->host, &self->address, CubeDnsLookup::complete, self);
        if (result != ERR_INPROGRESS)
            CubeDnsLookup::complete(nullptr, result == ERR_OK ? &self->address : nullptr, self);
    }, lookup);
    bool valid = false;
    if (err == ERR_OK) {
        int64_t left = deadline - esp_timer_get_time();
        if (left >= 1000 && xSemaphoreTake(lookup->done, pdMS_TO_TICKS(left / 1000)) == pdTRUE && lookup->valid)
            valid = ipaddr_ntoa_r(&lookup->address, address, size) != nullptr;
    } else lookup->release(); // Callback never accepted ownership.
    lookup->release();
    return valid;
}
} // namespace sentient::cube
