#pragma once
#include "cube_dns.h"
#include "cube_http_diagnostics.h"
#include <esp_heap_caps.h>
#include <algorithm>
#include <cstring>
#include <string>
#include <esp_http_client.h>
#include <esp_timer.h>
#include <esp_transport.h>
#include <esp_transport_ssl.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace sentient::cube {
struct HttpResult {
    std::string body;
    int status = 0;
    unsigned retry_after = 0;
    bool overflow = false;
    CubeHttpDiagnostics diagnostic;
};

// Decimal delta-seconds only; saturate while parsing, including huge values.
inline unsigned cube_retry_after(const char* value) {
    if (!value || !*value) return 0;
    unsigned n = 0;
    for (; *value; ++value) {
        if (*value < '0' || *value > '9') return 0;
        n = std::min(300u, n * 10 + unsigned(*value - '0'));
    }
    return std::max(1u, n);
}

// Guard at the transport boundary: IDF read/fetch_headers have internal loops.
// Nonblocking TLS prevents a partial TLS record from blocking after socket poll.
// No timer task closes a client concurrently with its owner.
class CubeHttpTransport {
public:
    esp_transport_handle_t tls = nullptr;
    esp_transport_handle_t bounded = nullptr;
    int64_t deadline = esp_timer_get_time() + 20000000;
    bool stopped = false;
    CubeHttpDiagnostics& diagnostic;

    explicit CubeHttpTransport(CubeHttpDiagnostics& value) : diagnostic(value) {
        diagnostic.phase = "init";
        sample_heap();
        tls = esp_transport_ssl_init();
        bounded = esp_transport_init();
        if (!tls || !bounded) return;
        esp_transport_set_context_data(bounded, this);
        esp_transport_set_default_port(bounded, 443);
        esp_transport_set_func(bounded,
            [](auto t, const char* host, int port, int timeout) {
                auto& self = get(t);
                self.diagnostic.phase = "dns";
                char address[48];
                if (!cube_resolve(host, self.deadline, address, sizeof(address))) {
                    if (self.remaining(timeout)) self.failed(-1);
                    return -1;
                }
                self.diagnostic.phase = "tls-connect";
                esp_transport_ssl_set_common_name(self.tls, host); // Original hostname/SNI, not resolved IP.
                while (self.remaining(timeout)) {
                    // SDK retains the first async timeout for later select calls.
                    int ret = esp_transport_connect_async(self.tls, address, port, 1);
                    if (ret != 0) {
                        if (ret < 0) self.failed(ret);
                        return ret == 1 ? 0 : -1;
                    }
                    vTaskDelay(pdMS_TO_TICKS(1));
                }
                return -1;
            },
            [](auto t, char* data, int size, int timeout) {
                auto& self = get(t);
                while (int left = self.remaining(timeout)) {
                    int ret = esp_transport_read(self.tls, data, size, left);
                    // SDK maps nonblocking TLS WANT_READ (partial record) to 0.
                    // Keep the same absolute deadline, never restart the request.
                    if (ret == ERR_TCP_TRANSPORT_CONNECTION_TIMEOUT) {
                        if (self.remaining()) vTaskDelay(pdMS_TO_TICKS(1));
                        continue;
                    }
                    if (ret > 0) self.diagnostic.received_bytes += ret;
                    else self.failed(ret);
                    return ret;
                }
                return -1;
            },
            [](auto t, const char* data, int size, int timeout) {
                auto& self = get(t);
                int left = self.remaining(timeout);
                int ret = left ? esp_transport_write(self.tls, data, size, left) : -1;
                if (ret > 0) self.diagnostic.sent_bytes += ret;
                else self.failed(ret);
                return ret;
            },
            [](auto t) { return esp_transport_close(get(t).tls); },
            nullptr, nullptr, nullptr);
    }
    ~CubeHttpTransport() {
        if (bounded) esp_transport_destroy(bounded);
        if (tls) esp_transport_destroy(tls);
    }
    int remaining(int timeout = 10000) {
        int64_t us = deadline - esp_timer_get_time();
        if (stopped) return 0;
        if (us < 1000) { diagnostic.timed_out = true; failed(ESP_ERR_TIMEOUT); return 0; }
        return static_cast<int>(std::min<int64_t>(timeout, us / 1000));
    }
    void sample_heap() {
        diagnostic.internal_free_bytes = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        diagnostic.internal_largest_bytes = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        diagnostic.psram_free_bytes = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    }
    void failed(int code) {
        diagnostic.error_code = diagnostic.timed_out ? ESP_ERR_TIMEOUT : code;
        if (tls) {
            int stack_code = 0, flags = 0;
            auto error = esp_tls_get_and_clear_last_error(esp_transport_get_error_handle(tls), &stack_code, &flags);
            if (error) diagnostic.tls_error = error;
            if (stack_code) diagnostic.tls_code = stack_code;
            if (flags) diagnostic.tls_flags = flags;
            int socket_error = esp_transport_get_errno(tls);
            if (socket_error > 0) diagnostic.socket_errno = socket_error;
        }
        sample_heap();
    }
private:
    static CubeHttpTransport& get(esp_transport_handle_t t) {
        return *static_cast<CubeHttpTransport*>(esp_transport_get_context_data(t));
    }
};

