# ESP32 Cube Phase 1 — Foundation Handover

**Date:** 2026-05-11
**Branch:** feature/esp32-cube-v2-rescope
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md

## What's done

- Tagged v1 overlay at `esp32-cube-v1-overlay-archive` and documented the rescope premise in the spec doc; existing build.md flagged as honest-but-stale where it referenced the overlay/patch flow.
- Imported v1 cube infrastructure (`esp32/cube/scripts/`, `esp32/cube/tests/`, `esp32/cube/docs/`, `.claude/rules/esp32/cube/*`) into the new tree without changes — they were already protocol-agnostic.
- Scaffolded `esp32/cube/firmware/` skeleton with project name `sentient_cube` and copied the xiaozhi keep-list into it (~80K LOC trimmed from upstream xiaozhi-esp32).
- Stripped OTA, MCP server, and wake-word paths from `main/application.cc`; forced WS-only protocol selection (no MQTT branch left at compile time).
- Task 10 fixup pass: restored files the original keep-list under-counted (`audio/wake_words/*` internals, `audio/demuxer/`, `led/*`, `idf_component.yml`, `firmware/scripts/{gen_lang,build_default_assets}.py`) so CMake/managed-components can resolve.
- Imported v1 overlay sources from the archive tag, then ported `agent_console/` and `net_logger/` as first-class `firmware/components/`.
- Merged the waveshare-amoled-2.16 board class with the sentient overlay board into a single `boards/sentient-cube/sentient_cube.cc` (537 LOC) deriving directly from `WifiBoard`. Folded the v1 `SentientCubeDisplay` subclass into the existing `CustomLcdDisplay`. Patches 0001 and 0002 (vtable-defer + display subclass) became unnecessary and were dropped.
- Moved `toggle_button_screen` + `ui_controller` setup into the board's display SetupUI hook so LVGL widgets land after the parent panel is wired.
- Wired `agent_console` and `net_logger` into `main`'s `PRIV_REQUIRES` so the symbols link.
- Inlined patch 0003 (USB-aware power save) as a native `InitializePowerSaveMonitor()` in the board class; light-sleep is suppressed when USB-tethered.
- Inlined patch 0004 (audio inject hook) as a weak `agent_audio_inject_pop_samples()` symbol in `audio/audio_service.cc`, with the strong override living in `agent_console/verbs/audio.cc`.
- Deleted the legacy `esp32/cube/sentient/` overlay tree — no callers remain.
- Retargeted every helper script in `esp32/cube/scripts/` at the new `firmware/` path (cube-cmd, cube-daemon, bake-creds, JTAG helpers).
- Build proven green end-to-end: `idf.py build` produces `sentient_cube.bin` 2.8 MB with 30% partition free and ~46% DIRAM free.
- **Smoke session (post-build):**
  - Removed `PowerSaveTimer::OnShutdownRequest → pmic_->PowerOff()` — that handler latched AXP2101 into a shutdown state that survives MCU reset + USB unplug; only physical battery+USB cycle clears it.
  - Reordered Pmic ctor register writes — the old "disable all LDOs first then re-enable ALDO1" pattern killed the I²C bus pullup mid-sequence on a first-cold-boot AXP2101. New order: set voltages first, enable ALDO1 once, never disable.
  - Added I²C bus health probe + 9-pulse bitbang recovery before `i2c_new_master_bus()`. Diagnostics distinguish "bus alive", "SDA stuck (slave clock-stretch)", "both lines low (PMIC DC1 off, physical recovery required)", and "SCL stuck (unrecoverable from master)".
  - Replaced vendor `lvgl_port_add_touch` (uses fatal `ESP_ERROR_CHECK` in polling loop) with `SafeTouchReadCb` that tolerates transient I²C errors. Defends against any future glitch on the shared bus (audio codec mode switches, charger transitions).
  - Added `vTaskDelay(800ms)` before `board.StartNetwork()` to restore xiaozhi's accidental settle buffer (their `MCP::AddCommonTools/AddUserOnlyTools` ran in that window; we stripped MCP in Task 7).
  - Ported v1's `esp32/cube/sdkconfig.defaults` overrides into `firmware/sdkconfig.defaults` — including `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` which makes USB-Serial-JTAG the primary console (without this, `agent_console`'s `fgets(stdin)` reads from UART0 on chip-debug pins that aren't connected to the host).
  - Cube reaches state IDLE, WiFi connected to `InterWeb`, WS opened to gateway. `cube-cmd state` returns the expected JSON.

