#include "log_relay.h"

#include <cerrno>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <cstdlib>

#include <atomic>

#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

#include <lwip/sockets.h>
#include <lwip/inet.h>
#include <esp_log.h>
#include <esp_wifi.h>

#include "sdkconfig.h"

namespace {

constexpr size_t kLineBuf      = 512;
constexpr size_t kMaxDeviceId  = 32;
constexpr size_t kSenderStack  = 4 * 1024;
constexpr int    kQueueDepth   = 64;
constexpr int    kDropLogEvery = 100;

static const char* TAG = "sentient.cube.devtool.relay";

int g_sock_fd = -1;
QueueHandle_t g_log_q = nullptr;
char g_device_id[kMaxDeviceId] = {0};
struct sockaddr_in g_dest_addr;
vprintf_like_t g_prev_vprintf = nullptr;
bool g_initialized = false;
std::atomic<int> g_drop_count{0};
bool g_first_send_logged = false;
bool g_socket_create_logged = false;

// Lazy-create the UDP socket the FIRST time WiFi STA is associated. Creating
// the socket at module init time triggered an lwIP assert
// `tcpip_send_msg_wait_sem ... Invalid mbox` — lwIP's TCPIP thread mbox
// isn't initialized until WiFi/STA is up, so a sendto() against an
// "open" socket from before that point hits the uninitialized mbox path
// and asserts, panic-rebooting the cube.
//
// Safe approach: poll esp_wifi_sta_get_ap_info() each iteration. That call
// is safe at any time and only returns ESP_OK once STA is associated to an
// AP — by which point lwIP is fully up and socket()/sendto() are safe.
static bool sta_associated(void) {
    wifi_ap_record_t info;
    return esp_wifi_sta_get_ap_info(&info) == ESP_OK;
}

void sender_task(void* /*arg*/) {
    ESP_LOGI(TAG, "task.start");
    char* line = nullptr;
    for (;;) {
        if (xQueueReceive(g_log_q, &line, portMAX_DELAY) == pdTRUE && line != nullptr) {
            // Lazy-create the socket only after WiFi STA is associated.
            if (g_sock_fd < 0 && sta_associated()) {
                g_sock_fd = ::socket(AF_INET, SOCK_DGRAM, 0);
                if (g_sock_fd >= 0) {
                    if (!g_socket_create_logged) {
                        g_socket_create_logged = true;
                        ESP_LOGI(TAG, "task.socket_created fd=%d", g_sock_fd);
                    }
                } else if (!g_socket_create_logged) {
                    g_socket_create_logged = true;
                    ESP_LOGE(TAG, "task.socket_create_failed errno=%d", errno);
                }
            }
            if (g_sock_fd >= 0) {
                // Best-effort send. Errors (no route yet, EHOSTUNREACH) are
                // normal pre-DHCP — ignore.
                int n = sendto(g_sock_fd, line, std::strlen(line), 0,
                               reinterpret_cast<struct sockaddr*>(&g_dest_addr),
                               sizeof(g_dest_addr));
                if (n >= 0) {
                    if (!g_first_send_logged) {
                        g_first_send_logged = true;
                        ESP_LOGI(TAG, "task.first_send_ok line_len=%d",
                                 (int)std::strlen(line));
                    }
                } else {
                    ESP_LOGD(TAG, "task.send_failed errno=%d", errno);
                }
            }
            std::free(line);
        }
    }
}

int our_vprintf(const char* fmt, va_list args) {
    // Recursion guard: any ESP_LOGx emitted from within our_vprintf (or from
    // sender_task / init paths after the hook is installed) re-enters this
    // function. If already inside, write only to the underlying USB-CDC sink
    // and return — DO NOT format twice, DO NOT enqueue again.
    static thread_local bool in_vprintf = false;
    if (in_vprintf) {
        va_list args_copy;
        va_copy(args_copy, args);
        int rc = (g_prev_vprintf != nullptr) ? g_prev_vprintf(fmt, args_copy) :
                                                std::vprintf(fmt, args_copy);
        va_end(args_copy);
        return rc;
    }
    in_vprintf = true;

    // Tee to USB-CDC first.
    va_list args_copy;
    va_copy(args_copy, args);
    int rc = (g_prev_vprintf != nullptr) ? g_prev_vprintf(fmt, args_copy) :
                                            std::vprintf(fmt, args_copy);
    va_end(args_copy);

    if (g_log_q == nullptr) {
        in_vprintf = false;
        return rc;
    }

    // Format into a stack buffer for transformation.
    char buf[kLineBuf];
    int n = std::vsnprintf(buf, sizeof(buf), fmt, args);
    if (n <= 0) {
        in_vprintf = false;
        return rc;
    }
    if (static_cast<size_t>(n) >= sizeof(buf)) n = sizeof(buf) - 1;

    // Strip trailing newline (UDP datagram shouldn't carry it).
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) {
        buf[--n] = '\0';
    }

