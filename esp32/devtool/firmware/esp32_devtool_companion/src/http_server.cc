#include "http_server.h"
#include "esp32_devtool/endpoints.h"

#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <lwip/sockets.h>
#include <cerrno>
#include <cstring>

static const char* TAG = "sentient.cube.devtool.http";
static httpd_handle_t s_server = nullptr;

// Big chunked bodies (>5 KB) regularly hit EAGAIN on the cube — lwIP's TCP send
// queue / pbuf pool fills before the peer ACKs. esp_http_server's default send
// gives up immediately on -1. We override per-session with a select()-backed
// retry loop so /audio/record and /screenshot can drain hundreds of KB.
static constexpr int kSendRetryWindowMs = 30 * 1000;
static constexpr int kSelectSliceMs = 100;
static constexpr int kHttpdSockTimeoutSec = 30;

static int devtool_send_with_retry(httpd_handle_t /*hd*/, int sockfd,
                                   const char* buf, size_t buf_len, int flags) {
    const int64_t deadline_us =
        esp_timer_get_time() + static_cast<int64_t>(kSendRetryWindowMs) * 1000;
    while (true) {
        const int n = send(sockfd, buf, buf_len, flags);
        if (n >= 0) return n;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return HTTPD_SOCK_ERR_FAIL;
        if (esp_timer_get_time() >= deadline_us) {
            ESP_LOGW(TAG, "send_retry: hard timeout after %d ms (fd=%d len=%u)",
                     kSendRetryWindowMs, sockfd, (unsigned)buf_len);
            errno = ETIMEDOUT;
            return HTTPD_SOCK_ERR_TIMEOUT;
        }
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(sockfd, &wfds);
        struct timeval tv = {0, kSelectSliceMs * 1000};
        const int sr = select(sockfd + 1, nullptr, &wfds, nullptr, &tv);
        if (sr < 0 && errno != EINTR) return HTTPD_SOCK_ERR_FAIL;
    }
}

static esp_err_t devtool_session_open(httpd_handle_t hd, int sockfd) {
    return httpd_sess_set_send_override(hd, sockfd, devtool_send_with_retry);
}

struct Reg { const char* method; const char* path; devtool_http_handler_t fn; };
static constexpr size_t kMaxReg = 32;
static Reg s_regs[kMaxReg];
static size_t s_reg_count = 0;

extern "C" void devtool_register_http(const char* method, const char* path,
                                       devtool_http_handler_t fn) {
    if (s_reg_count >= kMaxReg) return;
    s_regs[s_reg_count++] = {method, path, fn};
}

extern "C" void devtool_http_server_start(int port) {
    if (s_server != nullptr) return;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = port;
    cfg.lru_purge_enable = true;
    cfg.max_uri_handlers = kMaxReg;
    // Default 4 KB stack is insufficient for /screenshot: lv_snapshot_take
    // drives LVGL rendering internals that need ~8-12 KB of stack. 16 KB
    // gives comfortable headroom for current + future heavy handlers.
    cfg.stack_size = 16384;
    // Symmetric 30 s socket timeout. Default 5 s aborts during multi-chunk
    // sends when lwIP's pbuf pool back-pressures; pairs with the send override.
    cfg.send_wait_timeout = kHttpdSockTimeoutSec;
    cfg.recv_wait_timeout = kHttpdSockTimeoutSec;
    // open_fn fires after accept(), before any handler — perfect place to
    // install the per-session send override.
    cfg.open_fn = devtool_session_open;
    if (httpd_start(&s_server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        s_server = nullptr;
        return;
    }
    for (size_t i = 0; i < s_reg_count; ++i) {
        httpd_method_t m = HTTP_GET;
        if (std::strcmp(s_regs[i].method, "POST") == 0) m = HTTP_POST;
        httpd_uri_t u = {.uri = s_regs[i].path, .method = m,
                         .handler = s_regs[i].fn, .user_ctx = nullptr};
        httpd_register_uri_handler(s_server, &u);
    }
    ESP_LOGI(TAG, "http up on :%d with %u handlers", port,
             (unsigned)s_reg_count);
}

extern "C" void devtool_http_server_stop(void) {
    if (s_server != nullptr) {
        httpd_stop(s_server);
        s_server = nullptr;
    }
}