## What's used (stack you now own)

| Path | Responsibility |
|---|---|
| `esp32/cube/firmware/CMakeLists.txt` | Top-level IDF project (`sentient_cube`). |
| `esp32/cube/firmware/main/` | Application core (trimmed xiaozhi: app loop, audio, protocols, display, IoT). |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | Merged board class (`SentientCubeBoard : WifiBoard`) — 537 LOC. Owns AXP2101, AMOLED QSPI panel, CST816 touch, LVGL display, power-save monitor, UI hooks. |
| `esp32/cube/firmware/main/audio/audio_service.cc` | Mic + codec + audio inject weak hook (patch 0004 inlined). |
| `esp32/cube/firmware/main/protocols/websocket_protocol.cc` | WS-only protocol; MQTT branch removed at compile time. |
| `esp32/cube/firmware/components/agent_console/` | USB-CDC verb dispatcher (state, mark, events, audio, tts.cancel, audio.inject_pcm). Strong override for `agent_audio_inject_pop_samples`. |
| `esp32/cube/firmware/components/net_logger/` | UDP log shipping to gateway. |
| `esp32/cube/firmware/sdkconfig.defaults` | Baseline IDF config (board type, partition table selector, USB-Serial-JTAG settings). |
| `esp32/cube/firmware/partitions/v2/16m.csv` | 16 MB partition layout for v2 (selected via `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME`). |
| `esp32/cube/scripts/` | `cube-cmd.sh`, `cube-daemon`, `bake-creds.sh`, JTAG helpers — all retargeted at `firmware/`. |
| `esp32/cube/tests/hil/` | pytest-embedded HIL harness (already v2-clean from authorship). |
| `.claude/rules/esp32/cube/{build,agent-console,logging,testing,flash-discipline}.md` | Agent rules — what to do and not do when touching cube firmware. |

Verbs callable today (after Task 23 flash):
- `cube-cmd state`
- `cube-cmd mark <label>`
- `cube-cmd events --tail N`

GPIO/HW used at boot:
- I²C bus 1: AXP2101 PMIC (rail enable + monitor), CST816 capacitive touch.
- QSPI: 2.16" 466×466 AMOLED panel (CS, SCK, D0–D3).
- USB-Serial-JTAG: CDC for `cube-cmd` verb traffic + JTAG for OpenOCD.
- I²S: codec mic + speaker path.
- GPIO buttons: BOOT/touch wake.

## What's smoked

- **build**: `idf.py build` green — sentient_cube.bin 2.8 MB / 30% partition free / 46% DIRAM → ✅
- **flash**: `idf.py -p /dev/cu.usbmodem101 flash` → success → ✅
- **boot**: clean cold boot from fully discharged AXP2101 — PMIC init, display init, audio codec, touch, agent_console, net_logger, all bracketed init logs visible → ✅
- **wifi**: associated with `InterWeb` AP, channel 6, BSSID `14:eb:b6:42:6c:2c` → ✅
- **ws**: `>>> CHECKPOINT ws.connected <ts>` emitted on stdout — WebSocket to gateway opened → ✅
- **state verb**: `cube-cmd state` returns `{"state": "IDLE", "wifi_connected": true, "ws_connected": true, "cycle_id": null}` → ✅
- **mark verb**: blocked by an unrelated Python traceback in `_cube_cmd_helper.py`; firmware side accepts the verb (separate fix needed in helper script)
- **udp log**: deferred — net_logger init succeeds, but UDP smoke not exercised in this phase

Evidence:
- Final commit chain on `feature/esp32-cube-v2-rescope` extends to the smoke fixes — `e031d04^..HEAD` (now ~25 commits).
- Boot trace captured at `/tmp/boot-post-touchfix.log` (925 lines, including AXP2101 chip ID, all 10 Pmic writes ok, settle delay engaged, WiFi connect, WS connect).

