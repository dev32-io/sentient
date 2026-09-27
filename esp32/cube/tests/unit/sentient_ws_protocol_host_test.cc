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
std::atomic<int> mock_client_stops{0};
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

int main() {
    auto exercise = [](bool binary_fails, bool end_fails, bool cancel = false) {
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
        std::thread release([&] {
            if (cancel) protocol.cancel_streaming();
            else protocol.stop_streaming();
            stopped = true;
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        assert(!stopped && mock_text.find("audio.end") == std::string::npos);
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        release.join();
        assert(stopped);
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

    std::vector<std::string> transcripts;
    SentientWsProtocolConfig transcript_cfg;
    transcript_cfg.on_transcript = [&](const std::string& text) { transcripts.push_back(text); };
    SentientWsProtocol snapshot(std::move(transcript_cfg));
    snapshot.status_ = SdkStatus::Ready;
    auto feed = [&](const std::string& json) {
        esp_websocket_event_data_t e{};
        e.op_code = 1; e.fin = true;
        e.data_ptr = json.data(); e.data_len = e.payload_len = static_cast<int>(json.size());
        SentientWsProtocol::ws_event_handler(&snapshot, nullptr, WEBSOCKET_EVENT_DATA, &e);
    };
    feed(R"({"type":"conversation.snapshot","items":[{"kind":"user","content":"older"},{"kind":"user","content":42},{"kind":"user","content":"first capture"},{"kind":"assistant","content":"reply"}]})");
    assert(snapshot.last_transcript() == "first capture" && transcripts == std::vector<std::string>{"first capture"});
    feed(R"({"type":"conversation.entry","item":{"kind":"user","content":"live"}})");
    assert(snapshot.last_transcript() == "live" && transcripts.back() == "live");
    SentientWsProtocol::ws_event_handler(&snapshot, nullptr, WEBSOCKET_EVENT_DISCONNECTED, nullptr);
    snapshot.status_ = SdkStatus::Ready; // new attachment
    feed(R"({"type":"conversation.snapshot","items":[{"kind":"user","content":"reconnected"}]})");
    assert(snapshot.last_transcript() == "reconnected" && transcripts.back() == "reconnected");
    const size_t delivered = transcripts.size();
    feed(R"({"type":"conversation.snapshot","items":{}})");
    feed(R"({"type":"conversation.snapshot","items":[{"kind":"user","content":null}]})");
    feed(R"({"type":"conversation.snapshot","items":[{"kind":3,"content":"wrong"}]})");
    feed(R"({"type":"conversation.snapshot"})");
    feed(std::string(R"({"type":"conversation.snapshot","items":[{"kind":"user","content":")") +
         std::string(BoundedWsMessage::kLimit, 'x') + R"("}]})");
    assert(transcripts.size() == delivered && snapshot.last_transcript() == "reconnected");
    feed(R"({"type":"conversation.snapshot","items":[]})");
    assert(snapshot.last_transcript().empty() && transcripts.size() == delivered + 1 && transcripts.back().empty());
    feed(R"({"type":"conversation.entry","item":{"kind":"user","content":"stale"}})");
    const size_t before_replacement = transcripts.size();
    feed(R"({"type":"conversation.snapshot","items":[{"entryId":"a1","ts":1,"kind":"assistant","content":"reply"},{"entryId":"t1","ts":2,"kind":"trigger","source":"task","summary":"done"}]})");
    assert(snapshot.last_transcript().empty() && transcripts.size() == before_replacement + 1 && transcripts.back().empty());
    feed(R"({"type":"conversation.entry","item":{"kind":"user","content":"keep"}})");
    const size_t before_malformed = transcripts.size();
    feed(R"({"type":"conversation.snapshot","items":[{"kind":"assistant","content":null}]})");
    feed(R"({"type":"conversation.snapshot","items":[{"kind":"trigger","summary":"missing source"}]})");
    assert(snapshot.last_transcript() == "keep" && transcripts.size() == before_malformed);

    std::vector<std::pair<std::string, int>> packets;
    SentientWsProtocolConfig down_cfg;
    down_cfg.on_playback_frame = [&](const uint8_t* data, size_t len, int rate) {
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
    assert(flush.size() > BoundedWsMessage::kLimit);
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
}
