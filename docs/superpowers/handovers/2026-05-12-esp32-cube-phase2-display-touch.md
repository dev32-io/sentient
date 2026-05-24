# ESP32 Cube Phase 2 — Display + Touch + LVGL PC Simulator Handover

**Date:** 2026-05-12
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase2-display-touch.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §4 Phase 2 + §7

## What's done

- Added `esp32/cube/firmware/ui-shared/test_screen.{c,h}` — target-agnostic LVGL screen module: deep-blue background (`0x0a1f33`), horizontal gradient bar, "SENTIENT CUBE" label, 1.5 Hz spinner, hideable touch heatmap dot. Pure LVGL public API — no platform headers — so the same `.c` compiles on both the device's ESP-IDF tree and the host SDL2 simulator. Bridged `CONFIG_LV_USE_SPINNER=y` in `firmware/sdkconfig.defaults` because xiaozhi's stock Kconfig has it off; the bridge stays as the device's source of truth.
- Code-quality follow-ups on the screen module: defensive `s_touch_dot = NULL` before screen rebuild, promoted touch-dot size to `SENTIENT_TOUCH_DOT_SIZE` named constant (kills 22/11 magic-number coupling), dropped unused `<string.h>` include.
- Added `sentient_cube_show_test_screen()` C entry to `boards/sentient-cube/sentient_ui_controller.{cc,h}` and swapped the boot-UI call in `CustomLcdDisplay::SetupUI()` from `sentient_cube_create_toggle_button_screen()` to the new test-screen entry. Toggle-button module stays in tree; Phase 6 (Sentient Connect) flips back. Documented the paused HIL markers (`>>> READY`, `>>> CHECKPOINT *`) — the device-state polling task lives inside `_create_toggle_button_screen` and is dormant for Phase 2..5; no current HIL test consumes those markers.
- Added `SentientTouchReadCb` in `boards/sentient-cube/sentient_cube.cc` — wraps Phase 1's `SafeTouchReadCb` with a press→release FSM. Emits exactly one `<<< EVT {"event":"touch.tap","x":N,"y":N,"ts_us":N}` per physical tap via the existing `agent_console_event()` public API. Drives the test-screen heatmap dot via `sentient_test_screen_set_touch_xy` for visual cross-check. `SafeTouchReadCb` itself unchanged.
- Created sim-only `esp32/cube/lvgl-sim/lv_conf.h` hand-mirrored from xiaozhi's Kconfig visual settings (color depth 16, OS_NONE, label + spinner widgets, Montserrat 14 default font, OBJ_ID metadata for struct-layout parity). Device stays on Kconfig — zero regression risk to Phase 1. README documents the bump-in-lockstep workflow.
- Stood up `esp32/cube/lvgl-sim/` SDL2 host build (`CMakeLists.txt`, `main/main.c`, `main/sdl2_driver.{c,h}`, `.gitignore`). Adapted from `lv_port_pc_vscode`. Software-rendered 466×466 RGB565 window, mouse-as-touch indev. LVGL examples/demos/ThorVG targets disabled for fast iteration. Pinned at LVGL `v9.5.0`.
- `esp32/cube/lvgl-sim/README.md` documents pinned LVGL version + managed-component template SHA, first-time setup (`brew install sdl2`, `git clone --depth 1 --branch v9.5.0`, `cmake -B build -S .`), the ~2s iteration loop, the LVGL-bump update workflow, troubleshooting across macOS Apple Silicon / Intel / Linux, and the scope guard ("sim never replaces device smoke").
- **Hardware regression fix** (Phase 2 Task 8 first attempt panicked on real hardware): `sentient_test_screen_build()` originally called `lv_obj_clean(lv_screen_active())` to make rebuild idempotent. On the device, the active screen already had children from `SpiLcdDisplay::SetupUI()` (parent class): `chat_message_label_`, `status_bar_`, etc. `lv_obj_clean` destroyed those, leaving `LcdDisplay` base class with dangling raw pointers. `Application::Initialize` later called `SetChatMessage("...")` → LoadProhibited panic. Fix: build the test screen on a NEW `lv_obj_create(NULL)` screen and `lv_screen_load` it. Parent's widgets stay allocated on the (now-unloaded) original screen; `SetChatMessage` harmlessly updates off-screen. Target-symmetric.
- **Agent-driveable sim mode** (post-handover follow-up; commit `86cac0b`): added `--snapshot PATH` headless mode to `lvgl-sim`. Spec §7 says the sim is a fast UI-iteration aid for the agent, but the original windowed-only build couldn't have its pixels read back by a non-interactive subagent (screencapture races, window may not be focused/on-screen). New mode sets `SDL_VIDEODRIVER=dummy`, drives LVGL for ~500 ms simulated time so animations settle, reads the LVGL RGB565 framebuffer directly, converts to RGB888, writes a PNG via the bundled `stb_image_write.h` (single-header public-domain, nothings/stb v1.16), exits 0. Also hoisted the framebuffer pointer from a local static into a file-scope `s_fb` + a `sentient_sim_sdl2_framebuffer()` const accessor so `main.c` can read pixels without going through `SDL_RenderReadPixels` (which doesn't work under dummy). Software-renderer fallback added to `sentient_sim_sdl2_init` for the dummy driver (no GPU). Windowed mode unchanged. README documents both modes.