```
[8/13] Linking C static library esp-idf/main/libmain.a
[9/13] Generating esp-idf/esp_system/ld/sections.ld
[10/13] Linking CXX executable sentient_cube.elf
[11/13] Generating binary image from built executable
esptool.py v4.12.dev1
Creating esp32s3 image...
Merged 2 ELF sections
Successfully created esp32s3 image.
Generated /Users/kevinye/.../esp32/cube/firmware/build/sentient_cube.bin
[12/13] cd .../build/esp-idf/esptool_py && python .../check_sizes.py \
    --offset 0x8000 partition --type app .../partition-table.bin .../sentient_cube.bin
sentient_cube.bin binary size 0x2c1c20 bytes. Smallest app partition is 0x3f0000 bytes.
0x12e3e0 bytes (30%) free.

Project build complete. To flash, run:
 idf.py flash
```

(Build emitted 26 `-Wmissing-field-initializers` warnings inside `audio/audio_service.cc` from upstream xiaozhi — non-blocking, pre-existing.)

## What you need to know

1. **Upstream xiaozhi moved partition CSV into `partitions/v2/*.csv`.** Commit `b72945a` in xiaozhi changed partition selection from a root `partitions.csv` to `partitions/v2/16m.csv` via `CONFIG_PARTITION_TABLE_CUSTOM_FILENAME`. The plan's keep-list expected root-level `partitions.csv` — we preserved the upstream relative path instead of editing `sdkconfig.defaults`. Anyone updating the partition table edits `firmware/partitions/v2/16m.csv`, not a root file.

2. **Batch 2 keep-list was thinner than minimum-buildable.** Task 10 fixups restored several xiaozhi files the original cut dropped:
   - `audio/wake_words/*` — internals are referenced by `AudioService` even though the Application-layer wake-word path was stripped.
   - `audio/demuxer/` — referenced by `audio_service.h`.
   - `led/*` — `board.h` includes `led/led.h`.
   - `idf_component.yml` — managed_components fetch (without it IDF can't pull dependencies).
   - `firmware/scripts/{gen_lang,build_default_assets}.py` — CMake `add_custom_command` invokes these during build.

3. **Real symbol names differ from plan placeholders.** Confirmed bindings in the merged tree:
   - Audio inject hook: `agent_audio_inject_pop_samples(int16_t* buf, int max_samples, int timeout_ms)` (weak default at `audio/audio_service.cc:53`, strong override at `agent_console/verbs/audio.cc:205`). Plan called it `sentient_audio_inject_read` — it isn't.
   - Net logger init: `net_logger_init(host, port, device_id)` (not `net_logger_start()`).
   - UI hook: `sentient_cube_create_toggle_button_screen()` is invoked from `CustomLcdDisplay::SetupUI()` after the parent panel finishes its own setup. There is no `sentient_ui_controller_start()` called from the board ctor as the plan suggested.

4. **Board class merge dropped two patches outright.** `SentientCubeBoard : public WifiBoard` (no derivation from the waveshare class). Because there's no derivation, patches 0001 (vtable-defer for derived ctor) and 0002 (display subclass plumbing) became unnecessary and were not ported. `DisplayLockGuard` is re-acquired inside `CustomLcdDisplay::SetupUI()` (not the board's `SetupUI` as the plan diagram suggested). The v1 `SentientCubeDisplay` subclass was folded into `CustomLcdDisplay` directly — one class instead of two.

5. **`~/esp/esp-idf/export.sh` PATH-sourcing quirk.** `export.sh` only populates `PATH` if you source it with CWD == `$IDF_PATH`. Build workflow is:

   ```
   bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd <firmware> && idf.py build'
   ```

   Sourcing it from elsewhere silently leaves `idf.py` off `PATH`.

6. **`sentient_creds.h` placeholder uses v1 macro names.** The header at `firmware/main/sentient_creds.h` expects:
   - `SENTIENT_GATEWAY_HOST`
   - `SENTIENT_WS_PORT`
   - `SENTIENT_WS_PATH`
   - `SENTIENT_LOG_PORT`
   - `SENTIENT_WIFI_SSID`
   - `SENTIENT_WIFI_PSK`

   The user's `.e2e-testing` env + `bake-creds.sh` must emit these macro names. The v2 plan text suggested `SENTIENT_WS_URL` / `SENTIENT_WIFI_PASSWORD` — those names are not what the source compiles against. Either update bake-creds to emit the v1 names, or change the header. Don't ship a mismatch.

