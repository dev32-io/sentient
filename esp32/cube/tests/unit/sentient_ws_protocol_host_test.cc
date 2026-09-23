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

std::atomic<int> mock_ticks_extra{0};
int mock_binary_result = 0;
int mock_binary_sends = 0;
int mock_end_result = 0;
bool mock_block_binary = false;
bool mock_inside_binary = false;
bool mock_release_binary = false;
std::mutex mock_mutex;
std::condition_variable mock_cv;
std::string mock_text;
using namespace sentient::cube;

int main() {
    auto exercise = [](bool binary_fails, bool end_fails) {
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
        std::thread sender([&] { protocol.notify_uplink_available(); });
        { std::unique_lock<std::mutex> lock(mock_mutex);
          mock_cv.wait(lock, [] { return mock_inside_binary; }); }
        std::thread release([&] { protocol.stop_streaming(); stopped = true; });
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
        assert(!stopped && mock_text.find("audio.end") == std::string::npos);
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        sender.join(); release.join();
        assert(stopped);
        if (binary_fails) {
            assert(mock_binary_sends == 1 && mock_text.find("audio.end") == std::string::npos);
            assert(protocol.status() == SdkStatus::Error);
        } else if (end_fails) {
            assert(mock_binary_sends == 2 && mock_text.find("audio.end") != std::string::npos);
            assert(protocol.status() == SdkStatus::Error);
        } else {
            assert(mock_binary_sends == 2 && mock_text.find("audio.end") != std::string::npos);
            assert(protocol.status() == SdkStatus::Ready);
        }
    };
    exercise(false, false);
    exercise(true, false);
    exercise(false, true);
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
        std::thread sender([&] { timed.notify_uplink_available(); });
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
        assert(timed.status() == SdkStatus::Error);
        { std::lock_guard<std::mutex> lock(mock_mutex); mock_release_binary = true; mock_cv.notify_all(); }
        sender.join();
        assert(mock_text.find("audio.end") == std::string::npos);
    }
    mock_ticks_extra = 0;
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
}
