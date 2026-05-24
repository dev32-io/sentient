# Sentient Cube — LVGL PC Simulator

Host (macOS/Linux) SDL2 build of the Sentient Cube UI for fast UI iteration
without flashing. Compiles the same `firmware/ui-shared/test_screen.c` that
the device runs, rendering it in a 466×466 SDL2 window with mouse-as-touch
input. Edit → build → run is ~2s; the device's edit → build → flash → boot
→ smoke loop is ~30s.

## Scope guard

Per spec §7, this simulator is a UI-iteration aid only. **It never replaces
device smoke.** A green sim run is NOT evidence the device works. Device
smoke is always required.

Specifically, the sim does NOT exercise:
- `esp_lcd_panel_draw_bitmap` async-done callback timing.
- LVGL display-lock contention with the agent_console event-emit path.
- Real DMA refresh, tearing, panel-IO latency.
- `agent_console_event` emission on tap — that path is device-only.

If a UI bug only appears in one of these axes, the sim will look fine while
the device is broken. Always device-smoke before declaring done.

## Pinned versions

| Component | Version | Source |
|---|---|---|
| LVGL | `v9.5.0` | https://github.com/lvgl/lvgl |
| `lv_conf.h` template SHA256 | `2ece178f34500cbb3755980c1520daee4d15fd2f0893fc68672958708c9c6291` | `firmware/managed_components/lvgl__lvgl/lv_conf_template.h` |
| SDL2 | system Homebrew (`sdl2` 2.32.10 tested) | `brew install sdl2` |

The sim's `lv_conf.h` (next to this README) is hand-mirrored from
xiaozhi's Kconfig in `firmware/sdkconfig.defaults` + the LVGL managed
component's Kconfig. Device-side LVGL config is generated from Kconfig and
lives in the regenerated (gitignored) `firmware/sdkconfig`.

## First-time setup (macOS)

```sh
# 1. SDL2 dev headers
brew install sdl2 cmake

# 2. Clone LVGL at the pinned version next to this README.
cd esp32/cube/lvgl-sim
git clone --depth 1 --branch v9.5.0 https://github.com/lvgl/lvgl lvgl

# 3. Configure + build (point find_package at Homebrew's SDL2 install)
cmake -B build -S . -DSDL2_DIR=$(brew --prefix sdl2)/lib/cmake/SDL2
cmake --build build -j
```

Expected: `build/sentient_cube_lvgl_sim` produced, ~1 MB arm64 binary
(Apple Silicon) or x86_64 binary (Intel Mac).

## Run

```sh
./build/sentient_cube_lvgl_sim
```

An SDL2 window pops up titled "Sentient Cube — lvgl-sim". Close the window
or hit Cmd+W to exit cleanly.

The window shows:
- Deep blue background (`0x0a1f33`)
- Horizontal gradient bar (centered)
- "SENTIENT CUBE" label (above the bar)
- Spinner (below the bar, ~1.5 Hz rotation)

