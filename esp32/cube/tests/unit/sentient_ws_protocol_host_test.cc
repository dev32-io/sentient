// Host seam runs production protocol with fake pinned-client sends/events.
// Link IDF components/json/cJSON/cJSON.c for real JSON encoding.
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "ws_stubs/mock_idf.h"
#define private public
#include "../../firmware/main/protocols/sentient_ws_protocol.h"
#undef private
#include <cassert>
#include <cstring>

// Synthetic Ogg pages only: no voice fixtures or decoder dependency.
static std::string page(const std::vector<std::string>& packets, bool bos = false) {
    std::string segments, body;
    for (const auto& packet : packets) {
        size_t n = packet.size();
        for (; n >= 255; n -= 255) segments += static_cast<char>(255);
        segments += static_cast<char>(n);
        body += packet;
    }
    assert(segments.size() <= 255);
    std::string header(27, '\0');
    header.replace(0, 4, "OggS");
    header[5] = bos ? 2 : 0;
    header[26] = static_cast<char>(segments.size());
    return header + segments + body;
}
static std::string head(int rate) {
    std::string h(19, '\0');
    h.replace(0, 8, "OpusHead");
    h[8] = 1; h[9] = 1;
    for (int i = 0; i < 4; ++i) h[12 + i] = static_cast<char>(rate >> (8 * i));
    return h;
}

std::atomic<int> mock_ticks_extra{0};
std::atomic<int> mock_client_stops{0}, mock_client_finishes{0};
std::mutex mock_notify_mutex;
std::condition_variable mock_notify_cv;
uint32_t mock_notifications = 0;
int mock_binary_result = 0;
int mock_binary_sends = 0;
int mock_end_result = 0;
int mock_start_result = 0;
bool mock_block_binary = false;
bool mock_inside_binary = false;
bool mock_release_binary = false;
std::mutex mock_mutex;
std::condition_variable mock_cv;
std::string mock_text;
using namespace sentient::cube;