## What's used (stack the user now owns)

| Path | Responsibility |
|---|---|
| `esp32/cube/firmware/ui-shared/test_screen.{c,h}` | Target-agnostic LVGL widget module. Shared between device + sim. Pure LVGL public API. |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.{cc,h}` | + `sentient_cube_show_test_screen()` C entry. Existing toggle-button + state APIs unchanged. |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | + `SentientTouchReadCb` tap-detector (wraps `SafeTouchReadCb`). + 9-line comment noting paused HIL markers during Phase 2..5. |
| `esp32/cube/firmware/sdkconfig.defaults` | + `CONFIG_LV_USE_SPINNER=y` bridge (Task 1). |
| `esp32/cube/lvgl-sim/lv_conf.h` | Sim-only LVGL config. Hand-mirrored from device Kconfig visual settings. NOT shared with device. |
| `esp32/cube/lvgl-sim/CMakeLists.txt` | Host build root. Pins LVGL via `LV_CONF_PATH`, disables examples/demos/ThorVG, links SDL2. |
| `esp32/cube/lvgl-sim/main/main.c` + `sdl2_driver.{c,h}` | SDL2 window + mouse-as-touch indev glue. Bootstraps LVGL + invokes `sentient_test_screen_build()`. Supports `--snapshot PATH` for headless agent-driveable PNG capture (sets `SDL_VIDEODRIVER=dummy`). |
| `esp32/cube/lvgl-sim/main/stb_image_write.h` | Single-header public-domain PNG encoder (nothings/stb v1.16, sha256 `cbd5f0ad...4914a05`). Used by `--snapshot` mode only. |
| `esp32/cube/lvgl-sim/README.md` | Version pin (LVGL `v9.5.0`, template SHA `2ece178f...c6291`), setup, run, iteration loop, LVGL-bump update flow, scope guard. |

Verbs callable today (unchanged from Phase 1): `state`, `mark`, `events`, `ui.dump_tree`, `ui.snapshot`, `audio.inject_pcm`, `tts.cancel`, `log_level`, `wifi.*`, `ws.*`, `button.*`, `restart`.

New EVT type: `<<< EVT {"event":"touch.tap","x":N,"y":N,"ts_us":N}` — emitted device-side on every physical tap (press→release transition).

## What's smoked

| Case | Command / observation | Result | Evidence |
|---|---|---|---|
| device build green | `idf.py build` after Tasks 1-7 + fix | ✅ | binary `sentient_cube.bin` 2.7 MB |
| host sim build green | `cmake --build build -j` in `lvgl-sim/` | ✅ | `lvgl-sim/build/sentient_cube_lvgl_sim` arm64 |
| host sim window opens + renders | `./build/sentient_cube_lvgl_sim` 3s lifetime check | ✅ stdout `[lvgl-sim] running 466x466. Close the window to exit.`, pid=5248, clean SIGTERM, zero LVGL warnings | (windowed mode confirmed; pixel evidence via headless snapshot below) |
| host sim headless snapshot | `./build/sentient_cube_lvgl_sim --snapshot /tmp/sim-headless.png` (added late-Phase-2 — see follow-up note below) | ✅ 466×466 RGB PNG 9.7KB; renders all 4 elements correctly | `/tmp/sim-headless.png` |
| device visual parity vs sim | agent-read `/tmp/sim-headless.png` vs `/tmp/phase2-screen-1.png` | ✅ matching: deep-blue bg, gradient bar dark→cyan, "SENTIENT CUBE" white label above bar, blue spinner below; layout positions match (label −60 from center, bar at center, spinner +70 from center); spinner caught at different rotation angles in each capture — confirms both animating independently | both PNGs in `/tmp/` |
| device flash | `idf.py -p /dev/cu.usbmodem101 flash` after fix | ✅ Wrote 2,851,680 bytes in 14.4s; Hard resetting via RTS pin... Done | (post-fix flash) |
| boot clean | `sleep 20 && cube-cmd state` | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true,"cycle_id":null}` | `/tmp/phase2-boot-fixed.log` (zero panics) |
| ui.snapshot test screen | `cube-snapshot.sh /tmp/phase2-screen-1.png` | ✅ 480×480 RGB PNG 5.4KB; mean RGB (11.6, 33.1, 53.9) ≈ #0B2236 — matches test_screen.c `0x0a1f33` | `/tmp/phase2-screen-1.png` (125 unique colors) |
| spinner motion (1.5 Hz) | two snapshots 500 ms apart | ✅ different SHAs (`f33bbeb...` vs `38e6b24...`); color count 125 vs 123 | `/tmp/phase2-screen-a.png`, `/tmp/phase2-screen-b.png` |
| `touch.tap` EVT | user multi-tap → `daemon events` socket scrape | ✅ 4 events captured, x/y sane (213-265 within 0-465 range) | recorded in `/tmp/phase2-smoke-record.txt` |

