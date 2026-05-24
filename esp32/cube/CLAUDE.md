# ESP32 Cube

Voice frontend for Sentient running on a Waveshare ESP32-S3-Touch-AMOLED-2.16. Talks to the local gateway over WS + PASETO; toggle-to-talk via the touchscreen. Flat, owned firmware tree under `firmware/` — no submodule, no patches, no symlinks. xiaozhi-esp32 was vendored from SHA `b72945a` and is edited in place.

## MANDATORY — Read Rules First

Before reading or editing source under `esp32/cube/`, load these rules. Each declares a `paths:` glob in frontmatter so Claude Code auto-applies them when you open matching files. Read them up front anyway — the source matches several globs at once.

| Rule | Covers |
|---|---|
| `.claude/rules/esp32/cube/build.md` | ESP-IDF env, `esp32-devtool flash` (eager daemon respawn), `lvgl-sim` pointer, `addr2line` panic decoding, sdkconfig discipline, managed components. |
| `.claude/rules/esp32/cube/flash-discipline.md` | Flash budget, AXP2101 fault recovery, daemon-ring-buffer inspection, `esp32-devtool cmd state` wedge check. |
| `.claude/rules/esp32/devtool.md` | `esp32-devtool` mono-tool surface — verb registration under `firmware/main/devtool_verbs/`, HTTP companion endpoints, `--json` contract, prod-strip audit, board manifest extensions. |
| `.claude/rules/esp32/cube/logging.md` | Tag hierarchy (`sentient.cube.<area>`), `esp32_devtool_companion` log_relay UDP teeing, pre-WiFi log gap. |
| `.claude/rules/esp32/cube/testing.md` | HIL Groups A/B/C, pytest-embedded fixtures, real-hardware-only constraint. |
| `.claude/rules/esp32/cube/lvgl-sim.md` | Host SDL2 UI iteration, `--snapshot` mode, device-smoke-always scope guard, LVGL-bump lockstep workflow. |

When a rule is unclear, read its matching `agents/docs/esp32/cube/<topic>-details.md`.

## Tree map

| Path | Role |
|---|---|
| `firmware/` | ESP-IDF project (`sentient_cube`). All device source lives here. |
| `firmware/main/` | xiaozhi-derived app core: state machine, audio, protocols, display, board. |
| `firmware/main/boards/sentient-cube/` | Single board class merged from waveshare AMOLED 2.16 + our overlay. |
| `firmware/main/devtool_verbs/` | USB-CDC verbs registered via `devtool_register_verb` (see `esp32/devtool/`). |
| `firmware/ui-shared/` | LVGL widgets compilable on BOTH device and `lvgl-sim`. Pure LVGL public API — never include `esp_log`, FreeRTOS, or `esp_lcd_*` here. |
| `lvgl-sim/` | Host SDL2 LVGL simulator. ~2 s edit-build-snapshot loop. See `lvgl-sim/README.md`. |
| `scripts/bake-creds.sh` | Transient creds-bake hack. Wrapped as `esp32-devtool bake-creds` manifest extension. |
| `tests/hil/` | pytest-embedded HIL suite. |
| `docs/README.md` | Full user-facing dev setup + daily-loop reference. Read this on first contact with the subproject. |
| `docs/build-profiles.md` | Debug vs prod build profile matrix, prod flash checklist, TLS pinning rationale. Read before flashing any non-dev cube. |
| `.e2e-testing` | Gitignored creds + runbook. Required for build (`bake-creds.sh` reads it). |

## Daily dev surface

```sh
# Device-side (esp32-devtool is the only entry point)
esp32-devtool flash --profile debug                 # flash + eager daemon respawn
esp32-devtool cmd state                             # JSON-RPC verb
esp32-devtool screenshot --out /tmp/cube.png        # 480×480 PNG of device screen
esp32-devtool ui dump-tree                          # structural LVGL tree

# Host UI iteration (agent-driveable, no flash)
cd esp32/cube/lvgl-sim && cmake --build build -j
./build/sentient_cube_lvgl_sim --snapshot /tmp/sim.png   # then `Read /tmp/sim.png`

# Inspect daemon ring buffer (boot trace + recent activity)
esp32-devtool daemon ring --lines 20000

# Wedged cube — JTAG full thread dump
esp32-devtool gdb --batch

# Decode a panic backtrace address
~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20251107/xtensa-esp-elf/bin/xtensa-esp32s3-elf-addr2line \
  -e esp32/cube/firmware/build/sentient_cube.elf -pfiaC <hex-addr>
```

## Hardware notes (carry-over from Phase 1)

- AXP2101 PMIC: `PowerOff()` is non-volatile — never call it. Phase 1 removed `OnShutdownRequest`.
- Pmic ctor register order matters: set voltages first, enable ALDO1 once, never disable mid-sequence (ALDO1 sources the I²C pullup).
- WiFi RF turn-on causes I²C transients. Touch indev MUST use `SafeTouchReadCb` (Phase 1) not vendor `lvgl_port_add_touch` (uses fatal `ESP_ERROR_CHECK`).
- CST9217 touch flags: `{swap_xy=1, mirror_x=0, mirror_y=1}` (Phase 2 calibration — xiaozhi upstream's `{0,1,1}` was a 90° rotation off because their UI is button-based, never exercised absolute coords).
- `CONFIG_NEWLIB_NANO_FORMAT=y` disables `%lld`. Cast to `(unsigned long)` + `%lu` in any `snprintf` for esp_timer_get_time / 64-bit values.

## Architecture (1-paragraph)

xiaozhi-esp32 was vendored at SHA `b72945a` and trimmed in place (~80 KLOC removed: OTA, MCP, MQTT, wake words, demuxer, 30+ alternate board dirs). Dev/debug surface lives in `esp32/devtool/` (host-side CLI) + `esp32/devtool/firmware/esp32_devtool_companion/` (USB-CDC verbs + HTTP endpoints + log_relay) — both fully stripped from prod builds. The sentient-cube board class merges the original waveshare AMOLED 2.16 board with the sentient additions into a single file — `firmware/main/boards/sentient-cube/sentient_cube.cc`. Boot UI for Phase 2..5 is the test screen (`firmware/ui-shared/test_screen.c`); Phase 6 (Sentient Connect) restores the toggle-button screen. Display is CO5300 QSPI AMOLED 466×466; touch is CST9217 via shared I²C. WS protocol is the only protocol path (MQTT removed at compile time). PASETO auth + WiFi creds bake into `firmware/main/sentient_creds.h` at build time via `scripts/bake-creds.sh` reading `.e2e-testing`.

## Phase docs

- Active spec: `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md`
- Phase 1 handover: `docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md`
- Phase 2 handover: `docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md`
- Phase 2 plan: `docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase2-display-touch.md`
