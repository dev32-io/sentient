#pragma once
#include <cstddef>
#include <cstdint>

namespace sentient::cube {
// Only fixed labels and numeric metadata. Never copy request/response strings.
struct CubeHttpDiagnostics {
    const char* phase = "idle";
    int http_status = 0;
    int error_code = 0; // SDK operation/transport return.
    bool timed_out = false; // Keep phase: DNS, TLS connect, headers or body.
    int tls_error = 0, tls_code = 0, tls_flags = 0, socket_errno = 0;
    size_t sent_bytes = 0, received_bytes = 0, body_bytes = 0;
    uint32_t elapsed_ms = 0;
    // At request start, replaced on failure before TLS/client cleanup.
    size_t internal_free_bytes = 0, internal_largest_bytes = 0, psram_free_bytes = 0;
};
}
