// SPDX-License-Identifier: MIT
#pragma once

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

    void reset() { size = 0; opcode = 0; dropped = false; }
    // Returns true at message end, including dropped oversized messages.
    bool append(uint8_t op, bool fin, int offset, int total, const char* part, int len) {
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
        if (static_cast<size_t>(total) > kLimit || static_cast<size_t>(len) > kLimit - size)
            dropped = true;
        if (!dropped && len) {
            std::memcpy(bytes.data() + size, part, len);
            size += len;
        }
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
    // Gateway binary frames: big-endian seq (8), type (1), Opus bytes.
    bool audio_payload(const uint8_t* data, size_t len, const uint8_t*& payload, size_t& size) {
        if (audio_turn.empty() || !data || len <= 9 || data[8] != 1) return false;
        uint64_t seq = 0;
        for (int i = 0; i < 8; ++i) seq = (seq << 8) | data[i];
        if (has_audio_seq && seq <= last_audio_seq) return false;
        has_audio_seq = true;
        last_audio_seq = seq;
        payload = data + 9;
        size = len - 9;
        return true;
    }
};

}  // namespace sentient::cube