7. **`PMIC PowerOff()` is non-volatile on AXP2101 — never call it.** The v1 `PowerSaveTimer::OnShutdownRequest` callback invoked `pmic_->PowerOff()` after 5 min idle. That command latches AXP2101 into a shutdown state that survives MCU reset, USB unplug, and battery-only operation. Only a simultaneous battery + USB disconnect (longer than internal cap drain time) clears it. The shutdown handler has been removed from `InitializePowerSaveTimer` and the 3rd arg of the timer ctor is `-1` (disabled). Future code MUST NOT re-add `OnShutdownRequest` that calls `PowerOff()`. If a real "store" shutdown is ever needed it has to be paired with documented physical recovery instructions.

8. **Pmic ctor register write order matters.** The v1 sequence wrote `0x90=0x00` (disable all LDOs) before configuring + re-enabling ALDO1. On Waveshare 2.16 the I²C bus pullup voltage is sourced from ALDO1 — disabling it killed the bus, and the next `WriteReg(0x91=0x00)` failed with `ESP_ERR_INVALID_STATE`. The cube survived this on subsequent boots only because AXP2101 retained "v1-configured" register state across reset; first cold boot from a fully discharged AXP2101 hit the bug. New sequence: set voltages first, enable ALDO1 once, never disable. Defaults for other LDOs are safe.

9. **WiFi RF turn-on creates a transient I²C error window.** When `phy_init` runs, RF current draw and shared-rail transient briefly disrupts touch I²C. Vendor's `lvgl_port_add_touch` registers a polling callback that wraps `esp_lcd_touch_read_data()` in `ESP_ERROR_CHECK` — any transient fault aborts firmware. Replaced with `SafeTouchReadCb` (in `boards/sentient-cube/sentient_cube.cc`) that treats any read failure as "no touch this tick" and continues. Also added `vTaskDelay(800ms)` in `Application::Initialize` before `board.StartNetwork()` — restores the accidental ~1s settle buffer that xiaozhi got from `MCP::AddCommonTools / AddUserOnlyTools` (which we stripped in Task 7).

10. **Sentient sdkconfig overrides must live in `firmware/sdkconfig.defaults`.** xiaozhi's stock defaults make UART0 (GPIO 43/44, chip-debug pins) the primary console. Our `agent_console` reads `stdin` — without `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y` the daemon writes via USB-CDC never reach the cube. v1 carried 11 such overrides in a sentient-side `esp32/cube/sdkconfig.defaults` file; v2 Batch 2 keep-list missed them. The ports are at the tail of `firmware/sdkconfig.defaults` under a `# === Sentient cube overrides ===` banner. Don't strip them.

11. **I²C bus health probe + bitbang recovery.** `ProbeAndRecoverI2cBus()` runs before `i2c_new_master_bus()`. Reads SDA/SCL idle levels and either declares the bus healthy, attempts 9-pulse SCL recovery (SDA-stuck-low case), or logs a fatal "physical power cycle required" message (both lines low = pullup Vcc missing, AXP2101 DC1 latched off). Future cubes that exhibit early-boot I²C symptoms now produce a precise diagnostic line in the first 300ms of boot.

## Hardware glossary

- **AMOLED**: Active-matrix OLED display. Self-emissive per pixel. Our 2.16" panel is 466×466 over QSPI.
- **AXP2101**: Power management IC (PMIC). I²C bus 1. Reset/init fragile after rapid USB-Serial-JTAG resets.
- **USB-Serial-JTAG**: ESP32-S3 USB peripheral exposing CDC + JTAG. Hardware translates host DTR/RTS toggles into strap-pin moves → pyserial `open()` resets cube unless `dsrdtr=False, rtscts=False`.
- **QSPI**: Quad SPI. 4 data lines.
- **PowerSaveTimer**: xiaozhi component for light-sleep after N idle seconds. Disabled by us when USB-tethered (patch 0003 inlined as `InitializePowerSaveMonitor`).
- **I²C**: Two-wire serial. Cube uses one bus for AXP2101 + CST816 touch.

## Open questions / risks

