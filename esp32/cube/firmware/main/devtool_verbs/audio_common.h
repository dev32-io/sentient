// SPDX-License-Identifier: MIT
// devtool_verbs/audio_common.h — shared chunked-stream + base64 helpers for
// the audio.* devtool verbs that accept multi-chunk payloads.
//
// Mirrors components/agent_console/verbs/audio_common.h. Copied into the
// devtool path so Task 27 can rm agent_console wholesale without touching
// main/. Each verb that supports chunked input owns its own ChunkedStream
// instance in file scope.

#pragma once

#include <cJSON.h>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace devtool_audio {

// Single chunked-stream protocol state. One instance per verb (file scope).
struct ChunkedStream {
    char stream_id[33] = {0};  // 32 char max + null terminator
    std::string b64_accum;     // accumulated base64 fragments
    int next_chunk = 0;
    int total_chunks = 0;
    bool active = false;
};

// Per-chunk b64 size cap. 32 KB per CMD payload bounds heap growth on a
// single chunked send. Matches the legacy inject and play paths.
constexpr size_t kMaxChunkB64Bytes = 32 * 1024;

// Total accumulated base64 across all chunks of one stream. 256 KB is ~6 s of
// 16 kHz mono PCM16 once decoded — generous headroom for any HIL scenario.
constexpr size_t kMaxStreamB64Bytes = 256 * 1024;

// Parse chunk, of, stream_id from params.
// Returns true if this is a chunked request (even if invalid — check *ec).
// Returns false if none of the chunk params are present (single-payload).
bool parse_chunk_params(const cJSON* params, int* chunk, int* of,
                        char* stream_id, int* ec, const char** em);

// Base64-decode a string into a vector. Returns 0 on success, 1 on error.
// Sets *ec/*em on error.
int decode_b64_to_vec(const char* b64, size_t b64_len,
                      std::vector<uint8_t>& out,
                      int* ec, const char** em);

}  // namespace devtool_audio
