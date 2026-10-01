"""Build-local IDF 5.5.2 async TCP polling and TLS error propagation fixes."""
from pathlib import Path
import hashlib
import sys


def patch(source: str, name: str) -> str:
    hashes = {
        'esp_tls.c': 'b8f5a79f0efd0b049e4ae132acbdecf22c6494eff269cb5bc93624a88158f3dc',
        'transport_ssl.c': '7ea28eb0a05f5547794619b7fd48aad03b15bbfd5c6142f32266c892ff59fb0b',
    }
    if hashlib.sha256(source.encode()).hexdigest() != hashes[name]:
        raise ValueError('TLS upstream changed; review Cube async corrections before building')
    if name == 'esp_tls.c':
        # select() mutates both sets, including clearing them on timeout. Restore
        # them on EVERY poll, not only when entering ESP_TLS_CONNECTING.
        source = source.replace('''        if (cfg && cfg->non_block) {
            FD_ZERO(&tls->rset);
            FD_SET(tls->sockfd, &tls->rset);
            tls->wset = tls->rset;
        }
''', '')
        source = source.replace('''            ESP_LOGD(TAG, "connecting...");
            struct timeval tv;''', '''            ESP_LOGD(TAG, "connecting...");
            FD_ZERO(&tls->rset);
            FD_SET(tls->sockfd, &tls->rset);
            tls->wset = tls->rset;
            struct timeval tv;''')
        source = source.replace('''            if (select(tls->sockfd + 1, &tls->rset, &tls->wset, NULL,
                       cfg->timeout_ms>0 ? &tv : NULL) == 0) {''', '''            int ready = select(tls->sockfd + 1, &tls->rset, &tls->wset, NULL,
                               cfg->timeout_ms>0 ? &tv : NULL);
            if (ready < 0) {
                ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_SYSTEM, errno);
                ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_ESP, ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
                tls->conn_state = ESP_TLS_FAIL;
                return -1;
            }
            if (ready == 0) {''')
        source = source.replace('''                    return -1;
                }
            }
        }
        /* By now, the connection has been established */''', '''                    return -1;
                }
                if (error != 0) {
                    ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_SYSTEM, error);
                    ESP_INT_EVENT_TRACKER_CAPTURE(tls->error_handle, ESP_TLS_ERR_TYPE_ESP, ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST);
                    tls->conn_state = ESP_TLS_FAIL;
                    return -1;
                }
            }
        }
        /* By now, the connection has been established */''')
    else:
        source = source.replace('''        if (!ssl->tls) {
            return -1;
        }''', '''        if (!ssl->tls) {
            capture_tcp_transport_error(t, ERR_TCP_TRANSPORT_NO_MEM);
            return -1;
        }''')
        source = source.replace('''        if (progress >= 0) {''', '''        if (progress < 0) {
            esp_tls_error_handle_t error;
            if (esp_tls_get_error_handle(ssl->tls, &error) == ESP_OK) {
                esp_transport_set_errors(t, error);
            }
        }
        if (progress >= 0) {''')
        # Async errors retain the TLS owner until transport close/destroy.
        source = source.replace('''                esp_tls_conn_destroy(ssl->tls);
                return -1;''', '''                capture_tcp_transport_error(t, ERR_TCP_TRANSPORT_CONNECTION_FAILED);
                return -1;''')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text(), source.name)
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