    // Inject device_id= token if missing.
    char outbuf[kLineBuf];
    if (std::strstr(buf, "device_id=") == nullptr && g_device_id[0] != '\0') {
        int m = std::snprintf(outbuf, sizeof(outbuf), "device_id=%s %s",
                              g_device_id, buf);
        if (m <= 0 || static_cast<size_t>(m) >= sizeof(outbuf)) {
            in_vprintf = false;
            return rc;
        }
        n = m;
    } else {
        std::memcpy(outbuf, buf, n);
        outbuf[n] = '\0';
    }

    char* heap_line = static_cast<char*>(std::malloc(n + 1));
    if (heap_line == nullptr) {
        in_vprintf = false;
        return rc;
    }
    std::memcpy(heap_line, outbuf, n + 1);

    if (xQueueSend(g_log_q, &heap_line, 0) != pdTRUE) {
        // Queue full — drop the line to keep the log path lossy-but-fast.
        std::free(heap_line);
        int count = g_drop_count.fetch_add(1, std::memory_order_relaxed) + 1;
        if (count % kDropLogEvery == 0) {
            // Emit a drop notice. The recursion guard above is set, so this
            // ESP_LOGW (when it re-enters our_vprintf via the hook) will only
            // tee to USB-CDC via g_prev_vprintf and NOT enqueue — which is
            // exactly what we want when the queue is already full.
            ESP_LOGW(TAG, "queue_full dropped=%d", count);
        }
    }
    in_vprintf = false;
    return rc;
}

}  // namespace

extern "C" void devtool_log_relay_start(const char* host, int port) {
    if (g_initialized) return;
    if (host == nullptr || port == 0) {
        ESP_LOGE(TAG, "start.failed reason=bad_args");
        return;
    }

    ESP_LOGI(TAG, "start.begin host=%s port=%d queue_depth=%d",
             host, port, kQueueDepth);

    // Resolve dest. v1 only supports literal IPv4.
    std::memset(&g_dest_addr, 0, sizeof(g_dest_addr));
    g_dest_addr.sin_family = AF_INET;
    g_dest_addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &g_dest_addr.sin_addr) != 1) {
        ESP_LOGE(TAG, "start.failed reason=inet_pton_failed");
        return;
    }

    // Socket is lazy-created in sender_task once lwIP is up — see comment
    // there. Creating socket() here at constructor time crashed lwIP because
    // the TCPIP mbox isn't initialized this early in app boot.
    g_sock_fd = -1;

    g_log_q = xQueueCreate(kQueueDepth, sizeof(char*));
    if (g_log_q == nullptr) {
        ESP_LOGE(TAG, "start.failed reason=queue_create_failed");
        return;
    }
    ESP_LOGI(TAG, "start.queue_created");

    BaseType_t ok = xTaskCreate(sender_task, "devtool-relay", kSenderStack,
                                nullptr, tskIDLE_PRIORITY + 1, nullptr);
    if (ok != pdPASS) {
        vQueueDelete(g_log_q);
        g_log_q = nullptr;
        ESP_LOGE(TAG, "start.failed reason=task_create_failed");
        return;
    }
    ESP_LOGI(TAG, "start.task_created");

    g_prev_vprintf = esp_log_set_vprintf(&our_vprintf);
    ESP_LOGI(TAG, "start.vprintf_hooked prev=%p", (void*)g_prev_vprintf);
    g_initialized = true;
}

extern "C" void devtool_log_relay_stop(void) {
    // v1 leaves resources up for app lifetime.
}
