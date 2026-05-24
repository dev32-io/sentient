# Agent Console — Details & Examples

## Writing a new verb

Create `esp32/cube/sentient/components/agent_console/verbs/<name>.cc`:

```cpp
// verbs/wifi.cc — wifi.disconnect / wifi.connect verbs.
#include <cJSON.h>
#include "agent_console.h"
#include "dispatcher.h"

namespace {

int handle_wifi_disconnect(const cJSON* /*params*/, cJSON* out_result,
                           int* /*ec*/, const char** /*em*/) {
    esp_wifi_disconnect();
    cJSON_AddBoolToObject(out_result, "ok", true);
    return 0;
}

// Self-registration via constructor attribute. WHOLE_ARCHIVE on the
// agent_console CMakeLists ensures the linker does not dead-code-eliminate
// this .o file even though main has no direct symbol reference to it.
__attribute__((constructor))
void register_wifi_verbs(void) {
    agent_dispatcher_register("wifi.disconnect", handle_wifi_disconnect);
}

}  // namespace
```

Add the file to `idf_component_register(SRCS ...)` in `agent_console/CMakeLists.txt`.

---

## Error code conventions

Standard JSON-RPC 2.0 codes returned by the dispatcher:

| Code   | Meaning         | Trigger                                   |
|--------|-----------------|-------------------------------------------|
| -32700 | Parse error     | Malformed JSON in stdin line              |
| -32600 | Invalid request | Missing `method` or `jsonrpc` field       |
| -32601 | Method not found| No handler registered for the method name |
| -32602 | Invalid params  | Handler-specific param validation failed  |
| -32603 | Internal error  | Handler returned non-zero without setting ec/em |

Custom application-level codes use the `1xxxx` range (e.g., `10001 = wifi not up`).
Set `*ec` and `*em` in the handler and return -1; the dispatcher wraps them.

---

## Long-op pattern

For ops that take > 100ms (WiFi reconnect, audio capture, snapshot encode):

```cpp
int handle_ui_snapshot(const cJSON* params, cJSON* out_result,
                       int* /*ec*/, const char** /*em*/) {
    // Parse params, copy what the task needs onto heap.
    int req_id = ...;  // capture the JSON-RPC id from params if needed for EVT

    BaseType_t ok = xTaskCreate(snapshot_task, "snap", 8192,
                                (void*)(intptr_t)req_id,
                                tskIDLE_PRIORITY + 2, nullptr);
    if (ok != pdPASS) {
        cJSON_AddBoolToObject(out_result, "ok", false);
        return 0;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddBoolToObject(out_result, "in_flight", true);
    return 0;
}

static void snapshot_task(void* arg) {
    // ... do the work ...
    // When done, emit an EVT line:
    printf("<<< EVT {\"method\":\"ui.snapshot\",\"result\":{...}}\n");
    vTaskDelete(nullptr);
}
```

---

## Existing verbs

| Verb           | File           | What it does                                              |
|----------------|----------------|-----------------------------------------------------------|
| `state`        | verbs/state.cc | Returns device state string, wifi_connected, ws_connected |
| `button.toggle`| verbs/button.cc| Simulates a single tap on the toggle button               |
| `wifi.disconnect`| verbs/wifi.cc| Calls esp_wifi_disconnect()                               |
| `wifi.connect` | verbs/wifi.cc  | Calls esp_wifi_connect() with stored credentials          |
| `ws.disconnect`| verbs/ws.cc    | Closes the WebSocket connection                           |
| `restart`      | verbs/restart.cc| Calls esp_restart() after a 100ms delay                  |
| `mark`         | verbs/mark.cc  | Emits a `>>> MARK <label> <ts_us>` line for log correlation|
| `log_level`    | verbs/log_level.cc | Sets ESP_LOGx level for a given tag at runtime        |
| `ui.dump_tree` | verbs/ui.cc    | Walks LVGL object tree and emits JSON structural dump     |
| `ui.snapshot`  | verbs/ui_snapshot.cc | Captures framebuffer as PNG base64 (long-op; in_flight)|

---

## The rapid-CMD parse-error glitch

On the ESP32-S3, the USB-CDC stdin buffer is shared across all reads. When a first
CMD response line (`<<< RSP {...}`) is followed immediately by a second CMD written
to the same open serial session, the `fgets` call in `agent_console.cc` may pick up
trailing `\r\n` bytes from the previous command's wire framing as the start of the
next JSON line. This produces a -32700 parse error on the second CMD.

Symptom:
```
>>> CMD {"jsonrpc":"2.0","method":"state","id":1}
<<< RSP {"jsonrpc":"2.0","id":1,"result":{...}}
>>> CMD {"jsonrpc":"2.0","method":"mark","id":2}
<<< RSP {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}
```

Mitigation used by `CubeDut.cmd()`: each call spawns `_cube_cmd_helper.py` as a
separate subprocess (separate `serial.Serial()` open and `serial.Serial().close()`).
A fresh open always reads from a clean line boundary. Do not "optimize" this by
holding a persistent serial connection across multiple `cmd()` calls.