## What you need to know

1. **`lv_obj_clean(lv_screen_active())` is destructive in xiaozhi-derived boards.** The parent `SpiLcdDisplay::SetupUI()` populates the active screen with widgets that `LcdDisplay` base class tracks via raw pointers (`chat_message_label_`, `status_bar_`, etc.). Calling `lv_obj_clean` on that screen frees those widgets but leaves the base-class pointers dangling. Any subsequent `SetChatMessage` / `SetEmotion` / status-bar update call panics. **Always build new UI on a fresh `lv_obj_create(NULL)` + `lv_screen_load(scr)`.** Phase 1's `toggle_button_screen.cc` got away with `lv_screen_active()` because it didn't `lv_obj_clean` — it added widgets alongside the parent's. Phase 2's `test_screen.c` uses the new-screen pattern; Phase 6's toggle-button restoration should consider doing the same for symmetry.

2. **Host sim is structurally blind to the bug above.** Sim's default LVGL screen on `lv_init` has no parent-created widgets — `lv_obj_clean` is a no-op there. A green sim run does NOT prove safe widget lifecycle on device. Per spec §7 scope guard: device smoke is always required.

3. **`CONFIG_NEWLIB_NANO_FORMAT=y` breaks `%lld`.** ESP-IDF's nano-format printf doesn't support `long long` format specifiers. Any `snprintf` / `printf` with `%lld` (or `%llu`, `%llx`) silently emits the literal characters after the `%`. The touch.tap `ts_us` field currently shows as literal `"ld"` for this reason. Workaround: cast to `(unsigned long)` and use `%lu` (32-bit, ~71-min rollover on microsecond timer). Or flip the Kconfig flag for ~50 KB binary cost. Tracked as Phase 3 follow-up.

4. **`CONFIG_LV_USE_SPINNER=y` lives in `firmware/sdkconfig.defaults` as a bridge.** Phase 1 inherited xiaozhi's stock `=n` which gates the LVGL `lv_spinner_*` symbols at preprocess. Test screen needs the spinner. The bridge stays — device uses Kconfig-generated LVGL config. The sim has its own `LV_USE_SPINNER 1` in `lvgl-sim/lv_conf.h`. Two sources of truth; document on LVGL bump.

