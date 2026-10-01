// Host check: c++ -std=c++17 -Wall -Wextra -pedantic sentient_wire_state_test.cc -o /tmp/sentient-wire-test && /tmp/sentient-wire-test
#include "../../firmware/main/protocols/sentient_wire_state.h"

#include <cassert>
#include <cstdint>
#include <string>

using sentient::cube::SentientWireState;
using sentient::cube::BoundedWsMessage;

int main() {
    BoundedWsMessage ws;
    const uint8_t* binary = nullptr;
    size_t binary_len = 0;
    assert(!ws.append(1, false, 0, 2, "a", 1, binary, binary_len));
    assert(!ws.append(1, false, 1, 2, "b", 1, binary, binary_len));
    assert(!ws.append(9, true, 0, 1, "p", 1, binary, binary_len)); // ping
    assert(!ws.append(10, true, 0, 0, nullptr, 0, binary, binary_len)); // pong
    assert(ws.append(0, true, 0, 1, "c", 1, binary, binary_len));
    assert(ws.opcode == 1 && !ws.framing_error && !ws.frame_open);
    ws.reset();
    std::string large(1024 * 1024, 'x');
    assert(ws.append(1, true, 0, large.size(), large.data(), large.size(), binary, binary_len));
    assert(!ws.dropped && !ws.framing_error);
    SentientWireState wire;
    wire.draft("draft-key");
    assert(wire.anchor == "draft-key" && wire.session_id.empty());
    assert(wire.start_capture("capture-1") && wire.capture_session_id.empty());
    assert(!wire.start_capture("capture-2"));
    assert(wire.finish_capture() == "capture-1");
    wire.attached("session", 3);
    assert(wire.start_capture("capture-2"));
    assert(wire.capture_session_id == "session" && wire.capture_generation == 3);
    assert(wire.finish_capture() == "capture-2");
    assert(wire.audio_start("turn", "unknown") == false);
    assert(wire.audio_start("turn", "opus"));
    const uint8_t frame[] = {0, 0, 0, 0, 0, 0, 0, 2, 1, 42, 43};
    assert(wire.audio_sequence(frame));
    assert(!wire.audio_sequence(frame));
    uint8_t bad[] = {0, 0, 0, 0, 0, 0, 0, 3, 2, 42};
    assert(!wire.audio_sequence(bad));
    assert(!wire.audio_end("other"));
    assert(wire.audio_end("turn"));
    assert(wire.audio_stop("turn") && !wire.audio_stop("turn"));
    wire.disconnect();
    assert(wire.anchor == "session" && wire.session_id.empty() && wire.capture_id.empty());
    assert(wire.audio_start("turn", "opus"));
    assert(wire.audio_sequence(frame));
    assert(wire.sequence(100, true, 1));
    assert(wire.sequence(0, true, 2));
    assert(wire.last_seq == 0 && wire.epoch == 2);
    assert(wire.sequence(2));
    assert(!wire.sequence(2));
    wire.attached("daily", 1);
    assert(wire.start_capture("frozen"));
    assert(wire.sequence(100));
    wire.attached("daily", 2); // Same socket/same session, fresh attachment.
    assert(wire.last_seq == 0 && wire.capture_generation == 1);
    assert(wire.sequence(1));
    wire.draft("new-draft");
    assert(wire.last_seq == 0 && wire.capture_session_id == "daily");
    wire.disconnect();
    wire.terminal_auth = true;
    assert(!wire.start_capture("capture-3"));
    wire.disconnect();
    assert(wire.terminal_auth);
}
