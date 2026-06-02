# ESP32 Cube

ESP32-S3 voice frontend for Sentient. Runs on a Waveshare
ESP32-S3-Touch-AMOLED-2.16 board, connects to the local Sentient gateway over
WiFi (single WebSocket, binary audio + JSON control), authenticates with a
PASETO v4.local token, and drives toggle-to-talk interaction via the 466×466
AMOLED touchscreen. All firmware sources are vendored into a flat owned
`esp32/cube/firmware/` tree — no submodule, no patches over an upstream.

## 1. First-time host setup

1. Install ESP-IDF v5.5.2. Follow:
   https://docs.espressif.com/projects/esp-idf/en/v5.5.2/esp32s3/get-started/index.html
   Wire `idf_exports.sh` into your shell so `idf.py` is on PATH.
2. Host UI sim toolchain: `brew install sdl2 cmake`
3. tio (optional, recommended over `idf.py monitor`): `brew install tio`
4. HIL pytest venv (Pillow + numpy + pyserial):
   `esp32-devtool setup --hil`

## 2. First-time cube setup

1. Clone the repo (no `--recurse-submodules` — the firmware tree is owned
   in-tree).
2. Author `esp32/cube/.e2e-testing`. Populate the machine-readable block:
   ```
   WIFI_SSID=<network-ssid>
   WIFI_PSK=<network-password>
   GATEWAY_HOST=<Mac-LAN-IP>
   GATEWAY_WS_PORT=8888
   GATEWAY_WS_PATH=/api/v1/ws
   GATEWAY_LOG_PORT=5514
   DEVICE_ID=cube-001
   PASETO_TOKEN=<token>
   ```
   Mint the PASETO token (5-year expiry):
   `cd gateway && bun run scripts/mint-cube-token.ts cube-001 <userId>`.
   Paste the token into `PASETO_TOKEN=`.
3. Build: `cd esp32/cube/firmware && idf.py build`
4. Flash (eager-respawns the daemon — see §3):
   `esp32-devtool flash --profile debug`

## 3. Daily dev loop

### Device-side

```
cd esp32/cube/firmware && idf.py build
esp32-devtool flash --profile debug
```

`esp32-devtool flash` eager-respawns the daemon immediately after `idf.py
flash`, so the daemon's reader thread is online before the cube reboots.
Boot trace from ROM bootloader (`ESP-ROM:esp32s3-...`) through the first
`IDLE` state lands in the daemon ring buffer (maxlen 20000) starting at
t=0. No separate `monitor` session needed — the ring buffer is canonical
(`esp32-devtool daemon ring --lines 20000`).

```
esp32-devtool cmd state
esp32-devtool cmd button.toggle
esp32-devtool cmd mark --params '{"label":"dev-marker"}'
esp32-devtool screenshot --out /tmp/cube.png   # 480x480 PNG
esp32-devtool ui dump-tree                     # structural
```

### Host-side UI iteration (lvgl-sim)

For LVGL widget changes, the host SDL2 sim is ~15× faster than flashing.
Edit-build-snapshot loop is ~2 s:

```
cd esp32/cube/lvgl-sim
cmake --build build -j
./build/sentient_cube_lvgl_sim --snapshot /tmp/sim.png
```

Then `Read /tmp/sim.png` in the agent session. Windowed mode (no flag) opens
an SDL2 window for mouse-as-touch iteration. The sim compiles the same
`firmware/ui-shared/test_screen.c` the device runs. Per spec §7 scope guard,
**device smoke is always required** — a green sim run never replaces a
device flash + smoke. See `.claude/rules/esp32/cube/lvgl-sim.md`.

## 4. Agent-callable verbs

JSON-RPC 2.0 over USB-CDC. Send via `esp32-devtool cmd <verb> [--params json]`.
Response lands as `<<< RSP <json>`; async events as `<<< EVT <json>`.

| Verb | Purpose |
|---|---|
| `state` | Current device state (IDLE / LISTENING / SPEAKING / ...) |
| `mark` | Insert a labelled marker into the daemon ring buffer |
| `events` | Dump the daemon's recent ring-buffer lines |
| `ui.dump_tree` | Structural tree of the active LVGL screen |
| `ui.snapshot` | 480×480 RGB888 PNG of the active screen (chunked EVTs) |
| `audio.inject_pcm` | Push synthetic 16 kHz mono PCM frames into the mic path |
| `tts.cancel` | Cancel an in-flight TTS playback |
| `log_level` | `{"tag":"sentient.cube.board","level":"DEBUG"}` |
| `wifi.connect` / `wifi.disconnect` | Manual WiFi control |
| `ws.disconnect` | Drop the gateway WebSocket |
| `button.toggle` | Synthetic toggle-to-talk press |
| `restart` | Soft restart the cube |