// Actual bounded component linked by host runner; these drive SDK DATA events.
static void envelope_regressions() {
    auto fragment = [](SentientWsProtocol& sdk, uint8_t op, bool fin, int offset,
                       int total, const char* bytes, int length) {
        esp_websocket_event_data_t e{};
        e.op_code = op; e.fin = fin; e.payload_offset = offset; e.payload_len = total;
        e.data_ptr = bytes; e.data_len = length;
        SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_DATA, &e);
    };
    auto text = [&](SentientWsProtocol& sdk, const std::string& json) {
        fragment(sdk, 1, true, 0, json.size(), json.data(), json.size());
    };
    for (size_t width : {1u, 17u, 4096u}) {
        int thinking = 0, beginnings = 0, packets = 0;
        SentientWsProtocolConfig cfg;
        cfg.on_cognition_status = [&](CognitionState state) { thinking += state == CognitionState::Thinking; };
        cfg.on_playback_begin = [&](int) { ++beginnings; };
        cfg.on_playback_frame = [&](const uint8_t*, size_t size, int rate, bool pcm) {
            assert(size == 960 && rate == 24000 && pcm); ++packets;
        };
        SentientWsProtocol sdk(std::move(cfg)); sdk.status_ = SdkStatus::Ready;
        // Frame-local offsets restart only at actual WS continuation boundaries.
        // Hold FIN after the complete root to prove no publication from parser done.
        auto fragmented = [&](const std::string& json) {
            for (size_t frame = 0; frame < json.size(); frame += 8191) {
                size_t total = std::min(size_t(8191), json.size() - frame);
                for (size_t offset = 0; offset < total;) {
                    size_t size = std::min(width == 17 ? 1 + (offset * 7 % 37) : width, total - offset);
                    fragment(sdk, frame ? 0 : 1, false, offset, total, json.data() + frame + offset, size);
                    if (offset == 0) {
                        fragment(sdk, 9, true, 0, 2, "p", 1);
                        fragment(sdk, 9, true, 1, 2, "q", 1);
                        fragment(sdk, 10, true, 0, 0, nullptr, 0);
                    }
                    offset += size;
                }
            }
            assert(sdk.status() == SdkStatus::Ready);
        };
        const std::string payload = std::string(width == 4096 ? 2 * 1024 * 1024 : 65537, 'x') +
                                    R"(\"\\\u20ac\ud83d\ude00)";
        const std::string items = R"("items":[{"entryId":"fixture","ts":0,"kind":"user","channel":"speech","content":")" + payload + R"("}])";
        const std::string snapshot = "{" + items + R"(,"t\u0079pe":"conversation.snapshot","s\u0065q":101,"epoch":4})";
        fragmented(snapshot);
        assert(sdk.wire_.last_seq == 0 && !sdk.wire_.has_epoch && thinking == 0 && beginnings == 0);
        fragment(sdk, 0, true, 0, 0, nullptr, 0);
        assert(sdk.wire_.last_seq == 101 && sdk.wire_.epoch == 4 && thinking == 0);
        assert(sdk.last_transcript().empty()); // History never becomes STT diagnostics.
        text(sdk, R"({"t\u0079pe":"turn.started","turnId":"live","s\u0065q":102,"epoch":4})");
        assert(thinking == 1); // No pre-dispatch/double cursor advance.
        text(sdk, R"({"type":"turn.audio.start","turnId":"live","encoding":"pcm","sampleRate":24000,"seq":103})");
        const std::string tasks = R"({"items":[{"id":"job","toolName":"delegate","kind":"background","status":"running","argsPreview":")" +
            payload + R"(","startedAtMs":0}],"type":"tasklist.state","turnId":null,"seq":104,"epoch":4})";
        fragmented(tasks);
        assert(sdk.wire_.last_seq == 103);
        fragment(sdk, 0, true, 0, 0, nullptr, 0);
        assert(sdk.wire_.last_seq == 104 && sdk.wire_.audio_turn == "live" && thinking == 1 && beginnings == 1);
        fragmented(R"({"type":"turn.text.delta","turnId":"live","replyId":"reply","text":")" + payload + R"(","seq":105})");
        assert(sdk.wire_.last_seq == 104);
        fragment(sdk, 0, true, 0, 0, nullptr, 0);
        assert(sdk.wire_.last_seq == 105 && sdk.wire_.cognition_turns.count("live") && beginnings == 1);
        std::string pcm(969, '\0'); pcm[7] = 106; pcm[8] = 1;
        fragment(sdk, 2, true, 0, pcm.size(), pcm.data(), pcm.size());
        assert(packets == 1 && sdk.wire_.last_seq == 106);
        // Epoch after huge ignored items is authoritative, including reset to low seq.
        fragmented("{" + items + R"(,"type":"conversation.snapshot","seq":1,"epoch":5})");
        assert(sdk.wire_.epoch == 4 && sdk.wire_.last_seq == 106);
        fragment(sdk, 0, true, 0, 0, nullptr, 0);
        assert(sdk.wire_.epoch == 5 && sdk.wire_.last_seq == 1 && sdk.wire_.cognition_turns.empty());
    }
    // Late malformed ignored body, trailing root junk, duplicate escaped envelope
    // key, truncated root, and bounded selected-field failure never publish prefix.
    const std::string prefix = R"({"type":"turn.started","turnId":"never","seq":8,"items":[")" + std::string(65537, 'x');
    for (const auto& pair : std::vector<std::pair<std::string, std::string>>{
            {prefix, R"(",]})"},
            {R"({"type":"turn.started","turnId":"never","seq":8})", "!"},
            {R"({"type":"turn.started","turnId":"never",)", R"("t\u0079pe":"turn.completed"})"},
            {R"({"type":"turn.started","turnId":"never")", ""},
            {R"({"type":"turn.started","turnId":")" + std::string(257, 'x'), R"("})"}}) {
        int thinking = 0;
        SentientWsProtocolConfig cfg;
        cfg.on_cognition_status = [&](CognitionState state) { thinking += state == CognitionState::Thinking; };
        SentientWsProtocol sdk(std::move(cfg)); sdk.status_ = SdkStatus::Ready;
        fragment(sdk, 1, false, 0, pair.first.size(), pair.first.data(), pair.first.size());
        assert(thinking == 0 && sdk.wire_.last_seq == 0);
        fragment(sdk, 0, true, 0, pair.second.size(), pair.second.data(), pair.second.size());
        assert(sdk.status() == SdkStatus::Error && thinking == 0 && sdk.wire_.last_seq == 0);
        text(sdk, R"({"type":"turn.started","turnId":"blocked"})");
        assert(thinking == 0); // Sticky recovery gate, not a new valid prefix.
    }
    // Invalid frame metadata/order, including continuation-local gaps/reordering.
    for (int fault = 0; fault < 21; ++fault) {
        SentientWsProtocol sdk({}); sdk.status_ = SdkStatus::Ready;
        if (fault < 5) {
            fragment(sdk, 1, false, 0, 4, "{ ", 2);
            if (fault == 0) fragment(sdk, 1, false, 3, 4, "}", 1); // Gap.
            if (fault == 1) fragment(sdk, 1, false, 0, 4, "{ ", 2); // Reordered/repeated callback.
            if (fault == 2) fragment(sdk, 1, false, 2, 5, " }", 2); // Changed total.
            if (fault == 3) fragment(sdk, 1, true, 2, 4, " }", 2); // Changed FIN mid-frame.
            if (fault == 4) fragment(sdk, 0, false, 2, 4, " }", 2); // Changed opcode mid-frame.
        } else if (fault == 5) {
            fragment(sdk, 1, false, 0, 1, "{", 1);
            fragment(sdk, 0, true, 0, 4, "  ", 2);
            fragment(sdk, 0, true, 3, 4, "}", 1); // Continuation frame gap.
        } else if (fault == 6) {
            fragment(sdk, 1, false, 0, 2, "{}", 2);
            text(sdk, "{}"); // New data opcode before prior FIN.
        } else if (fault == 7) fragment(sdk, 0, true, 0, 2, "{}", 2); // Orphan continuation.
        else if (fault == 8) fragment(sdk, 3, true, 0, 2, "{}", 2); // Reserved opcode.
        else if (fault == 9) fragment(sdk, 9, false, 0, 0, nullptr, 0); // Fragmented control.
        else if (fault == 10) fragment(sdk, 1, true, -1, 2, "{}", 2);
        else if (fault == 11) fragment(sdk, 1, true, 0, -1, "{}", 2);
        else if (fault == 12) fragment(sdk, 1, true, 0, 1, "{}", 2);
        else if (fault == 13) fragment(sdk, 1, true, 0, 2, nullptr, 2);
        else if (fault == 14) fragment(sdk, 1, true, 3, 2, nullptr, 0);
        else if (fault == 15) fragment(sdk, 1, true, 0, 2, "{}", -1);
        else if (fault == 16) fragment(sdk, 9, true, 0, 126, "p", 126);
        else if (fault == 17) fragment(sdk, 11, true, 0, 0, nullptr, 0);
        else if (fault == 18) {
            fragment(sdk, 1, false, 0, 1, "{", 1);
            fragment(sdk, 0, true, 0, 4, "  ", 2);
            fragment(sdk, 0, true, 0, 4, "  ", 2); // Continuation callback reordered.
        } else {
            fragment(sdk, 9, true, 0, 3, "p", 1);
            if (fault == 19) fragment(sdk, 9, true, 2, 3, "q", 1); // Control offset gap.
            else text(sdk, "{}"); // Data before control payload complete.
        }
        assert(sdk.status() == SdkStatus::Error && sdk.inbound_.framing_error);
    }
    {
        int thinking = 0;
        SentientWsProtocolConfig cfg;
        cfg.on_cognition_status = [&](CognitionState state) { thinking += state == CognitionState::Thinking; };
        SentientWsProtocol sdk(std::move(cfg)); sdk.status_ = SdkStatus::Ready;
        fragment(sdk, 1, false, 0, 4, "{\"ty", 4);
        SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_DISCONNECTED, nullptr);
        assert(sdk.inbound_.opcode == 0 && !sdk.inbound_.frame_open);
        sdk.status_ = SdkStatus::Authenticating; // Next connection's auth completed.
        text(sdk, R"({"type":"session.ready","epoch":9})");
        assert(sdk.status() == SdkStatus::Ready);
        const std::string fresh = R"({"type":"turn.started","turnId":"fresh","seq":1})";
        fragment(sdk, 1, false, 0, fresh.size(), fresh.data(), fresh.size());
        assert(thinking == 0 && sdk.wire_.last_seq == 0);
        fragment(sdk, 9, true, 0, 0, nullptr, 0);
        fragment(sdk, 0, true, 0, 0, nullptr, 0);
        assert(thinking == 1 && sdk.wire_.last_seq == 1 && sdk.wire_.epoch == 9);
        fragment(sdk, 0, true, 0, 0, nullptr, 0); // Extra final continuation cannot redispatch.
        assert(thinking == 1 && sdk.status() == SdkStatus::Error);
    }
    {
        SentientWsProtocol sdk({}); sdk.status_ = SdkStatus::Ready;
        cJSON_Hooks hooks{};
        hooks.malloc_fn = [](size_t) -> void* { return nullptr; };
        hooks.free_fn = free;
        cJSON_InitHooks(&hooks);
        text(sdk, R"({"type":"turn.started","turnId":"never","seq":7})");
        cJSON_InitHooks(nullptr);
        assert(sdk.status() == SdkStatus::Error && sdk.wire_.cognition_turns.empty());
    }
}

