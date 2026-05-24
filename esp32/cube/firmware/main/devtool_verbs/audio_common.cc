// SPDX-License-Identifier: MIT
// devtool_verbs/audio_common.cc — impls for the shared chunked-stream + base64
// helpers under the devtool namespace.

#include "audio_common.h"

#include <cstring>
#include <mbedtls/base64.h>

namespace devtool_audio {

bool parse_chunk_params(const cJSON* params, int* chunk, int* of,
                        char* stream_id, int* ec, const char** em) {
    const cJSON* chunk_node = cJSON_GetObjectItem(params, "chunk");
    const cJSON* of_node = cJSON_GetObjectItem(params, "of");
    const cJSON* sid_node = cJSON_GetObjectItem(params, "stream_id");

    // If none present, it's a single-payload request (backwards compatible).
    if (!cJSON_IsNumber(chunk_node) && !cJSON_IsNumber(of_node)
        && !cJSON_IsString(sid_node)) {
        return false;
    }

    // If ANY chunk param is present, ALL must be present.
    if (!cJSON_IsNumber(chunk_node) || !cJSON_IsNumber(of_node)
        || !cJSON_IsString(sid_node)) {
        *ec = -32602;
        *em = "Invalid params: chunk, of, and stream_id must all be present";
        return true;
    }

    *chunk = chunk_node->valueint;
    *of = of_node->valueint;
    const char* sid = sid_node->valuestring;
    const size_t sid_len = strlen(sid);
    if (sid_len > 32) {
        *ec = -32602;
        *em = "Invalid params: stream_id max 32 chars";
        return true;
    }
    strncpy(stream_id, sid, 32);
    stream_id[32] = '\0';

    if (*chunk < 0 || *of <= 0 || *chunk >= *of) {
        *ec = -32602;
        *em = "Invalid params: chunk must be 0..of-1";
        return true;
    }

    return true;
}

int decode_b64_to_vec(const char* b64, size_t b64_len,
                      std::vector<uint8_t>& out,
                      int* ec, const char** em) {
    size_t need = 0;
    int rc = mbedtls_base64_decode(nullptr, 0, &need,
                                   reinterpret_cast<const unsigned char*>(b64),
                                   b64_len);
    if (rc != MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL && rc != 0) {
        *ec = -32602;
        *em = "Invalid params: base64 decode failed";
        return 1;
    }
    if (need == 0) {
        *ec = -32602;
        *em = "Invalid params: empty payload";
        return 1;
    }
    out.resize(need);
    size_t actual = 0;
    rc = mbedtls_base64_decode(out.data(), out.size(), &actual,
                               reinterpret_cast<const unsigned char*>(b64),
                               b64_len);
    if (rc != 0 || actual != need) {
        out.clear();
        *ec = -32603;
        *em = "Internal error: base64 decode failed";
        return 1;
    }
    return 0;
}

}  // namespace devtool_audio