## 5. EVT types

Async events on USB-CDC, prefixed `<<< EVT`:

- `touch.tap` — `{"event":"touch.tap","x":N,"y":N,"ts_us":N}`. Emitted on
  every physical press→release by `SentientTouchReadCb`. `ts_us` is 32-bit
  unsigned-long; rollover at ~71 min uptime is acceptable for tap ordering.
- `ui.snapshot.chunk` / `ui.snapshot.done` — paginated PNG payload from
  `ui.snapshot`. Reassembled by `esp32-devtool screenshot`.
- `<verb>.done` — completion signal for any long-op verb that returned
  `{"ok":true,"in_flight":true}`.

Boot/transition markers (same stream, different prefix):
- `>>> READY` — devtool companion accepting commands.
- `>>> CHECKPOINT <event> <ts_us>` — `wifi.connected`, `ws.connected`,
  `listen.start`, etc. HIL gates wait on these.

## 6. Stuck-cube recovery

If firmware is crash-looping or USB CDC goes silent and `idf.py flash` hangs
at "Connecting...":

1. Unplug USB-C from Mac.
2. Hold the BOOT button on the cube.
3. Plug USB-C back in while still holding BOOT.
4. Release BOOT.
5. Re-flash: `esp32-devtool flash --profile debug`

The chip is in download mode and accepts the flash normally. After AXP2101
PMIC fault recovery, restart the smoke bar from scratch — see
`.claude/rules/esp32/cube/flash-discipline.md`.

## 7. JTAG escalation

When the cube is wedged and serial logs aren't enough, dump full thread-state
+ backtrace via the built-in ESP32-S3 JTAG — no external probe required:

```
esp32-devtool gdb --batch
```

The command starts OpenOCD (built-in USB-Serial-JTAG target), attaches gdb,
dumps all thread backtraces + register state, then exits.

## 8. Panic decoding (addr2line)

`LoadProhibited` / `IllegalInstruction` / `StoreProhibited` panics print
backtraces of raw `0x40...` addresses. Decode to `file:line`:

```
~/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20251107/xtensa-esp-elf/bin/xtensa-esp32s3-elf-addr2line \
  -e esp32/cube/firmware/build/sentient_cube.elf -pfiaC <hex-addr>
```

Pass multiple addresses on one line to decode the full backtrace at once.
Phase 2 used this to pin a `LcdDisplay::SetChatMessage` NULL-deref to its
exact source frame.

## 9. HIL smoke

```
esp32-devtool setup --hil                         # one-time
(cd esp32/cube/tests/hil && ../../../.venv/bin/pytest -m group_a)  # unattended
```

Group B (agent-driven + human confirm) and Group C (physical actions) require
a runbook — see `agents/docs/esp32/cube/testing-details.md` and
`esp32/cube/.e2e-testing#group-c-runbook`.

## 10. Architecture

- Flat owned firmware tree at `esp32/cube/firmware/`. Every component is
  vendored and edited in place — no submodule, no overlay, no numbered
  patches. Files we don't need from upstream xiaozhi are deleted; the
  keep-list is the working tree.
- `firmware/main/boards/sentient-cube/sentient_cube.cc` is the board entry:
  AXP2101 PMIC init, I²C bus probe, touch driver wiring, parent
  `SpiLcdDisplay::SetupUI()` invocation.
- Dev/debug surface is owned by `esp32/devtool/` — host CLI (`esp32-devtool`)
  + the `esp32_devtool_companion` ESP-IDF component (USB-CDC JSON-RPC verb
  dispatcher + HTTP endpoints + UDP log_relay). Verbs live under
  `firmware/main/devtool_verbs/` (one file per verb); HTTP handlers live
  under `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/`.
  `WHOLE_ARCHIVE` linkage preserves `__attribute__((constructor))` registry.
  The companion compiles to ~0 bytes in prod via the
  `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` stub. Log relay tees `ESP_LOGx`
  to the gateway via UDP once WiFi is up; pre-WiFi logs go to USB-CDC only.
- `firmware/ui-shared/` is target-agnostic LVGL widget code, pure public API
  only — no platform headers. Compiles on both device and `lvgl-sim/`.
- `esp32/cube/lvgl-sim/` is a HOST SDL2 build pinned to LVGL `v9.5.0` (matches
  the device managed component). Windowed + headless `--snapshot` modes.
- Device state machine: `IDLE → LISTENING → SPEAKING → IDLE`. Boot UI flips
  per phase so each transition is visible without log scraping.
- Auth: PASETO v4.local token baked at build via the machine-readable block
  in `.e2e-testing` (gitignored `sentient_creds.h`). Pre-commit hook blocks
  accidental WiFi-password staging.
