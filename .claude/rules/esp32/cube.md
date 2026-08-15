---
paths:
  - "esp32/cube/**"
  - "shared/cube-sdk/**"
---
# ESP32 Cube guardrails

- Firmware is the flat, owned `esp32/cube/firmware/` tree. Use `esp32-devtool` for host/debug operations; do not add ad-hoc shell, monitor, flash, or serial scripts.
- Constructor-registered firmware verbs/components require `WHOLE_ARCHIVE`, or linker elimination can silently empty the registry.
- `firmware/ui-shared` uses only public LVGL APIs and must compile for both device and simulator. Never include ESP-IDF, FreeRTOS, or platform headers there.
- The simulator accelerates UI iteration but never replaces device smoke. Avoid destructive active-screen cleanup; create and load a new screen because device-only parent widgets may exist.
- Flash once per diagnosed smoke unit. Inspect the daemon ring, UI tree, HTTP screenshot, and decoded panic addresses before deciding to flash. Never flash a wedged cube.
- The devtool daemon owns USB-CDC serial. Do not run `idf.py monitor` or open pyserial beside it; use the daemon ring and devtool commands.
- AXP2101 `PowerOff()` is non-volatile; never call it. Preserve the established PMIC voltage/register order and safe touch callback.
- Never log credentials, tokens, transcripts, or audio. `printf` is reserved for documented protocol/checkpoint markers.

When a rule is unclear, read the focused details in `agents/docs/esp32/cube/` (especially `build-details.md`, `flash-discipline-details.md`, `logging-details.md`, and `testing-details.md`).