inline HttpResult cube_http_post(esp_http_client_config_t config, const std::string& payload) {
    HttpResult result;
    const int64_t started = esp_timer_get_time();
    auto finish = [&]() {
        result.diagnostic.elapsed_ms = (esp_timer_get_time() - started) / 1000;
        result.diagnostic.body_bytes = result.body.size();
    };
    CubeHttpTransport transport(result.diagnostic);
    if (!transport.tls || !transport.bounded || payload.empty()) {
        transport.failed(payload.empty() ? ESP_ERR_INVALID_ARG : ESP_ERR_NO_MEM);
        finish();
        return result;
    }
    // Custom transports own their TLS configuration; IDF's default SSL handle
    // is unused. Hostname verification remains enabled (SDK default).
    if (config.cert_pem) esp_transport_ssl_set_cert_data(transport.tls, config.cert_pem, strlen(config.cert_pem));
    else if (config.crt_bundle_attach) esp_transport_ssl_crt_bundle_attach(transport.tls, config.crt_bundle_attach);
    else { transport.failed(ESP_ERR_INVALID_ARG); finish(); return result; } // Never open an unverified connection.
    struct Events { HttpResult& result; CubeHttpTransport& transport; size_t received = 0; } events{result, transport};
    config.method = HTTP_METHOD_POST;
    config.timeout_ms = 10000;
    config.is_async = false; // Wrapper establishes nonblocking TLS, HTTP uses streaming API.
    config.disable_auto_redirect = true;
    config.buffer_size = 512;
    config.transport = transport.bounded;
    config.user_data = &events;
    config.event_handler = [](esp_http_client_event_t* event) -> esp_err_t {
        auto& state = *static_cast<Events*>(event->user_data);
        if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
            state.received += event->data_len;
            if (state.received > 4096) {
                state.result.overflow = true;
                state.transport.stopped = true;
            }
        } else if (event->event_id == HTTP_EVENT_ON_HEADER && event->header_key && event->header_value &&
                   !strcasecmp(event->header_key, "Retry-After")) {
            state.result.retry_after = cube_retry_after(event->header_value);
        }
        return ESP_OK; // IDF ignores event errors; transport enforces stop.
    };
    auto client = esp_http_client_init(&config);
    if (!client) { transport.failed(ESP_ERR_NO_MEM); finish(); return result; }
    int code = esp_http_client_set_header(client, "Content-Type", "application/json");
    if (code == ESP_OK) code = esp_http_client_open(client, payload.size());
    bool ok = code == ESP_OK;
    if (!ok && !result.diagnostic.error_code) transport.failed(code);
    if (ok) {
        result.diagnostic.phase = "write";
        code = esp_http_client_write(client, payload.data(), payload.size());
        ok = code == static_cast<int>(payload.size());
        if (!ok && !result.diagnostic.error_code) transport.failed(code);
    }
    if (ok) {
        result.diagnostic.phase = "headers";
        int64_t length = esp_http_client_fetch_headers(client);
        result.diagnostic.http_status = esp_http_client_get_status_code(client);
        if (length > 4096) result.overflow = true;
        ok = length >= 0 && !result.overflow;
        if (length < 0 && !result.diagnostic.error_code) transport.failed(length);
    }
    if (ok) result.diagnostic.phase = "body";
    char chunk[512];
    // Headers may cache body bytes and mark the parser complete before read.
    while (ok && transport.remaining() &&
           (!esp_http_client_is_complete_data_received(client) || result.body.size() < events.received)) {
        int count = esp_http_client_read(client, chunk, sizeof(chunk));
        if (count == 0 && esp_http_client_is_complete_data_received(client)) break;
        if (count <= 0 || result.overflow || result.body.size() + count > 4096) { ok = false; break; }
        result.body.append(chunk, count);
    }
    if (ok && transport.remaining() && !result.overflow && esp_http_client_is_complete_data_received(client))
        result.status = esp_http_client_get_status_code(client);
    if (result.status) result.diagnostic.phase = "complete";
    else if (result.overflow) {
        result.diagnostic.phase = "overflow";
        transport.failed(ESP_ERR_INVALID_SIZE);
    } else if (!result.diagnostic.error_code) transport.failed(ESP_FAIL);
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    finish();
    return result;
}
} // namespace sentient::cube