Left-click + drag in the window — the heatmap dot follows the cursor while
the mouse button is held. (The sim does NOT emit `<<< EVT touch.tap` —
that's device-only via `SentientTouchReadCb` in `sentient_cube.cc`.)

### Headless snapshot mode

For agentic UI iteration without opening a window:

```sh
./build/sentient_cube_lvgl_sim --snapshot /tmp/sim.png
```

Runs LVGL for ~500ms simulated time (long enough for the spinner to
settle into a clearly-rotated state), dumps the 466×466 RGB framebuffer
as a PNG, and exits. No SDL2 window opens. Useful for automated visual
parity checks against device `ui.snapshot` output.

PNG encoding uses the bundled `main/stb_image_write.h` (single-header
public domain, pinned to nothings/stb v1.16 — sha256
`cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05`).

## Iteration loop

Edit any of:
- `../firmware/ui-shared/test_screen.c` — shared LVGL widget construction
- `../firmware/ui-shared/test_screen.h` — public API
- `lv_conf.h` — sim LVGL config (touches sim only — device-side equivalent
  is `firmware/sdkconfig.defaults`)

Then:

```sh
cmake --build build -j && ./build/sentient_cube_lvgl_sim
```

Round-trip is ~2 seconds (incremental build + binary launch). The device's
smoke loop is ~30 seconds (build + flash + boot + ui.snapshot).

## Update flow (when LVGL has a new release we want to track)

The LVGL managed component on the device (`firmware/main/idf_component.yml`)
and the LVGL clone here MUST move together — otherwise `lv_conf.h` defaults
drift between targets.

1. Bump the LVGL version in `firmware/main/idf_component.yml`.
2. `idf.py reconfigure` (from `firmware/`) to fetch the new managed
   component into `firmware/managed_components/lvgl__lvgl/`.
3. Run a device build — verify it stays green with the new LVGL.
4. Audit `firmware/managed_components/lvgl__lvgl/Kconfig` for any new
   `CONFIG_LV_USE_*` flags. If a flag the test screen / future ui-shared
   modules need has changed name or default, update both
   `firmware/sdkconfig.defaults` (device) AND `esp32/cube/lvgl-sim/lv_conf.h`
   (sim).
5. Re-record the template SHA256 in the pinned-versions table above:
   ```sh
   shasum -a 256 firmware/managed_components/lvgl__lvgl/lv_conf_template.h
   ```
6. Re-clone the sibling `lvgl/` directory at the new tag:
   ```sh
   cd esp32/cube/lvgl-sim
   rm -rf lvgl build
   git clone --depth 1 --branch v<NEW-VERSION> https://github.com/lvgl/lvgl lvgl
   cmake -B build -S . -DSDL2_DIR=$(brew --prefix sdl2)/lib/cmake/SDL2
   cmake --build build -j
   ```
7. Re-run the sim and a device flash + smoke; visual-compare ui.snapshot
   output between the two.
8. Commit `firmware/main/idf_component.yml` + `firmware/dependencies.lock`
   + `lvgl-sim/lv_conf.h` (if changed) + `lvgl-sim/README.md` (this file's
   pinned table) as one commit titled
   `chore(esp32-cube/lvgl): bump LVGL to v<NEW-VERSION>`.

## What this sim does NOT do

(See "Scope guard" above for the full list.) Briefly: no DMA, no real
panel IO, no `agent_console` plumbing, no device-state machine, no audio,
no WiFi. It is a pure LVGL widget rendering harness.

## Troubleshooting

- **`fatal error: 'SDL.h' file not found`** — SDL2 dev headers are missing.
  `brew install sdl2`.
- **`Could NOT find SDL2`** — Add `-DSDL2_DIR=$(brew --prefix sdl2)/lib/cmake/SDL2`
  to the `cmake -B build` command.
- **Blank black window** — `lv_display_flush_ready` was probably not
  called. Check `main/sdl2_driver.c` `flush_cb`.
- **`LVGL source not found at .../lvgl`** — Step 2 of "First-time setup"
  was skipped. Clone the pinned LVGL tag (see CMakeLists.txt FATAL_ERROR
  message for the exact command).
- **`Sim-side lv_conf.h not found`** — `git checkout HEAD -- lv_conf.h`
  to restore from the repo.
- **`Sentient owned lv_conf.h not found`** — Phase 2 Task 4 must be
  committed first.
- **macOS Apple Silicon: SDL2 prefix is `/opt/homebrew/opt/sdl2`.**
- **macOS Intel: SDL2 prefix is `/usr/local/opt/sdl2`.**
- **Linux: use system SDL2 (`apt install libsdl2-dev` on Debian/Ubuntu;
  `dnf install SDL2-devel` on Fedora). `find_package(SDL2)` should
  resolve without the `-DSDL2_DIR` override.**
- **Sim binary crashes immediately:** check `LVGL` version matches the
  pinned `v9.5.0`. Mismatched LVGL versions (clone vs lv_conf.h) cause
  struct-layout mismatches.
- **`SDL2 init failed under dummy driver`** — `SDL_VIDEODRIVER=dummy` is
  available in SDL2 since ~2.0. Your installed SDL2 may be too old.
  `brew upgrade sdl2`.
