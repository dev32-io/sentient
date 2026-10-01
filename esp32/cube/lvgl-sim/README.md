# Cube shipping-view simulator

SDL2 harness compiles shipping `firmware/ui-shared/cube_views.cc`, companion parser/player, board-independent character descriptors and UI asset adapters at **480×480**. BootView, SetupView and MainView use the same code as firmware; no diagnostic-screen substitute. Mouse press/release runs the shared input boundary with host-only capture counters, never microphone/network/device calls.

Resources use the same read-only paths as the bundled firmware pack. `main/source_resources.h` maps `/companions/cat/companion.json` to the board document, `/companions/cat/<pose>.rgb565` to existing `character/cat-<pose>.rgb565`, and `/ui/<filename>` to existing UI binaries in `character/`. Source bytes remain immutable for each view host's lifetime. No asset cache partition, OTA, downloads or art generation.

## Build and checks

Dependencies: CMake, C/C++17 compiler, SDL2, Python with Pillow (already used by cube host tests), existing IDF cJSON sources, and LVGL **9.5.0** matching `firmware/dependencies.lock`. CMake defaults to the managed LVGL source; override `LVGL_DIR` for a separate matching checkout. It compiles cJSON and existing firmware qrcodegen sources directly, without invoking IDF or touching firmware build output.

From repository root:

```sh
source scripts/env.sh
cmake -S esp32/cube/lvgl-sim -B /tmp/cube-companion-sim \
  -DCJSON_DIR="$HOME/esp/esp-idf/components/json/cJSON" \
  -DSDL2_DIR="$(brew --prefix sdl2)/lib/cmake/SDL2"
cmake --build /tmp/cube-companion-sim -j8
ctest --test-dir /tmp/cube-companion-sim --output-on-failure
```

On Linux omit `SDL2_DIR` when SDL2 is already discoverable. `CJSON_DIR` defaults to `$IDF_PATH/components/json/cJSON` if that environment is exported. Configure separate scratch output; preserve other workers' device builds and existing checkouts.

CTest runs actual parser/player validation, real LVGL view/input/lifecycle checks, and deterministic PNG checks. Snapshot checks compare all non-background cat pixel samples against original RGB565 frames at clip boundaries, verify recording cues, repeatability, boot/error differences, and setup snapshot denial. No setup proof is exported. The focused parser/player check also runs through `tests/unit/test_toggle_button_screen_boundary.py`.

## Run and snapshots

```sh
/tmp/cube-companion-sim/sentient_cube_lvgl_sim
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --scene setup
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --snapshot /tmp/cube-ready.png
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --snapshot /tmp/cube-blink.png --at-ms 3300
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --snapshot /tmp/cube-thinking.png --scene thinking --at-ms 180
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --snapshot /tmp/cube-boot.png --not-ready
/tmp/cube-companion-sim/sentient_cube_lvgl_sim --snapshot /tmp/cube-error.png --boot-error
```

Scenes: ready, setup, sleep, pairing, listening, thinking, speaking, offline, service, account, volume, low, charging. Windowed setup uses disposable synthetic enrollment data. **Setup snapshots are denied**, including synthetic data; no bypass flag. Boot remains resource-independent until explicit readiness; offline enters MainView without Wi-Fi/WS readiness.

Snapshot/self-test mode uses SDL dummy video and a deterministic clock, advancing in bounded 5ms increments to requested elapsed time (0–60000ms). Windowed mode uses wall-clock SDL ticks. PNG output reuses bundled `stb_image_write.h`. Keep artifacts in private scratch storage; these are host renders, not device screenshots.

## Companion v1 and firmware integration

Document fields: `schemaVersion: 1`, bounded `id`, positive integer `revision`, `name`, `canvas {width,height,background: "#RRGGBB"}`, `frames`, `states`, explicit root `fallback` state. Frame entries contain only asset path and `format: "rgb565"`; pixel byte count must exactly match canvas. Native LVGL descriptors never appear in JSON.

State entries are clips `{mode,frames:[{frame,durationMs}],loopFrom?}` or explicit aliases `{fallback: state}`. Modes: `static` (one frame), `once-and-hold` (last frame holds), `loop` (repeats from `loopFrom`, default 0). Optional loop prefix preserves cat thinking's initial 180ms ready pose without replaying it. Missing states use root fallback; unknown alias targets and all fallback cycles are rejected iteratively. Current cat preserves 3600ms sparse blink/tail cycles, 900ms listening/volume blink onset, and 500ms speaking alternation.

Bounds: JSON 16KiB/depth 12; canvas dimensions 1–128; 32 frame references; 16 state entries; 32 steps/clip and 128 total; integer durations 1–60000ms and checked aggregate; path scoped to companion id; exact format/byte sizes. Version, duplicate keys, references, invalid dimensions/numbers, malformed JSON and trailing input are rejected before publication. Platform reader supplies lifetime-stable immutable buffers. Document failure or missing/invalid system art stays in controlled BootView, with no recording/retry loop.

Platform integration (main CMake/application owned separately):

- Add `../ui-shared/companion.cc` and `../ui-shared/cube_views.cc` for cube only.
- Add `boards/sentient-cube` include directory; existing `../ui-shared` include and board `*.cc` glob retain `character_data.cc` and `toggle_button_screen.cc` adapter.
- Reuse existing cJSON and esp_emote_gfx qrcodegen includes/linkage. Remove obsolete linker-symbol art embedding when bundled aliases replace it.
- Keep `sentient_cube_create_toggle_button_screen()` during board SetupUI. It creates only BootView and starts existing poll/mailbox.
- Call `sentient_cube_finish_boot(bool assets_ready)` after pack/font readiness, outside asset preparation. False is terminal controlled error. Lock contention preserves readiness for next poll. Controller adapts `Assets::GetAssetData` only after readiness.

ViewHost owns one active view, input cancellation and navigation; player owns clips separately. Unchanged projections do not restart playback. Exit/sleep cancels owned press and hidden animation. Setup/boot/unavailable states cannot start capture. Physical wake-touch consumption remains board-owned. Firmware icons, battery, recording truth and setup QR are not document-owned. Device opt-in display timing/minimum-heap aggregates remain in platform adapter.

## Limits

Host checks do not prove panel/DMA timing, calibrated touch/wake behavior, LVGL lock contention, PSRAM/internal heap headroom or voice/audio continuity. Current board config and LVGL display setup both use 480×480, matching the simulator; geometry agreement alone is not physical rendering proof. Host text uses LVGL fonts; device adapter hands off the active screen's resolved loaded font at readiness so future MainView text inherits it. BootView remains pack-independent and pairing labels retain explicit 14px fonts. Font-pack coverage and font lifetime remain platform-owned.

Hardware verification requires separately approved local operations through `esp32-devtool`, following [flash discipline](../../../agents/docs/esp32/cube/flash-discipline-details.md). Simulator build/checks authorize no device operation.
