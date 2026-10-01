#pragma once
#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <thread>
#include <chrono>
#include <mutex>
#include <condition_variable>
#include <string>
#include <functional>
#include <cassert>
using esp_err_t = int;
constexpr int ESP_OK = 0, ESP_FAIL = -1, ESP_ERR_INVALID_STATE = 1, ESP_ERR_INVALID_ARG = 2, ESP_ERR_NO_MEM = 3;
#define ESP_ERROR_CHECK(x) do { if ((x) != ESP_OK) abort(); } while (0)
#define ESP_LOGI(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_LOGE(...) ((void)0)
#define ESP_LOGD(...) ((void)0)
using TickType_t = uint32_t;
#define pdMS_TO_TICKS(x) (x)
#define pdTRUE 1
#define pdPASS 1
#define portMAX_DELAY UINT32_MAX
extern std::atomic<int> mock_ticks_extra;
inline TickType_t xTaskGetTickCount() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count() + mock_ticks_extra; }
inline void vTaskDelay(int ticks) { std::this_thread::sleep_for(std::chrono::milliseconds(ticks)); }
struct MockTask {};
using TaskHandle_t = MockTask*;
inline int xTaskCreate(void (*fn)(void*), const char*, int, void* arg, int, TaskHandle_t* handle) {
    *handle = new MockTask;
    std::thread(fn, arg).detach();
    return pdPASS;
}
inline void vTaskDelete(void*) {}
extern std::mutex mock_notify_mutex;
extern std::condition_variable mock_notify_cv;
extern uint32_t mock_notifications;
inline int xTaskNotify(TaskHandle_t, uint32_t bits, int) {
    std::lock_guard<std::mutex> lock(mock_notify_mutex);
    mock_notifications |= bits;
    mock_notify_cv.notify_all();
    return 1;
}
inline int xTaskNotifyWait(uint32_t, uint32_t, uint32_t* bits, TickType_t) {
    std::unique_lock<std::mutex> lock(mock_notify_mutex);
    mock_notify_cv.wait(lock, [] { return mock_notifications != 0; });
    *bits = mock_notifications;
    mock_notifications = 0;
    return 1;
}
constexpr int eSetBits = 0;
struct MockSemaphore { std::mutex mutex; std::condition_variable cv; bool ready = false; };
using SemaphoreHandle_t = MockSemaphore*;
inline SemaphoreHandle_t xSemaphoreCreateBinary() { return new MockSemaphore; }
inline void xSemaphoreGive(SemaphoreHandle_t s) { std::lock_guard<std::mutex> lock(s->mutex); s->ready = true; s->cv.notify_all(); }
inline int xSemaphoreTake(SemaphoreHandle_t s, TickType_t t) { std::unique_lock<std::mutex> lock(s->mutex); return s->cv.wait_for(lock, std::chrono::milliseconds(t), [&]{return s->ready;}) ? (s->ready = false, pdTRUE) : 0; }
inline void vSemaphoreDelete(SemaphoreHandle_t s) { delete s; }
struct MockTimer { void (*callback)(void*); void* arg; };
using esp_timer_handle_t = MockTimer*;
struct esp_timer_create_args_t { void (*callback)(void*); void* arg; };
inline esp_err_t esp_timer_create(const esp_timer_create_args_t* a, esp_timer_handle_t* t) { *t = new MockTimer{a->callback, a->arg}; return ESP_OK; }
inline esp_err_t esp_timer_start_once(esp_timer_handle_t t, uint64_t us) { if (us != 10000000) t->callback(t->arg); return ESP_OK; }
inline esp_err_t esp_timer_stop(esp_timer_handle_t) { return ESP_OK; }
inline esp_err_t esp_timer_delete(esp_timer_handle_t t) { delete t; return ESP_OK; }
inline uint32_t esp_random() { static std::atomic<uint32_t> next{42}; return next++; }
inline int esp_crt_bundle_attach(void*) { return 0; }
using esp_event_base_t = const char*;
struct MockClient {
    void (*handler)(void*, esp_event_base_t, int32_t, void*) = nullptr;
    void* context = nullptr;
    std::mutex receive_mutex;
    std::atomic<int> active_sends{0};
};
using esp_websocket_client_handle_t = MockClient*;
struct esp_websocket_client_config_t { const char* uri; bool disable_auto_reconnect; int buffer_size; int task_stack; int network_timeout_ms; const char* cert_pem; int (*crt_bundle_attach)(void*); };
// Pinned esp_websocket_client event fields (including client/context before frame totals).
struct esp_websocket_event_data_t {
    const char* data_ptr; int data_len; bool fin; uint8_t op_code;
    esp_websocket_client_handle_t client; void* user_context;
    int payload_len; int payload_offset;
};
constexpr int WEBSOCKET_EVENT_ANY = 0, WEBSOCKET_EVENT_CONNECTED = 1, WEBSOCKET_EVENT_DATA = 2, WEBSOCKET_EVENT_DISCONNECTED = 3, WEBSOCKET_EVENT_CLOSED = 4, WEBSOCKET_EVENT_FINISH = 5;
using EventHandler = void (*)(void*, esp_event_base_t, int32_t, void*);
inline esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t*) { return new MockClient; }
inline esp_err_t esp_websocket_register_events(esp_websocket_client_handle_t c, int, EventHandler handler, void* context) {
    c->handler = handler; c->context = context; return ESP_OK;
}
inline esp_err_t esp_websocket_client_start(esp_websocket_client_handle_t) { return ESP_OK; }
extern std::atomic<int> mock_client_stops, mock_client_finishes;
inline esp_err_t esp_websocket_client_stop(esp_websocket_client_handle_t c) {
    ++mock_client_stops;
    std::lock_guard<std::mutex> lock(c->receive_mutex);
    if (c->handler) { c->handler(c->context, nullptr, WEBSOCKET_EVENT_FINISH, nullptr); ++mock_client_finishes; }
    return ESP_OK;
}
inline std::atomic<int> mock_client_destroys{0};
inline std::function<void()> mock_text_send_hook;
inline esp_err_t esp_websocket_client_destroy(esp_websocket_client_handle_t c) {
    { std::lock_guard<std::mutex> lock(c->receive_mutex); } // Join last event like pinned destroy.
    assert(c->active_sends == 0);
    ++mock_client_destroys;
    delete c; return ESP_OK;
}
inline bool esp_websocket_client_is_connected(esp_websocket_client_handle_t c) { return c != nullptr; }
extern int mock_binary_result;
extern int mock_binary_sends;
extern bool mock_block_binary;
extern std::mutex mock_mutex;
extern std::condition_variable mock_cv;
extern bool mock_inside_binary;
extern bool mock_release_binary;
extern std::string mock_text;
extern int mock_end_result;
extern int mock_start_result;
inline int esp_websocket_client_send_text(esp_websocket_client_handle_t c, const char* data, int len, TickType_t) {
    if (c) ++c->active_sends;
    if (mock_text_send_hook) mock_text_send_hook();
    mock_text.append(data, len);
    if (c) --c->active_sends;
    if (mock_start_result && std::string(data, len).find("audio.start") != std::string::npos) return -1;
    return mock_end_result && std::string(data, len).find("audio.end") != std::string::npos ? -1 : len;
}
inline int esp_websocket_client_send_bin(esp_websocket_client_handle_t, const char*, int len, TickType_t) {
    std::unique_lock<std::mutex> lock(mock_mutex);
    ++mock_binary_sends;
    mock_inside_binary = true;
    mock_cv.notify_all();
    if (mock_block_binary) mock_cv.wait(lock, []{return mock_release_binary;});
    return mock_binary_result ? -1 : len;
}
