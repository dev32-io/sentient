---
paths:
  - "esp32/cube/lvgl-sim/**"
  - "esp32/cube/firmware/ui-shared/**"
---
# ESP32 Cube LVGL Sim Rules

> When a rule is unclear, read `esp32/cube/lvgl-sim/README.md`.

- `lvgl-sim/` is a HOST SDL2 build for UI iteration. Pins LVGL `v9.5.0`
  (matches the device's managed component). Built with `cmake --build build -j`
  after a one-time `cmake -B build -S . -DSDL2_DIR=$(brew --prefix sdl2)/lib/cmake/SDL2`.

- Two run modes: windowed (`./build/sentient_cube_lvgl_sim`) and headless
  agent-driveable (`./build/sentient_cube_lvgl_sim --snapshot PATH`). Headless
  renders for ~500 ms simulated time, dumps a 466×466 RGB888 PNG, exits
  without opening an SDL2 window. Use the headless path from subagent
  contexts and `Read` the PNG directly.

- `firmware/ui-shared/` is the shared widget code. Pure LVGL public API only —
  never include `esp_log.h`, FreeRTOS headers, `esp_lcd_*`, or any platform
  header here. Source MUST compile on both device and sim targets.

- Device-side LVGL config comes from Kconfig (`firmware/sdkconfig.defaults` +
  xiaozhi's stock Kconfig + the managed component's Kconfig). Sim-side LVGL
  config lives at `lvgl-sim/lv_conf.h`, hand-mirrored from those Kconfig
  defaults. The two MUST move in lockstep on LVGL bumps — see the
  `lvgl-sim/README.md` "Update flow" section for the procedure.

- The sim is a UI-iteration aid only. Per design spec §7 scope guard, device
  smoke is ALWAYS required. A green sim run never replaces a device flash +
  smoke. The sim does NOT exercise `esp_lcd_panel_draw_bitmap` callback timing,
  LVGL display-lock contention with the `esp32_devtool_companion`, real DMA
  refresh, panel-IO latency, or `touch.tap` EVT emission on tap.

- The sim is structurally blind to xiaozhi's `LcdDisplay`-base-class widgets
  that the device's parent `SpiLcdDisplay::SetupUI()` creates. Destructive
  lifecycle ops like `lv_obj_clean(lv_screen_active())` look fine in the sim
  but panic on device. Always build new screens via `lv_obj_create(NULL)` +
  `lv_screen_load(scr)`.

- Bumping LVGL requires touching BOTH `firmware/main/idf_component.yml` AND
  `lvgl-sim/lv_conf.h` + `lvgl-sim/README.md` pinned-version table + re-cloning
  `lvgl-sim/lvgl/` at the new tag. Commit as one
  `chore(esp32-cube/lvgl): bump LVGL to v<NEW>` change.
