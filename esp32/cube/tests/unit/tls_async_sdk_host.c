// Full SDK esp_tls.c + transport_ssl.c + error tracking execute here.
// No gateway/device connection: socket connect/select and crypto boundary scripted.
#include <assert.h>
#include <errno.h>
#include <string.h>
#include "esp_tls.h"
#include "esp_tls_private.h"
#include "esp_tls_error_capture_internal.h"
#include "esp_transport.h"
#include "esp_transport_ssl.h"

static int polls, socket_error, select_error, create_error, handshake_error, creates, deletes;
int test_connect(int fd, const struct sockaddr *address, socklen_t length) {
    (void)fd; (void)address; (void)length;
    errno = EINPROGRESS;
    return -1;
}
int test_select(int n, fd_set *r, fd_set *w, fd_set *e, struct timeval *timeout) {
    (void)e;
    assert(timeout && timeout->tv_sec == 0 && timeout->tv_usec == 1000);
    ++polls;
    if (select_error) { errno = select_error; return -1; }
    // POSIX timeout clears both sets. Only a re-armed socket can become ready.
    int armed = FD_ISSET(n - 1, r) && FD_ISSET(n - 1, w);
    if (polls <= 3 || !armed) { FD_ZERO(r); FD_ZERO(w); return 0; }
    return 1;
}
int test_getsockopt(int fd, int level, int opt, void *value, socklen_t *length) {
    (void)fd;
    assert(level == SOL_SOCKET && opt == SO_ERROR && *length == sizeof(int));
    *(int *)value = socket_error;
    return 0;
}
esp_err_t esp_create_mbedtls_handle(const char *host, size_t len, const void *config, esp_tls_t *tls, void *server) {
    (void)host; (void)len; (void)config; (void)server;
    ++creates;
    if (create_error) {
        ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_MBEDTLS, MBEDTLS_ERR_SSL_ALLOC_FAILED);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
int esp_mbedtls_handshake(esp_tls_t *tls, const esp_tls_cfg_t *cfg) {
    (void)cfg;
    if (handshake_error) {
        ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_ESP, ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED);
        ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_MBEDTLS, MBEDTLS_ERR_X509_CERT_VERIFY_FAILED);
        ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_MBEDTLS_CERT_FLAGS, MBEDTLS_X509_BADCERT_EXPIRED);
        return -1;
    }
    return 1;
}
void esp_mbedtls_conn_delete(esp_tls_t *tls) { assert(tls); ++deletes; }
ssize_t esp_mbedtls_read(esp_tls_t *tls, char *data, size_t size) { (void)tls;(void)data;(void)size;return -1; }
ssize_t esp_mbedtls_write(esp_tls_t *tls, const char *data, size_t size) { (void)tls;(void)data;return size; }
ssize_t esp_mbedtls_get_bytes_avail(esp_tls_t *tls) { (void)tls;return 0; }
// SDK inline net initialization needs no crypto for this transport-state test.
void mbedtls_net_init(mbedtls_net_context *ctx) { ctx->fd = -1; }

int main(int argc, char **argv) {
    (void)argv;
    for (int mode = 0; mode < 5; ++mode) {
        polls = creates = deletes = 0;
        socket_error = mode == 1 ? ECONNREFUSED : 0;
        select_error = mode == 2 ? EBADF : 0;
        create_error = mode == 3;
        handshake_error = mode == 4;
        esp_transport_handle_t transport = esp_transport_ssl_init();
        assert(transport);
        int result = 0;
        for (int i = 0; i < 20 && result == 0; ++i)
            result = esp_transport_connect_async(transport, "127.0.0.1", 443, 1);
        if (argc > 1) {
            assert(mode == 0 && result == 0 && polls == 20 && creates == 0);
            esp_transport_destroy(transport);
            assert(deletes == 1);
            return 0;
        }
        assert(result == (mode == 0 ? 1 : -1));
        assert(polls == (select_error ? 1 : 4));
        assert(creates == (socket_error || select_error ? 0 : 1));
        int stack = 0, flags = 0;
        int error = esp_tls_get_and_clear_last_error(esp_transport_get_error_handle(transport), &stack, &flags);
        if (mode == 0) assert(!error && !stack && !flags);
        if (mode == 1 || mode == 2) {
            assert(error == ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
            assert(esp_transport_get_errno(transport) == (socket_error ? socket_error : select_error));
        }
        if (mode == 3) assert(error == ESP_ERR_NO_MEM && stack == MBEDTLS_ERR_SSL_ALLOC_FAILED);
        if (mode == 4) assert(error == ESP_ERR_MBEDTLS_SSL_HANDSHAKE_FAILED &&
                             stack == MBEDTLS_ERR_X509_CERT_VERIFY_FAILED && flags == MBEDTLS_X509_BADCERT_EXPIRED);
        esp_transport_close(transport);
        esp_transport_destroy(transport);
        assert(deletes == 1);
    }
}
