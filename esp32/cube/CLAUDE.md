# ESP32 Cube

Voice frontend for the Waveshare ESP32-S3-Touch-AMOLED-2.16. It uses WebSocket/PASETO to reach the local gateway. Firmware is vendored and edited in place under `firmware/`; `esp32-devtool` is the only host debug/flash interface.

## Key paths

- `firmware/main/boards/sentient-cube/` — board implementation.
- `firmware/ui-shared/` — LVGL code shared with the host simulator.
- `lvgl-sim/` — SDL2 snapshot loop for UI iteration.
- `tests/hil/` — real-hardware tests using project fixtures.
- `docs/README.md` and `docs/build-profiles.md` — developer and release procedures.

## Hardware invariants

Never call AXP2101 `PowerOff()`, disturb the established PMIC initialization order, or replace `SafeTouchReadCb` with the vendor fatal touch callback. The calibrated CST9217 flags are `{swap_xy=1, mirror_x=0, mirror_y=1}`. `CONFIG_NEWLIB_NANO_FORMAT=y` does not support `%lld`.

Use the simulator for fast UI iteration, but finish with one diagnosed device smoke. Inspect the `esp32-devtool` daemon ring and decode panic addresses before considering another flash.
