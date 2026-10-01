// SPDX-License-Identifier: MIT
#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <set>
#include <string>

namespace sentient::cube {

// Connection-scoped wire state; anchor survives disconnect, audio/capture never does.
struct BoundedWsMessage {
    uint8_t opcode = 0;
    bool dropped = false; // Binary cursor rejection, not a framing error.
    bool framing_error = false;
    bool new_message = false;
    std::array<uint8_t, 9> binary_header{};
    size_t header_size = 0;
    size_t frame_offset = 0;
    bool binary_accepted = false;
    bool frame_open = false;
    int frame_length = 0;
    uint8_t frame_opcode = 0;
    bool frame_fin = false;
    uint8_t control_opcode = 0;
    int control_offset = 0, control_length = 0;

    void reset() { *this = BoundedWsMessage{}; }
    // IDF callback offsets/lengths are frame-local; FIN belongs to that frame.
    // Text storage/parsing lives in BoundedEnvelope, never in this assembler.
    bool append(uint8_t op, bool fin, int offset, int total, const char* part, int len,
                const uint8_t*& binary, size_t& binary_len) {
        binary = nullptr;
        binary_len = 0;
        new_message = false;
        auto invalid = [this]() { framing_error = true; return false; };
        if (framing_error) return false;
        if (offset < 0 || total < 0 || len < 0 || offset > total || len > total - offset ||
            (len && !part)) return invalid();
        // Even a short control payload may arrive in several transport reads.
        // Track it separately without altering interrupted data-frame state.
        if (op >= 8) {
            if ((op != 8 && op != 9 && op != 10) || !fin || total > 125) return invalid();
            if (control_opcode) {
                if (op != control_opcode || total != control_length || offset != control_offset) return invalid();
            } else {
                if (offset != 0) return invalid();
                control_opcode = op;
                control_length = total;
            }
            control_offset = offset + len;
            if (control_offset == total) control_opcode = 0;
            return false;
        }
        if (control_opcode) return invalid();
        if (frame_open) {
            if (op != frame_opcode || total != frame_length || fin != frame_fin ||
                static_cast<size_t>(offset) != frame_offset) return invalid();
        } else {
            if (offset != 0) return invalid();
            if (op == 1 || op == 2) {
                if (opcode != 0) return invalid(); // Missing final continuation.
                opcode = op;
                new_message = true;
            } else if (op != 0 || opcode == 0) return invalid();
            frame_open = true;
            frame_length = total;
            frame_opcode = op;
            frame_fin = fin;
        }
        frame_offset = static_cast<size_t>(offset) + len;
        if (opcode == 2 && !dropped && len) {
            size_t prefix = std::min(static_cast<size_t>(len), binary_header.size() - header_size);
            std::memcpy(binary_header.data() + header_size, part, prefix);
            header_size += prefix;
            binary = reinterpret_cast<const uint8_t*>(part + prefix);
            binary_len = len - prefix;
        }
        if (offset + len != total) return false;
        frame_open = false;
        frame_offset = 0;
        return fin;
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
    uint64_t last_seq = 0;
    uint64_t epoch = 0;
    bool has_epoch = false;
    // Producer normally has one foreground run. Bound defensive overlap state.
    static constexpr size_t kMaxCognitionTurns = 32;
    std::set<std::string> cognition_turns;

    void reset_journal() {
        last_seq = 0; epoch = 0; has_epoch = false;
        audio_turn.clear(); done_turn.clear(); cognition_turns.clear();
    }
    bool sequence(uint64_t seq, bool supplied_epoch = false, uint64_t next_epoch = 0) {
        if (supplied_epoch && (!has_epoch || epoch != next_epoch)) {
            last_seq = 0; epoch = next_epoch; has_epoch = true;
        }
        if (seq == 0) return true;
        if (seq <= last_seq) return false;
        last_seq = seq;
        return true;
    }
    bool terminal_auth = false;

    void disconnect() {
        session_id.clear();
        generation = 0;
        capture_id.clear();
        capture_session_id.clear();
        capture_generation = 0;
        reset_journal();
    }
    void attached(const std::string& id, int gen) {
        if (id.empty() || gen <= 0) return;
        if (session_id != id || generation != gen) reset_journal();
        session_id = id;
        generation = gen;
        anchor = id;
    }
    void draft(const std::string& key) {
        if (key.empty()) return;
        if (anchor != key || !session_id.empty()) reset_journal();
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
        if (turn.empty() || (encoding != "opus" && encoding != "pcm") || !audio_turn.empty()) return false;
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
    // Gateway binary frames: big-endian seq (8), type (1), declared Opus/Ogg or PCM16LE bytes.
    bool audio_sequence(const uint8_t* header) {
        if (!header || header[8] != 1) return false;
        uint64_t seq = 0;
        for (int i = 0; i < 8; ++i) seq = (seq << 8) | header[i];
        return sequence(seq) && !audio_turn.empty();
    }
};

}  // namespace sentient::cube
