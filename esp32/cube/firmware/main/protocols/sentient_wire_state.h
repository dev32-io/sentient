// SPDX-License-Identifier: MIT
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace sentient::cube {

// Connection-scoped wire state; anchor survives disconnect, audio/capture never does.
struct BoundedWsMessage {
    // ponytail: snapshots beyond 16 KiB are dropped; page history if Cube needs larger snapshots.
    static constexpr size_t kLimit = 16384;
    std::array<char, kLimit> bytes{};
    size_t size = 0;
    uint8_t opcode = 0;
    bool dropped = false;
    std::array<uint8_t, 9> binary_header{};
    size_t header_size = 0;
    size_t frame_offset = 0;
    bool binary_accepted = false;

    void reset() { size = 0; opcode = 0; dropped = false; header_size = 0; frame_offset = 0; binary_accepted = false; }
    // Returns true at message end, including dropped oversized messages.
    bool append(uint8_t op, bool fin, int offset, int total, const char* part, int len,
                const uint8_t*& binary, size_t& binary_len) {
        binary = nullptr;
        binary_len = 0;
        if (offset < 0 || total < 0 || len < 0 || offset > total || len > total - offset ||
            (len && !part)) { reset(); return false; }
        // Pinned esp_websocket_client dispatches control frames as DATA events.
        // They must not replace an in-progress fragmented data message.
        if (op >= 8) return false;
        if (offset == 0 && (op == 1 || op == 2)) {
            reset();
            opcode = op;
        }
        if (opcode != 1 && opcode != 2) return false;
        if (opcode == 2) {
            // IDF offsets refer to each WS frame, not the whole fragmented message.
            if (static_cast<size_t>(offset) != frame_offset) dropped = true;
            frame_offset = static_cast<size_t>(offset) + len;
            if (!dropped && len) {
                size_t prefix = std::min(static_cast<size_t>(len), binary_header.size() - header_size);
                std::memcpy(binary_header.data() + header_size, part, prefix);
                header_size += prefix;
                binary = reinterpret_cast<const uint8_t*>(part + prefix);
                binary_len = len - prefix;
            }
        } else {
            if (static_cast<size_t>(total) > kLimit || static_cast<size_t>(len) > kLimit - size)
                dropped = true;
            if (!dropped && len) {
                std::memcpy(bytes.data() + size, part, len);
                size += len;
            }
        }
        if (offset + len == total) frame_offset = 0;
        return offset + len == total && fin;
    }
};

struct SentientWireState {
    std::string anchor;
    std::string session_id;
    int generation = 0;
    std::string capture_id;
    std::string capture_session_id;
    int capture_generation = 0;
    std::string audio_turn;
    std::string done_turn;
    uint64_t last_audio_seq = 0;
    bool has_audio_seq = false;
    bool terminal_auth = false;

    void disconnect() {
        session_id.clear();
        generation = 0;
        capture_id.clear();
        capture_session_id.clear();
        capture_generation = 0;
        audio_turn.clear();
        done_turn.clear();
        has_audio_seq = false;
        last_audio_seq = 0;
    }
    void attached(const std::string& id, int gen) {
        if (id.empty() || gen <= 0) return;
        session_id = id;
        generation = gen;
        anchor = id;
    }
    void draft(const std::string& key) {
        if (key.empty()) return;
        session_id.clear();
        generation = 0;
        anchor = key;
    }
    bool start_capture(const std::string& id) {
        if (terminal_auth || id.empty() || id.size() > 128 || !capture_id.empty()) return false;
        capture_id = id;
        capture_session_id = session_id;
        capture_generation = generation;
        return true;
    }
    std::string finish_capture() {
        std::string id = capture_id;
        capture_id.clear();
        return id;
    }
    bool audio_start(const std::string& turn, const std::string& encoding) {
        // PCM is declared on wire but Cube playback callback feeds Opus decoder only.
        if (turn.empty() || encoding != "opus" || !audio_turn.empty()) return false;
        audio_turn = turn;
        done_turn.clear();
        return true;
    }
    bool audio_end(const std::string& turn) {
        if (audio_turn != turn || turn.empty()) return false;
        audio_turn.clear();
        done_turn = turn;
        return true;
    }
    bool audio_stop(const std::string& turn) {
        if (turn.empty() || (audio_turn != turn && (!audio_turn.empty() || done_turn != turn))) return false;
        audio_turn.clear();
        done_turn.clear();
        return true;
    }
    // Gateway binary frames: big-endian seq (8), type (1), Ogg stream bytes.
    bool audio_sequence(const uint8_t* header) {
        if (audio_turn.empty() || !header || header[8] != 1) return false;
        uint64_t seq = 0;
        for (int i = 0; i < 8; ++i) seq = (seq << 8) | header[i];
        if (has_audio_seq && seq <= last_audio_seq) return false;
        has_audio_seq = true;
        last_audio_seq = seq;
        return true;
    }
};

}  // namespace sentient::cube
