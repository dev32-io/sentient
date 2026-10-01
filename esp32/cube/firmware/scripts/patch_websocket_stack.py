"""Cube-only build-local WS stack placement; protocol/TLS behavior unchanged."""
from pathlib import Path
import hashlib
import sys


def patch(source: str) -> str:
    if hashlib.sha256(source.encode()).hexdigest() != '18041ec37d3456bc1ecb3275a78c3ae64679f57f049b5b05af169ef6b1857c77':
        raise ValueError('WebSocket upstream changed; review Cube stack placement before building')
    source = source.replace('#include "freertos/task.h"', '''#include "freertos/task.h"
#include "freertos/idf_additions.h"
#include "esp_heap_caps.h"''')
    source = source.replace('    vTaskDelete(NULL);', '    vTaskDeleteWithCaps(NULL);')
    source = source.replace('''    if (xTaskCreatePinnedToCore(esp_websocket_client_task,''', '''    /* Cube callbacks only queue/schedule work; flash/NVS writers stay on internal
     * stacks. Preserve stack size and internal TCB, move only stack to PSRAM. */
    if (xTaskCreatePinnedToCoreWithCaps(esp_websocket_client_task,''')
    source = source.replace('''&client->task_handle, client->config->task_core_id) != pdTRUE) {''',
                            '''&client->task_handle, client->config->task_core_id,
                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdTRUE) {''')
    source = source.replace('''        ESP_LOGE(TAG, "Error create websocket task");
        xEventGroupSetBits(client->status_bits, STOPPED_BIT);
        return ESP_FAIL;''', '''        ESP_LOGE(TAG, "Error create websocket task");
        xEventGroupSetBits(client->status_bits, STOPPED_BIT);
        return ESP_ERR_NO_MEM;''')
    return source


if __name__ == '__main__':
    source, destination = map(Path, sys.argv[1:])
    result = patch(source.read_text())
    if not destination.exists() or destination.read_text() != result:
        destination.write_text(result)
