#define main existing_protocol_regressions
#include "sentient_ws_protocol_host_test.cc"
#undef main
#include <new>

// Fail real C++ allocations, separately from cJSON's C allocator. No parser stub.
static std::atomic<int> allocation_countdown{-1}, allocation_faults{0}, json_live{0};
static std::atomic<bool> persistent_fault{false};
void* operator new(size_t size) {
    int left = allocation_countdown.load();
    if (left >= 0) {
        if (left == 0) {
            if (!persistent_fault) allocation_countdown = -1;
            ++allocation_faults;
            throw std::bad_alloc();
        }
        --allocation_countdown;
    }
    if (void* p = malloc(size ? size : 1)) return p;
    throw std::bad_alloc();
}
void operator delete(void* p) noexcept { free(p); }
void* operator new[](size_t n) { return ::operator new(n); }
void operator delete[](void* p) noexcept { free(p); }
static void* json_alloc(size_t size) { void* p = malloc(size); if (p) ++json_live; return p; }
static void json_free(void* p) { if (p) --json_live; free(p); }

static void data(SentientWsProtocol& sdk, const char* bytes, bool fin = true, uint8_t op = 1) {
    esp_websocket_event_data_t event{};
    event.op_code = op; event.fin = fin; event.data_ptr = bytes;
    event.data_len = event.payload_len = bytes ? strlen(bytes) : 0;
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_DATA, &event);
}
static void wait_for(const std::function<bool()>& ready) {
    for (int i = 0; i < 2000 && !ready(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    assert(ready());
}
static void connected_and_ready(SentientWsProtocol& sdk) {
    std::lock_guard<std::mutex> receiving(sdk.client_->receive_mutex);
    SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
    assert(sdk.status() == SdkStatus::Authenticating);
    data(sdk, R"({"type":"auth.ok"})");
    assert(!sdk.inbound_.framing_error && sdk.status() == SdkStatus::Authenticating);
    data(sdk, R"({"type":"session.ready","epoch":7})");
    assert(sdk.status() == SdkStatus::Ready && sdk.wire_.epoch == 7);
}

// Pause inside the actual interrupt send while real SDK worker retires its client.
static void interrupt_lifetime_regressions() {
    for (bool reconnect : {false, true}) {
        std::atomic<int> starts{0};
        SentientWsProtocolConfig cfg;
        cfg.gateway_url = "wss://localhost/test"; cfg.device_id = "fixture";
        cfg.on_start_result = [&](const char*, esp_err_t code) { if (code == ESP_OK) ++starts; };
        SentientWsProtocol sdk(std::move(cfg));
        assert(sdk.connect() == ESP_OK);
        connected_and_ready(sdk);
        std::mutex mutex;
        std::condition_variable cv;
        bool entered = false, release = false;
        mock_text_send_hook = [&] {
            std::unique_lock<std::mutex> lock(mutex);
            entered = true; cv.notify_all();
            assert(cv.wait_for(lock, std::chrono::seconds(3), [&] { return release; }));
        };
        const int destroyed = mock_client_destroys;
        std::thread sender([&] { sdk.interrupt(); });
        {
            std::unique_lock<std::mutex> lock(mutex);
            assert(cv.wait_for(lock, std::chrono::seconds(2), [&] { return entered; }));
        }
        std::thread teardown;
        if (reconnect) {
            sdk.set_status(SdkStatus::Reconnecting);
            xTaskNotify(sdk.worker_, 1, eSetBits);
        } else {
            teardown = std::thread([&] { sdk.disconnect(); });
            wait_for([&] { return sdk.stopping_.load(); });
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        assert(mock_client_destroys == destroyed && starts == 1);
        { std::lock_guard<std::mutex> lock(mutex); release = true; cv.notify_all(); }
        sender.join();
        if (teardown.joinable()) teardown.join();
        if (reconnect) wait_for([&] { return starts == 2; });
        assert(mock_client_destroys == destroyed + 1);
        mock_text_send_hook = {};
        sdk.disconnect();
    }
    // Contended interrupt cancels on disconnect/status loss or bounded deadline.
    for (int reason = 0; reason < 3; ++reason) {
        SentientWsProtocol sdk({}); sdk.status_ = SdkStatus::Ready;
        assert(!sdk.pumping_.test_and_set());
        const auto before = mock_text;
        std::thread sender([&] { sdk.interrupt(); });
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
        if (reason == 0) sdk.stopping_ = true;
        if (reason == 1) sdk.set_status(SdkStatus::Reconnecting);
        if (reason == 2) mock_ticks_extra += 6000;
        sender.join();
        assert(mock_text == before);
        assert(sdk.pumping_.test_and_set()); // Waiter cannot release another sender's fence.
        sdk.pumping_.clear();
        mock_ticks_extra = 0;
    }
    // Acquiring a free fence is not permission to send after teardown started.
    SentientWsProtocol sdk({}); sdk.status_ = SdkStatus::Ready; sdk.stopping_ = true;
    const auto before = mock_text;
    sdk.interrupt();
    assert(mock_text == before && !sdk.pumping_.test_and_set());
    sdk.pumping_.clear();
}

int main() {
    interrupt_lifetime_regressions();
    cJSON_Hooks hooks{json_alloc, json_free};
    cJSON_InitHooks(&hooks);
    // These start the real SDK worker. Stub stop emits only FINISH and joins
    // event delivery; no invented DISCONNECTED event on malformed/timeout paths.
    for (int reason = 0; reason < 4; ++reason) {
        std::atomic<int> starts{0};
        SentientWsProtocolConfig cfg;
        cfg.gateway_url = "wss://localhost/test"; cfg.device_id = "fixture";
        cfg.on_start_result = [&](const char* phase, esp_err_t code) {
            if (code == ESP_OK && strcmp(phase, "started") == 0) ++starts;
        };
        SentientWsProtocol sdk(std::move(cfg));
        assert(sdk.connect() == ESP_OK && starts == 1);
        if (reason != 1) connected_and_ready(sdk);
        {
            std::lock_guard<std::mutex> receiving(sdk.client_->receive_mutex);
            if (reason == 0) {
                data(sdk, R"({"type":"turn.audio.start","turnId":"old","encoding":"opus","sampleRate":48000})");
                std::string binary(9, '\0'); binary[8] = 1; binary += "Og";
                esp_websocket_event_data_t e{};
                e.op_code = 2; e.fin = true; e.data_ptr = binary.data(); e.data_len = e.payload_len = binary.size();
                SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_DATA, &e);
                assert(sdk.demuxer_->ctx_.bytes_needed == 2);
                data(sdk, R"({"type":"pong","items":[1,]})");
            } else {
                if (reason == 1) SentientWsProtocol::ws_event_handler(&sdk, nullptr, WEBSOCKET_EVENT_CONNECTED, nullptr);
                data(sdk, R"({"type":"auth.)", false);
                if (reason == 1) xTaskNotify(sdk.worker_, 2, eSetBits); // Actual ready-timeout worker stop.
                else SentientWsProtocol::ws_event_handler(&sdk, nullptr,
                    reason == 2 ? WEBSOCKET_EVENT_DISCONNECTED : WEBSOCKET_EVENT_CLOSED, nullptr);
            }
        }
        wait_for([&] { return starts.load() == 2; });
        assert(sdk.status() == SdkStatus::Connecting);
        assert(sdk.inbound_.opcode == 0 && !sdk.inbound_.framing_error);
        size_t length = 9;
        assert(sdk.text_envelope_.envelope(length) == nullptr && length == 0);
        if (sdk.demuxer_) assert(sdk.demuxer_->ctx_.bytes_needed == 4);
        connected_and_ready(sdk);
        assert(sdk.start_streaming()); sdk.cancel_streaming();
        sdk.disconnect();
        assert(json_live == 0);
    }

    bool saw_dispatch_fault = false, saw_callback_fault = false, saw_success = false;
    // Sweep allocations AFTER helper consumed complete valid root, before final
    // continuation. Includes turn string, turn-set node/string, callback scheduling.
    for (int fail_at = 0; fail_at < 12; ++fail_at) {
        bool callback_entered = false, error_delivered = false;
        std::vector<std::string> scheduled;
        SentientWsProtocolConfig cfg;
        cfg.on_cognition_status = [&](CognitionState state) {
            if (state == CognitionState::Thinking) {
                callback_entered = true;
                scheduled.push_back(std::string(128, 's'));
            }
        };
        cfg.on_status_change = [&](SdkStatus status) {
            if (status == SdkStatus::Error) {
                std::string scheduling_allocation(128, 'e');
                error_delivered = !scheduling_allocation.empty();
            }
        };
        SentientWsProtocol sdk(std::move(cfg)); sdk.status_ = SdkStatus::Ready;
        data(sdk, R"({"type":"turn.started","turnId":"01234567-0123-4567-8901-012345678901","seq":11})", false);
        assert(!callback_entered && json_live == 0);
        const int before = allocation_faults;
        allocation_countdown = fail_at;
        data(sdk, nullptr, true, 0); // Any exception crossing C event callback fails test.
        allocation_countdown = -1;
        size_t length = 0;
        assert(sdk.text_envelope_.envelope(length) != nullptr && length > 0); // Helper succeeded.
        assert(json_live == 0); // Dispatcher root/children freed on every unwind path.
        if (allocation_faults != before) {
            assert(sdk.status() == SdkStatus::Error && error_delivered);
            assert(sdk.wire_.cognition_turns.empty() && !sdk.streaming_);
            saw_callback_fault |= callback_entered;
            saw_dispatch_fault |= !callback_entered;
        } else {
            assert(sdk.status() == SdkStatus::Ready && scheduled.size() == 1);
            saw_success = true; break;
        }
    }
    assert(saw_dispatch_fault && saw_callback_fault && saw_success);

    // auth.ok also owns an outbound configure object/encoded buffer during dispatch.
    // A send-argument allocation failure must free those along with inbound root.
    {
        SentientWsProtocol sdk({}); sdk.status_ = SdkStatus::Authenticating;
        data(sdk, R"({"type":"auth.ok"})", false);
        const int before = allocation_faults;
        allocation_countdown = 0;
        data(sdk, nullptr, true, 0);
        allocation_countdown = -1;
        assert(allocation_faults == before + 1 && json_live == 0 && sdk.status() == SdkStatus::Error);
    }

    for (bool persistent : {false, true}) {
        std::atomic<int> starts{0}, error_attempts{0}, delivered_errors{0}, playback_attempts{0};
        SentientWsProtocolConfig cfg;
        cfg.gateway_url = "wss://localhost/test"; cfg.device_id = "fixture";
        cfg.on_start_result = [&](const char* phase, esp_err_t code) {
            if (code == ESP_OK && strcmp(phase, "started") == 0) ++starts;
        };
        cfg.on_playback_end = [&](bool) {
            ++playback_attempts;
            std::string callback_allocation(128, 'p');
            assert(!callback_allocation.empty());
        };
        cfg.on_status_change = [&](SdkStatus status) {
            if (status == SdkStatus::Error) {
                ++error_attempts;
                std::string callback_allocation(128, 'e');
                if (!callback_allocation.empty()) ++delivered_errors;
            }
        };
        SentientWsProtocol sdk(std::move(cfg)); assert(sdk.connect() == ESP_OK);
        connected_and_ready(sdk);
        int stops = mock_client_stops, finishes = mock_client_finishes;
        {
            std::lock_guard<std::mutex> receiving(sdk.client_->receive_mutex);
            data(sdk, R"({"type":"turn.audio.start","turnId":"prior","encoding":"pcm","sampleRate":24000})");
            data(sdk, R"({"type":"turn.started","turnId":"01234567-0123-4567-8901-012345678901"})", false);
            persistent_fault = persistent; allocation_countdown = 0;
            data(sdk, nullptr, true, 0);
            assert(sdk.status() == SdkStatus::Error && json_live == 0);
            assert(playback_attempts == 1 && error_attempts == 1);
            assert(delivered_errors == (persistent ? 0 : 1));
            assert(!sdk.start_streaming()); // Allocation-free fail-closed input gate.
        }
        // No allocating test helpers while persistent fault is still armed.
        for (int i = 0; i < 2000 && mock_client_finishes == finishes; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        assert(mock_client_stops == stops + 1 && mock_client_finishes == finishes + 1);
        {
            std::lock_guard<std::mutex> receiving(sdk.client_->receive_mutex);
            assert(sdk.inbound_.opcode == 0); // FINISH-only stop completed.
        }
        assert(starts == 1 && sdk.status() == SdkStatus::Error); // No OOM retry storm.
        allocation_countdown = -1; persistent_fault = false;
        sdk.force_reconnect(); // Explicit recovery only after memory availability restored.
        assert(starts == 2);
        connected_and_ready(sdk);
        data(sdk, R"({"type":"turn.started","turnId":"recovered","seq":1})");
        assert(sdk.wire_.cognition_turns.count("recovered") == 1);
        sdk.disconnect();
        assert(json_live == 0);
    }
    cJSON_InitHooks(nullptr);
}
