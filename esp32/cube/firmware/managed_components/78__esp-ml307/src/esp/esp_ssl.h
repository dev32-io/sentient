// =============================================================================
// SENTIENT CUBE — CUSTOMIZED COPY of esp-ml307 EspSsl. Do NOT regenerate via
// idf.py update-dependencies without re-applying the SetCacert override (see
// Phase 5b commit eadf9fe). Tracked in git despite managed_components/ being
// gitignored; see esp32/cube/.gitignore exception.
// =============================================================================
#ifndef _ESP_SSL_H_
#define _ESP_SSL_H_

#include "tcp.h"
#include <esp_tls.h>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>
#include <freertos/task.h>

#define ESP_SSL_EVENT_RECEIVE_TASK_EXIT 1

class EspSsl : public Tcp {
public:
    EspSsl();
    ~EspSsl();

    bool Connect(const std::string& host, int port) override;
    void Disconnect() override;
    int Send(const std::string& data) override;

    int GetLastError() override;

    // Pin a CA cert in PEM form for TLS server validation. Replaces the
    // default `esp_crt_bundle_attach` path when set. Lifetime: the buffer
    // pointer must remain valid for the lifetime of any future Connect()
    // call. Typically the buffer is a `_binary_*_start` symbol from an
    // EMBED_TXTFILES blob (static const storage).
    static void SetCacert(const char* pem_buf, size_t pem_bytes);

private:
    esp_tls_t* tls_client_ = nullptr;
    EventGroupHandle_t event_group_ = nullptr;
    TaskHandle_t receive_task_handle_ = nullptr;
    int last_error_ = 0;

    static const char* s_cacert_pem_buf_;
    static size_t s_cacert_pem_bytes_;

    void ReceiveTask();
};

#endif // _ESP_SSL_H_