- ~~**`mark` verb helper traceback.**~~ **Resolved.** `cube-cmd mark hello-cube-v2` invoked the helper with `--params hello-cube-v2`, which `json.loads()` rejected with an unhandled `JSONDecodeError`. Firmware never saw the CMD. Helper now catches the exception and prints `params-json-invalid: <reason> (got: <raw>; expected JSON object like '{"label":"x"}')` to stderr, exit 4. Valid form `cube-cmd mark '{"label":"hello"}'` returns `{"ok": true}` from firmware.
- **UDP log smoke not exercised.** `net_logger_init` runs and emits its lifecycle logs (`init.begin`, `init.queue_created`, `init.task_created`, `init.vprintf_hooked`). End-to-end "host runs `nc -ul 9000`, sees lines" not verified this session. Easy follow-up.
- **Boot bloat — 3.4 MB of xiaozhi locales + wake-words + demuxer.** `firmware/main/assets/locales/*` carries 30+ language packs (~3 MB), and `audio/wake_words/*` + `audio/demuxer/*` are restored-but-unused-at-runtime. Strip pass deferred to a separate cycle. Current binary 2.8 MB; strip would bring it under 1 MB.
- **`io_expander` field is reserved but unused.** TCA9554 init was 1.75"-board only. Field kept on `SentientCubeBoard` to minimize diff; remove if no consumer materializes.
- **Kconfig leftovers.** `BOARD_TYPE_WAVESHARE_*` alternates are still in `Kconfig.projbuild`. Harmless (we select `sentient-cube`), but deferred cleanup.
- ~~**`sdkconfig` is gitignored.**~~ **Resolved.** Pinned `CONFIG_IDF_TARGET="esp32s3"` at the head of `firmware/sdkconfig.defaults`. Fresh-clone `idf.py build` now picks the right target without any manual `idf.py set-target` step. sdkconfig itself stays gitignored (regenerates per IDF version + machine).
- **`-Wmissing-field-initializers` warnings** in `audio_service.cc` and managed_component vendor headers. Pre-existing in xiaozhi + vendor code, non-blocking.

## Flash + smoke metrics

- Flashes this phase: **6** (Tasks 23 + diagnostic iterations for AXP2101 + Pmic + touch + sdkconfig). The `.claude/rules/esp32/cube/flash-discipline.md` target of ≤5 was exceeded — root cause was that the v1→v2 migration uncovered three latent bugs (PMIC PowerOff latching, Pmic LDO ordering, WiFi-RF / touch race) that each required a flash to observe + a flash to verify. User explicitly authorized "ignore the stupid flash counter" once the diagnosis was in motion.
- AXP2101 faults hit: **2** (one initial latched-off state inherited from prior `pmic_->PowerOff()` invocation; one reproduced during diagnostic iteration). Each required physical battery+USB power cycle.
- Daemon restarts: **many** (every cube-cmd attempt while CDC was masked by primary-console-on-UART0 misconfig; root-caused + fixed in commit `fix(esp32-cube/sdkconfig): USB-Serial-JTAG as primary console + v1 overrides`).
- Cold physical recoveries: **2** (both user-side opening of the enclosure to disconnect battery + USB simultaneously).
- Total dev time on hardware smoke: ~3 hours. Most of it was AXP2101 fault recovery dance; rest was running diagnostic builds.

## Lessons recorded for the next phase

- **Flash discipline rule does not foresee first-cold-boot from a never-configured AXP2101.** Every "v1 worked here" assumption is suspect on first flash of a recovered cube. New cube bring-up workflow MUST include the I²C bus probe diagnostic from the first commit; without it, AXP2101 fault and primary-console misconfig present identically (silent CDC + reboot loop).
- **Migrating from a patch-based fork (v1) to a clean fork (v2) needs an explicit audit of overrides.** v1's `esp32/cube/sdkconfig.defaults` carried 11 overrides on top of xiaozhi defaults. Batch 2's keep-list audit missed all of them. Future imports from a sentient-side overlay should run `diff <sentient overlay> <upstream default>` over every config-defaulting file and port deltas wholesale.
- **`ESP_ERROR_CHECK` is fatal — never use in polling loops.** This is a vendor anti-pattern that bit us via `lvgl_port_add_touch`. The same shape exists in many ESP-IDF managed components. Any callback registered into an ESP-IDF polling task must tolerate transient errors. The `SafeTouchReadCb` pattern is reusable for any future touch / IMU / charger driver wrapper.
