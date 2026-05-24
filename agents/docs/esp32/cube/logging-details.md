# ESP32 Cube Logging — Details & Examples

## net_logger lazy socket

`net_logger_init()` is called early in `SentientCubeBoard` initialization — before
WiFi connects. At that point the lwIP TCPIP thread mailbox (`tcpip_send_msg_wait_sem`)
is not yet initialized. Calling `socket(AF_INET, SOCK_DGRAM, 0)` at init time and
then `sendto()` against it triggers the assertion:

```
assert failed: tcpip_send_msg_wait_sem IDF/components/lwip/lwip/src/api/tcpip.c:455
```

The fix (see `net_logger.cc:42-65`): `g_sock_fd` is initialized to `-1`. The sender
task polls `sta_associated()` (wraps `esp_wifi_sta_get_ap_info()`) each iteration.
`esp_wifi_sta_get_ap_info()` is safe to call at any time and only returns `ESP_OK`
once WiFi STA is fully associated to an AP — by which point lwIP is fully up and
`socket()`/`sendto()` are safe. The socket is created lazily on the first message
after association.

---

## device_id token

The gateway UDP sink (configured in `gateway/config.yaml`) extracts `device_id=<id>`
from each incoming log line to route the log to the correct device's log file.

`net_logger`'s `our_vprintf` hook checks every formatted log line:
```c
if (strstr(buf, "device_id=") == nullptr && g_device_id[0] != '\0') {
    snprintf(outbuf, sizeof(outbuf), "device_id=%s %s", g_device_id, buf);
}
```

The `device_id` value is set at `net_logger_init()` call time from the baked creds.
Application code does NOT need to include `device_id=...` in individual `ESP_LOGx`
calls. If it's already present in the line (e.g., a manually structured log entry),
the injection is skipped.

---

## Pre-WiFi gap

All `ESP_LOGx` output between boot and WiFi STA association goes to USB-CDC only.
`net_logger`'s sender task dequeues lines and lazy-creates the socket only after
`sta_associated()` is true. Lines emitted before that point are enqueued; if the
queue fills before WiFi is up, overflow lines are dropped (best-effort).

On a typical cold boot with known SSID + PSK the association takes ~2-3s. The
gateway log file for a device will have a gap covering that window. This is expected
and acceptable — the USB-CDC `monitor.sh` log captures the full boot sequence.

---

## Checkpoint markers via direct printf

`agent_console_checkpoint(label)` (declared in `agent_console.h`) emits:
```
>>> CHECKPOINT <label> <ts_us>
```

It uses `printf(...)` directly, NOT `ESP_LOGx`. This is intentional:
- Checkpoints must appear on USB-CDC for the HIL `SerialDut.expect()` parser.
- `net_logger`'s vprintf hook runs AFTER `g_prev_vprintf` (the original USB-CDC
  vprintf), so ESP_LOG lines reach USB-CDC too — but the hook also enqueues them
  for UDP. Checkpoint markers have no business in the gateway UDP log stream.
- `printf` bypasses the hook entirely, ensuring checkpoints never reach net_logger.

Same applies to `>>> READY`, `<<< RSP`, and `<<< EVT` — all use `printf`.

---

## Example: structured log at a boundary

```cpp
static const char* TAG = "sentient.cube.board";

ESP_LOGI(TAG, "ws-connected device_id=%s cycle_id=%s",
         kDeviceId, current_cycle_id);

ESP_LOGD(TAG, "audio-chunk bytes=%d queue_depth=%d",
         chunk_size, queue_uxMessagesWaiting(g_audio_q));

ESP_LOGW(TAG, "ws-reconnect reason=timeout attempt=%d", attempt);
```

The gateway log file receives lines like:
```
I (12345) sentient.cube.board: ws-connected device_id=cube-001 cycle_id=cyc-abc123
```