int main() {
    envelope_regressions();
    auto exercise = [](bool binary_fails, bool end_fails, bool cancel = false, bool busy = false) {
        mock_text.clear();
        mock_binary_result = binary_fails;
        mock_binary_sends = 0;
        mock_end_result = end_fails;
        mock_block_binary = true;
        mock_inside_binary = mock_release_binary = false;
        std::atomic<int> popped{0};
        std::atomic<bool> stopped{false};
        std::vector<SdkStatus> statuses;
        SentientWsProtocolConfig cfg;
        cfg.on_status_change = [&](SdkStatus s) { statuses.push_back(s); };
        cfg.on_pop_uplink_frame = [&](std::vector<uint8_t>& payload) {
            if (popped++ >= 2) return false;
            payload = {42};
            return true;
        };
        SentientWsProtocol protocol(std::move(cfg));
        protocol.client_ = new MockClient;
        protocol.status_ = SdkStatus::Ready;
        protocol.wire_.attached("session", 2);
        assert(protocol.start_streaming());
        protocol.worker_ = new MockTask;
        protocol.worker_done_ = xSemaphoreCreateBinary();
        std::thread worker([&] { protocol.run_worker(); });
        protocol.notify_uplink_available();
        { std::unique_lock<std::mutex> lock(mock_mutex);
          mock_cv.wait(lock, [] { return mock_inside_binary; }); }
        const char* refusal = R"({"type":"command.rejected","command":"audio.start","reason":"session_busy"})";
        if (busy) {
            protocol.handle_text(refusal, strlen(refusal));
            assert(protocol.busy_refusal_pending() && !protocol.start_streaming());
        }
        std::thread release([&] {
            if (busy) protocol.settle_busy_refusal();
            else if (cancel) protocol.cancel_streaming();
            else protocol.stop_streaming();
            stopped = true;
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        assert(!stopped && mock_text.find("audio.end") == std::string::npos);
        if (busy) {
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
            for (;;) {
                { std::lock_guard<std::mutex> lock(protocol.state_mutex_); if (protocol.ending_) break; }
                assert(std::chrono::steady_clock::now() < deadline);
                std::this_thread::yield();
            }
            protocol.handle_text(refusal, strlen(refusal)); // New refusal while cancel waits.
        }
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        release.join();
        assert(stopped);
        if (busy) {
            assert(protocol.busy_refusal_pending());
            protocol.settle_busy_refusal();
            assert(!protocol.busy_refusal_pending());
            assert(mock_text.find("audio.cancel") == mock_text.rfind("audio.cancel"));
        }
        protocol.stopping_ = true;
        xTaskNotify(protocol.worker_, 4, eSetBits);
        worker.join();
        delete protocol.worker_; protocol.worker_ = nullptr;
        vSemaphoreDelete(protocol.worker_done_); protocol.worker_done_ = nullptr;
        if (cancel) {
            assert(mock_binary_sends == 1 && mock_text.find("audio.end") == std::string::npos);
            assert(mock_text.find("audio.cancel") != std::string::npos);
        } else if (binary_fails) {
            assert(mock_binary_sends == 1 && mock_text.find("audio.end") == std::string::npos);
            assert(protocol.status() != SdkStatus::Ready);
        } else if (end_fails) {
            assert(mock_binary_sends == 2 && mock_text.find("audio.end") != std::string::npos);
            assert(protocol.status() != SdkStatus::Ready);
        } else {
            assert(mock_binary_sends == 2 && mock_text.find("audio.end") != std::string::npos);
            assert(protocol.status() == SdkStatus::Ready);
        }
    };
    // Connected socket may reject audio.start; failure must drop capture, not start recording.
    {
        SentientWsProtocol failed({});
        failed.client_ = new MockClient;
        failed.status_ = SdkStatus::Ready;
        failed.wire_.attached("session", 2);
        mock_start_result = 1;
        assert(!failed.start_streaming());
        mock_start_result = 0;
        assert(failed.status() == SdkStatus::Error);
        assert(failed.wire_.capture_id.empty() && !failed.streaming_);
    }
    exercise(false, false);
    exercise(true, false);
    exercise(false, true);
    exercise(false, false, true);
    exercise(false, false, true, true);
    // Bounded stop: simulated deadline while send is in flight must suppress end.
    mock_ticks_extra = 0;
    mock_text.clear(); mock_binary_result = 0; mock_end_result = 0;
    mock_inside_binary = mock_release_binary = false;
    mock_block_binary = true;
    SentientWsProtocolConfig timeout_cfg;
    timeout_cfg.on_pop_uplink_frame = [](std::vector<uint8_t>& payload) {
        payload = {42}; return true;
    };
    {
        SentientWsProtocol timed(std::move(timeout_cfg));
        timed.client_ = new MockClient;
        timed.status_ = SdkStatus::Ready;
        assert(timed.start_streaming());
        timed.worker_ = new MockTask;
        timed.worker_done_ = xSemaphoreCreateBinary();
        std::thread worker([&] { timed.run_worker(); });
        timed.notify_uplink_available();
        { std::unique_lock<std::mutex> lock(mock_mutex);
          mock_cv.wait(lock, [] { return mock_inside_binary; }); }
        std::thread release([&] { timed.stop_streaming(); });
        for (;;) {
            { std::lock_guard<std::mutex> lock(timed.state_mutex_);
              if (timed.ending_) break; }
            std::this_thread::yield();
        } // stop has set deadline
        mock_ticks_extra = 6000;
        release.join();
        assert(timed.status() != SdkStatus::Ready);
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        timed.stopping_ = true;
        xTaskNotify(timed.worker_, 4, eSetBits);
        worker.join();
        delete timed.worker_; timed.worker_ = nullptr;
        vSemaphoreDelete(timed.worker_done_); timed.worker_done_ = nullptr;
        assert(mock_text.find("audio.end") == std::string::npos);
    }
    mock_ticks_extra = 0;
    // Teardown waits for in-flight worker send; queued pump cannot emit end.
    {
        mock_text.clear(); mock_binary_result = 0; mock_block_binary = true;
        mock_inside_binary = mock_release_binary = false;
        SentientWsProtocolConfig cfg;
        cfg.on_pop_uplink_frame = [](std::vector<uint8_t>& payload) {
            payload = {42}; return true;
        };
        SentientWsProtocol closing(std::move(cfg));
        closing.client_ = new MockClient;
        closing.worker_ = new MockTask;
        closing.worker_done_ = xSemaphoreCreateBinary();
        closing.status_ = SdkStatus::Ready;
        assert(closing.start_streaming());
        std::thread worker([&] { closing.run_worker(); });
        closing.notify_uplink_available();
        { std::unique_lock<std::mutex> lock(mock_mutex);
          mock_cv.wait(lock, [] { return mock_inside_binary; }); }
        std::atomic<bool> disconnected{false};
        std::thread teardown([&] { closing.disconnect(); disconnected = true; });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        assert(!disconnected);
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        teardown.join(); worker.join();
        assert(disconnected && mock_text.find("audio.end") == std::string::npos);
    }
    // Stop wins over coalesced pump even if both bits arrive together.
    {
        std::lock_guard<std::mutex> lock(mock_notify_mutex);
        mock_notifications = 0;
    }
    {
        int popped = 0;
        SentientWsProtocolConfig cfg;
        cfg.on_pop_uplink_frame = [&](std::vector<uint8_t>& payload) {
            ++popped; payload = {42}; return true;
        };
        SentientWsProtocol halted(std::move(cfg));
        halted.client_ = new MockClient;
        halted.worker_ = new MockTask;
        halted.worker_done_ = xSemaphoreCreateBinary();
        halted.status_ = SdkStatus::Ready;
        assert(halted.start_streaming());
        halted.notify_uplink_available();
        xTaskNotify(halted.worker_, 4, eSetBits);
        halted.run_worker();
        assert(popped == 0);
        delete halted.worker_; halted.worker_ = nullptr;
        vSemaphoreDelete(halted.worker_done_); halted.worker_done_ = nullptr;
    }
    // Failed send must close partial capture, back off, and reconnect; auth.error must not retry.
    {
        std::lock_guard<std::mutex> lock(mock_notify_mutex);
        mock_notifications = 0;
    }
    mock_client_stops = 0;
    SentientWsProtocolConfig retry_cfg;
    retry_cfg.gateway_url = "wss://localhost/test";
    retry_cfg.device_id = "test-device";
    int retry_frames = 0;
    retry_cfg.on_pop_uplink_frame = [&](std::vector<uint8_t>& payload) {
        if (retry_frames++) return false;
        payload = {42};
        return true;
    };
    SentientWsProtocol retry(std::move(retry_cfg));
    retry.client_ = new MockClient;
    retry.worker_ = new MockTask;
    retry.worker_done_ = xSemaphoreCreateBinary();
    retry.status_ = SdkStatus::Ready;
    retry.wire_.attached("session", 2);
    assert(retry.start_streaming());
    mock_text.clear(); mock_binary_result = 1; mock_binary_sends = 0; mock_block_binary = false;
    // Coalesced pump bit: codec callback posts, never pops or sends itself.
    retry.notify_uplink_available();
    retry.notify_uplink_available();
    assert(retry_frames == 0 && mock_binary_sends == 0);
    { std::lock_guard<std::mutex> lock(mock_notify_mutex);
      assert(mock_notifications == 16); }
    std::thread worker([&] { retry.run_worker(); });
    for (int i = 0; i < 1000 && retry.status() != SdkStatus::Connecting; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(retry.status() == SdkStatus::Connecting && mock_client_stops == 1);
    assert(mock_binary_sends == 1 && retry_frames == 1);
    assert(mock_text.find("audio.end") == std::string::npos);
    assert(retry.wire_.capture_id.empty() && retry.wire_.session_id.empty());
    mock_binary_result = 0;
    retry.stopping_ = true;
    xTaskNotify(retry.worker_, 4, eSetBits);
    worker.join();
    delete retry.worker_;
    retry.worker_ = nullptr;
    vSemaphoreDelete(retry.worker_done_);
    retry.worker_done_ = nullptr;
    retry.cancel_reconnect();

    { std::lock_guard<std::mutex> lock(mock_notify_mutex); mock_notifications = 0; }
    SentientWsProtocolConfig timeout_retry_cfg;
    timeout_retry_cfg.gateway_url = "wss://localhost/test";
    timeout_retry_cfg.device_id = "test-device";
    SentientWsProtocol timeout_retry(std::move(timeout_retry_cfg));
    timeout_retry.client_ = new MockClient;
    timeout_retry.worker_ = new MockTask;
    timeout_retry.worker_done_ = xSemaphoreCreateBinary();
    timeout_retry.status_ = SdkStatus::Authenticating;
    int stops_before = mock_client_stops;
    std::thread timeout_worker([&] { timeout_retry.run_worker(); });
    xTaskNotify(timeout_retry.worker_, 2, eSetBits); // ready timeout
    for (int i = 0; i < 1000 && timeout_retry.status() != SdkStatus::Connecting; ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(timeout_retry.status() == SdkStatus::Connecting && mock_client_stops == stops_before + 1);
    timeout_retry.stopping_ = true;
    xTaskNotify(timeout_retry.worker_, 4, eSetBits);
    timeout_worker.join();
    delete timeout_retry.worker_;
    timeout_retry.worker_ = nullptr;
    vSemaphoreDelete(timeout_retry.worker_done_);
    timeout_retry.worker_done_ = nullptr;
    timeout_retry.cancel_reconnect();

    { std::lock_guard<std::mutex> lock(mock_notify_mutex); mock_notifications = 0; }
    SentientWsProtocolConfig auth_cfg;
    SentientWsProtocol auth(std::move(auth_cfg));
    auth.client_ = new MockClient;
    auth.worker_ = new MockTask;
    auth.status_ = SdkStatus::Authenticating;
    auth.handle_text("{\"type\":\"auth.error\"}", strlen("{\"type\":\"auth.error\"}"));
    assert(auth.status() == SdkStatus::Error && auth.wire_.terminal_auth);
    SentientWsProtocol::ws_event_handler(&auth, nullptr, WEBSOCKET_EVENT_DISCONNECTED, nullptr);
    assert(auth.status() == SdkStatus::Error && auth.reconnect_attempts_ == 0);
    auth.fail_uplink(); // terminal auth cannot be downgraded into transport retry
    assert(auth.status() == SdkStatus::Error);
    { std::lock_guard<std::mutex> lock(mock_notify_mutex); assert(mock_notifications == 0); }
    delete auth.worker_;
    auth.worker_ = nullptr;
    delete auth.client_;
    auth.client_ = nullptr;
    // Pinned client DATA event layout: offset and total refer to WS frame portions.
    SentientWsProtocolConfig cfg;
    SentientWsProtocol protocol(std::move(cfg));
    protocol.status_ = SdkStatus::Authenticating;
    esp_websocket_event_data_t fragment{};
    fragment.data_ptr = "{\"type\":\"session."; fragment.data_len = 17;
    fragment.op_code = 1; fragment.payload_len = 17; fragment.fin = false;
    protocol.handle_data(&fragment);
    esp_websocket_event_data_t ping{};
    ping.data_ptr = "p"; ping.data_len = ping.payload_len = 1;
    ping.op_code = 9; ping.fin = true;
    protocol.handle_data(&ping);
    const char* tail = "ready\"}";
    esp_websocket_event_data_t continuation{};
    continuation.data_ptr = tail;
    continuation.data_len = continuation.payload_len = static_cast<int>(strlen(tail));
    continuation.op_code = 0; continuation.fin = true;
    protocol.handle_data(&continuation);
    assert(protocol.status() == SdkStatus::Ready);

    std::vector<std::pair<std::string, int>> packets;
    SentientWsProtocolConfig down_cfg;
    std::vector<bool> terminals;
    std::vector<CognitionState> cognition;
    down_cfg.on_cognition_status = [&](CognitionState state) { cognition.push_back(state); };
    down_cfg.on_playback_end = [&](bool aborted) { terminals.push_back(aborted); };
    down_cfg.on_playback_frame = [&](const uint8_t* data, size_t len, int rate, bool pcm) {
        (void)pcm;
        packets.emplace_back(std::string(reinterpret_cast<const char*>(data), len), rate);
    };
    SentientWsProtocol down(std::move(down_cfg));
    down.status_ = SdkStatus::Ready;
    auto text = [&](const std::string& json) {
        esp_websocket_event_data_t e{};
        e.op_code = 1; e.fin = true;
        e.data_ptr = json.data(); e.data_len = e.payload_len = static_cast<int>(json.size());
        down.handle_data(&e);
    };
    auto start = [&](const char* turn) {
        text(std::string("{\"type\":\"turn.audio.start\",\"turnId\":\"") + turn +
             "\",\"encoding\":\"opus\",\"sampleRate\":48000}");
    };
    auto binary_message = [&](uint64_t seq, const std::string& ogg,
                              bool split_envelope = false, uint8_t type = 1) {
        std::string message(9, '\0');
        for (int i = 7; i >= 0; --i) { message[i] = static_cast<char>(seq); seq >>= 8; }
        message[8] = static_cast<char>(type);
        message += ogg;
        auto send = [&](size_t begin, size_t len, int offset, int total, int op, bool fin) {
            esp_websocket_event_data_t e{};
            e.op_code = op; e.fin = fin;
            e.data_ptr = message.data() + begin;
            e.data_len = static_cast<int>(len);
            e.payload_offset = offset; e.payload_len = total;
            down.handle_data(&e);
        };
        if (split_envelope) {
            // First WS frame split by IDF, then continuation frame; ping interleaves.
            send(0, 3, 0, 5, 2, false);
            esp_websocket_event_data_t ping{};
            ping.op_code = 9; ping.fin = true;
            down.handle_data(&ping);
            send(3, 2, 3, 5, 2, false);
            send(5, 4, 0, static_cast<int>(message.size() - 5), 0, true);
            for (size_t pos = 9; pos < message.size(); pos += 13) {
                size_t len = std::min(size_t(13), message.size() - pos);
                send(pos, len, static_cast<int>(pos - 5), static_cast<int>(message.size() - 5), 0, true);
            }
        } else {
            for (size_t offset = 0; offset < message.size(); offset += 700) {
                size_t len = std::min(size_t(700), message.size() - offset);
                send(offset, len, static_cast<int>(offset), static_cast<int>(message.size()), 2, true);
            }
        }
    };
    start("one");
    std::string initial = page({head(48000)}, true) + page({"OpusTags"});
    // A packet split across pages and IDF callbacks; exact 255-byte segment
    // ends at page boundary, zero-length segment terminates packet on next page.
    std::string split(255, 's');
    std::string split_page = page({split});
    // Remove terminating zero segment: packet continues on next page.
    split_page.erase(28, 1);
    split_page[26] = 1;
    std::string continuation_page = page({""});
    continuation_page[5] = 1;
    binary_message(1, initial + split_page + continuation_page, true);
    assert(packets.size() == 1 && packets[0] == std::make_pair(split, 48000));
    binary_message(1, page({"replay"}));
    binary_message(2, ""); // header-only frame must not consume sequence
    binary_message(2, page({"wrong type"}), false, 2);
    assert(packets.size() == 1);
    std::vector<std::string> many(200, std::string(80, 'x'));
    std::string flush = page(many) + page(many);
    assert(flush.size() > 16384);
    binary_message(2, flush);
    assert(packets.size() == 401 && packets.back().first == many.back());
    // Chained BOS in same turn must parse new headers, not deliver them as audio.
    std::string chain = page({head(24000)}, true) + page({"OpusTags", "chained"});
    binary_message(3, chain.substr(0, 7)); // partial Ogg header across WS messages
    assert(packets.size() == 401);
    binary_message(4, chain.substr(7));
    assert(packets.size() == 402 && packets.back() == std::make_pair(std::string("chained"), 48000));
    text("{\"type\":\"turn.audio.done\",\"turnId\":\"one\"}");
    start("two");
    binary_message(5, page({"orphan"})); // no OpusHead after reset
    assert(packets.size() == 402);
    binary_message(6, page({head(48000)}, true) + page({"OpusTags", "next"}));
    assert(packets.size() == 403 && packets.back().first == "next");
    // Disconnect drops partial Ogg packet and sequence; new turn starts fresh.
    binary_message(7, page({head(48000)}, true));
    SentientWsProtocol::ws_event_handler(&down, nullptr, WEBSOCKET_EVENT_DISCONNECTED, nullptr);
    down.status_ = SdkStatus::Ready;
    start("three");
    binary_message(1, page({"OpusTags", "orphan"}));
    assert(packets.size() == 403);
    binary_message(2, page({head(48000)}, true) + page({"OpusTags", "fresh"}));
    assert(packets.size() == 404 && packets.back().first == "fresh");
    text("{\"type\":\"playback.stop\",\"turnId\":\"three\"}");
    start("four");
    binary_message(3, page({"orphan"}));
    assert(packets.size() == 404);
    binary_message(4, page({head(48000)}, true) + page({"OpusTags", "after-stop"}));
    assert(packets.size() == 405 && packets.back().first == "after-stop");
    // Partial generation failure closes receipt normally; playback prefix drains.
    const size_t before_failure = terminals.size();
    text(R"({"type":"turn.audio.done","turnId":"four"})");
    assert(terminals.size() == before_failure + 1 && !terminals.back());
    binary_message(5, page({"late"}));
    assert(packets.size() == 405);
    start("five");
    // A stale Done for the old stream cannot clear the newer owner's decoder.
    text(R"({"type":"turn.audio.done","turnId":"four"})");
    assert(terminals.size() == before_failure + 1);
    binary_message(6, initial + page({"normal-after-failure"}));
    assert(packets.size() == 406 && packets.back().first == "normal-after-failure");
    text(R"({"type":"turn.audio.done","turnId":"five"})");
    assert(terminals.size() == before_failure + 2 && !terminals.back());
    // Ignored JSON shares cursor; seq zero never deduplicates live replay frames.
    text(R"({"type":"turn.audio.start","turnId":"zero","encoding":"opus","sampleRate":48000})");
    binary_message(0, initial + page({"zero-one"}));
    binary_message(0, page({"zero-two"}));
    assert(packets.back().first == "zero-two");
    text(R"({"type":"tasklist.state","seq":100,"epoch":1,"items":[]})");
    const auto count = packets.size();
    binary_message(99, page({"duplicate"}));
    assert(packets.size() == count);
    text(R"({"type":"turn.started","turnId":"new","seq":101,"epoch":1})");
    text(R"({"type":"turn.completed","turnId":"old","seq":102,"epoch":1})");
    assert(cognition.back() == CognitionState::Thinking);
    text(R"({"type":"turn.completed","turnId":"new","seq":103,"epoch":1})");
    assert(cognition.back() == CognitionState::Idle);
    // Supplied epoch without sequence retires old bracket and resets watermark.
    text(R"({"type":"conversation.snapshot","epoch":2,"seq":0,"items":[]})");
    start("epoch-two");
    binary_message(2, initial + page({"epoch-two"}));
    assert(packets.back().first == "epoch-two");
    text(R"({"type":"session.attached","sessionId":"next-day","generation":1})");
    start("next-day");
    binary_message(1, initial + page({"next-day"}));
    assert(packets.back().first == "next-day");
    text(R"({"type":"turn.audio.done","turnId":"next-day"})");
    text(R"({"type":"turn.audio.start","turnId":"pcm","encoding":"pcm","sampleRate":24000})");
    binary_message(0, std::string("\x01", 1));
    binary_message(0, std::string("\x02\x03\x04", 3));
    text(R"({"type":"turn.audio.done","turnId":"pcm"})");
    assert(packets.back() == std::make_pair(std::string("\x01\x02\x03\x04", 4), 24000));
    assert(!terminals.back());
    text(R"({"type":"turn.audio.start","turnId":"bad-pcm","encoding":"pcm","sampleRate":24000})");
    binary_message(0, "x");
    text(R"({"type":"turn.audio.done","turnId":"bad-pcm"})");
    assert(terminals.back());
    // Both overlap completion orders, duplicate starts/terminals, and unknown terminals.
    for (bool reverse : {false, true}) {
        text(R"({"type":"turn.started","turnId":"A"})");
        const auto once = cognition.size();
        text(R"({"type":"turn.started","turnId":"A"})");
        assert(cognition.size() == once);
        text(R"({"type":"turn.started","turnId":"B"})");
        text(reverse ? R"({"type":"turn.completed","turnId":"A"})" : R"({"type":"turn.aborted","turnId":"B"})");
        assert(cognition.back() == CognitionState::Thinking);
        text(R"({"type":"turn.completed","turnId":"unknown"})");
        text(reverse ? R"({"type":"turn.completed","turnId":"B"})" : R"({"type":"turn.aborted","turnId":"A"})");
        assert(cognition.back() == CognitionState::Idle);
        const auto done = cognition.size();
        text(R"({"type":"turn.completed","turnId":"A"})");
        text(R"({"type":"turn.completed","turnId":"B"})");
        assert(cognition.size() == done);
    }
    // Actual producer order: attachment and ready stamp epoch before reconstruction.
    text(R"({"type":"session.attached","sessionId":"same","generation":1,"epoch":40})");
    text(R"({"type":"session.ready","sessionId":"connection","epoch":40})");
    start("old-journal");
    binary_message(100, initial + page({"old-journal"}));
    text(R"({"type":"turn.started","turnId":"old-cognition","seq":101,"epoch":40})");
    text(R"({"type":"session.attached","sessionId":"same","generation":1,"epoch":41})");
    assert(down.wire_.epoch == 41 && down.wire_.last_seq == 0);
    assert(down.wire_.audio_turn.empty() && down.wire_.cognition_turns.empty());
    text(R"({"type":"session.ready","sessionId":"connection","epoch":41})");
    start("reconstructed");
    binary_message(2, initial + page({"reconstructed"}));
    assert(packets.back().first == "reconstructed" && down.wire_.epoch == 41);
    text(R"({"type":"turn.audio.done","turnId":"reconstructed"})");
    text(R"({"type":"turn.started","turnId":"ready-reset"})");
    text(R"({"type":"session.ready","sessionId":"connection","epoch":42})");
    assert(down.wire_.epoch == 42 && down.wire_.last_seq == 0 && down.wire_.cognition_turns.empty());
    start("after-ready"); binary_message(1, initial + page({"after-ready"}));
    assert(packets.back().first == "after-ready");
    text(R"({"type":"turn.audio.done","turnId":"after-ready"})");
    // PCM converter input is invariant under arbitrary transport fragments.
    const std::string pcm_bytes(1026, 'p');
    for (size_t width : {1u, 3u, 19u, 960u, 2048u}) {
        const auto begin = packets.size();
        text(R"({"type":"turn.audio.start","turnId":"fragmented-pcm","encoding":"pcm","sampleRate":48000})");
        for (size_t pos = 0; pos < pcm_bytes.size(); pos += width)
            binary_message(0, pcm_bytes.substr(pos, width));
        text(R"({"type":"turn.audio.done","turnId":"fragmented-pcm"})");
        assert(packets.size() == begin + 2);
        assert(packets[begin] == std::make_pair(pcm_bytes.substr(0, 960), 48000));
        assert(packets[begin + 1] == std::make_pair(pcm_bytes.substr(960), 48000));
    }
    text(R"({"type":"turn.audio.start","turnId":"unsupported","encoding":"pcm","sampleRate":12345})");
    assert(down.status() != SdkStatus::Ready);
    SentientWsProtocol bounded({}); bounded.status_ = SdkStatus::Ready;
    for (size_t i = 0; i <= SentientWireState::kMaxCognitionTurns; ++i) {
        auto json = std::string("{\"type\":\"turn.started\",\"turnId\":\"") + std::to_string(i) + "\"}";
        bounded.handle_text(json.data(), json.size());
    }
    assert(bounded.status() != SdkStatus::Ready && bounded.wire_.cognition_turns.empty());
    return 0;
}
