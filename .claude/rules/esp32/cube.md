---
paths:
  - "esp32/cube/**"
  - "shared/cube-sdk/**"
---
# ESP32 Cube guardrails

- Firmware is an owned flat ESP-IDF tree. New host/debug capabilities go through `esp32-devtool`; do not add ad-hoc shell or serial scripts.
- Constructor-registered components require `WHOLE_ARCHIVE`, or linker elimination silently empties the registry.
- `firmware/ui-shared` uses only public LVGL APIs and must compile for both device and simulator. Never include ESP-IDF/FreeRTOS/platform headers there.
- The simulator accelerates UI iteration but never replaces device smoke. Avoid destructive active-screen cleanup; create and load a new screen because device-only parent widgets may exist.
- Flash once per diagnosed smoke unit. Do not flash to inspect state or rerun blindly; inspect the daemon ring, UI tree, screenshot, and decoded panic addresses first. Never flash a wedged cube.
- The daemon owns serial. Do not run `idf.py monitor` beside it or open pyserial without DTR/RTS disabled.
- AXP2101 `PowerOff()` is non-volatile; never call it. Preserve the established PMIC voltage/register order and safe touch callback.
- Never log credentials, tokens, transcripts, or audio. `printf` is reserved for the documented agent-console protocol markers.