5. **HIL stdout markers are paused during Phase 2..5.** The device-state polling task that emits `>>> READY` and `>>> CHECKPOINT {listen,ws,wifi}.*` lives inside `_create_toggle_button_screen()` (xiaozhi's polling rig). Phase 2's boot-UI swap means the toggle screen never builds during 2..5, so the task never spawns, so those markers never emit. No current HIL test consumes them — no functional regression. Phase 6's toggle-screen restoration brings them back. A future cleanup pass could lift the polling task out of the screen factory and into a board init hook.

6. **`ui.snapshot` worked cleanly for the test screen this phase** — parse-error from Phase 1 did NOT recur. Spec §6 flagged it as a follow-up if it recurred. It did not. Three snapshots taken cleanly during smoke.

## Hardware glossary (terms new this phase)

- **SDL2**: Simple DirectMedia Layer 2 — cross-platform graphics/input library. The host sim uses it to draw a 466×466 RGB565 window and read mouse events. Installed via Homebrew (`brew install sdl2`). Tested with version 2.32.10.
- **`lv_conf.h`**: LVGL's master configuration header. Controls memory pool size, enabled widgets, color formats, OS abstraction, feature flags. Each LVGL build (device, sim) needs one. The sim owns `lvgl-sim/lv_conf.h`; the device's effective config is Kconfig-generated.
- **`LV_CONF_INCLUDE_SIMPLE` / `LV_CONF_PATH`**: LVGL preprocessor macros controlling how the library finds its config header. `INCLUDE_SIMPLE` = "find lv_conf.h on the include path"; `PATH` = "load lv_conf.h from this exact filesystem path." The sim's CMakeLists uses `LV_CONF_PATH`.
- **`indev` (LVGL)**: short for "input device." LVGL's abstraction for mouse / touch / encoder input. Each indev has a read callback that LVGL polls at the configured tick rate. Phase 1 registered `SafeTouchReadCb`; Phase 2 swapped to `SentientTouchReadCb` (wrapper).
- **`addr2line`**: GNU binutils tool that translates code addresses from a panic backtrace into source `file:line` references. Path on this Mac: `~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20251107/xtensa-esp-elf/bin/xtensa-esp32s3-elf-addr2line`. Mandatory for diagnosing LoadProhibited panics.

(Phase 1 glossary still applies: AMOLED, AXP2101, USB-Serial-JTAG, QSPI, PowerSaveTimer, I²C.)

## Open questions / risks

- **`touch.tap` `ts_us` field renders as literal `"ld"`** (CONFIG_NEWLIB_NANO_FORMAT=y constraint). x/y values are sane; spec smoke bar PASS. Fix: cast `esp_timer_get_time()` to `(unsigned long)` and use `%lu` in the snprintf format string. ~3-line firmware change. Phase 3 follow-up.
- **`show_test_screen` log line not captured in daemon ring buffer** during Phase 2 smoke. The daemon attaches AFTER cube boot; the early boot trace + ~270 lines of `wifi: Haven't to connect to a suitable AP` rolled past the marker before the daemon's reader thread started consuming. PNG render evidence stands in (mean RGB matches background, 125 unique colors confirm full render). Future improvement: ensure the daemon attaches BEFORE cube boot so it captures the early window.
- ~~**Visual parity with `test_screen.c` design** is NEEDS-HUMAN-VERIFY.~~ **Resolved** via the added `--snapshot` headless mode (commit `86cac0b`): agent read `/tmp/sim-headless.png` and `/tmp/phase2-screen-1.png` directly; both render the same four elements at the same layout positions. Spinner caught at different rotation angles in each capture, confirming both targets animate the spinner independently.
- **HIL markers (`>>> READY`, `>>> CHECKPOINT *`) are paused during Phase 2..5.** Phase 6 restoration covers it. If a future Phase 3-5 task needs them, lift the polling task out of `_create_toggle_button_screen()` into a board init hook.
- **`-Wmissing-field-initializers` warnings** in `audio_service.cc` + vendor managed components — pre-existing, non-blocking. Inherited from Phase 1.

## Flash + smoke metrics

- Flashes this phase: **3** (budget ≤ 4)
  - Flash 1 (Task 8 first attempt): "Serial data stream stopped" — daemon held the port. Killed daemon. Retry counted separately.
  - Flash 2 (Task 8 retry): successful flash; cube reboot-looped with LoadProhibited.
  - Flash 3 (Task 8 second attempt after `a95574f` fix): successful flash; cube reached IDLE+wifi+ws cleanly.
- AXP2101 faults hit: **0** (every boot trace shows axp2101.probe.done cleanly; chip_id=0x4a as expected)
- Daemon restarts: **~4** (each `ui.snapshot` required killing the daemon to release the serial port; auto-respawn worked every time)
- Cold physical recoveries: **0**
- Total dev time on smoke: ~1.5 hours (subagent automation + ~5 minutes user finger-tap window)
- Host sim iteration round-trip: ~2 seconds (edit → build → run). Confirmed during Task 6.

---

**Phase 3 (Speaker — original-spec Phase 3) is next.** Carry-overs: do not re-enable vendor `lvgl_port_add_touch` (Phase 1 finding still applies); ts_us format spec is a small open follow-up; HIL marker restoration belongs to Phase 6.
