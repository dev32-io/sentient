# ESP32 Cube

Waveshare ESP32-S3-Touch-AMOLED-2.16 voice client. Application firmware is owned in [`../firmware/`](../firmware/); board adaptation lives in `firmware/main/boards/sentient-cube/`. Gateway wire contract lives in [`shared/protocol/`](../../../shared/protocol/). Firmware uses current gateway manual-capture protocol: hold touchscreen button to capture, release to submit; assistant playback uses Opus. WSS enforces certificate trust and hostname verification. End-to-end voice behavior remains device-unverified. A successful build is not device smoke.

## Host workflow

1. Source [`scripts/env.sh`](../../../scripts/env.sh) from repository root. It puts external `esp32-devtool` submodule CLI on PATH and points `ESP32_DEVTOOL_BOARDS_DIR` at [`../devtool/boards/cube.yaml`](../devtool/boards/cube.yaml). Initialize submodule if absent (`git submodule update --init esp32/devtool`). Use reviewed submodule revision, not old in-tree devtool instructions.
2. Use ESP-IDF >=5.5.2. See [build profiles](build-profiles.md) for isolated debug/prod sdkconfig, offline provisioning, and build-only checks. Flash does **not** bake credentials. Never flash placeholder credentials or a compile-only image without approved provisioning and hardware access.
3. For approved local device work, use `esp32-devtool --json info` to inspect selection; global flags (`--board`, `--port`, `--boards-dir`, `--json`) go **before** subcommand. Device commands include `esp32-devtool cmd state`, `esp32-devtool daemon ring --port <selected-port>`, `esp32-devtool screenshot --out <private-path>`, and, only with explicit authorization, `esp32-devtool flash --profile debug`. Daemon owns USB serial; do not run competing monitor or serial reader. Debug companion exposes unauthenticated LAN HTTP; Enable it only with explicit approval for the development network. **No device flash or runtime smoke is approved by these docs.** Prod flash is not approved.

Source of truth: [cube AGENTS](../AGENTS.md), [repository AGENTS](../../../AGENTS.md), [build details](../../../agents/docs/esp32/cube/build-details.md), [flash discipline](../../../agents/docs/esp32/cube/flash-discipline-details.md), and [devtool README](../../devtool/README.md). HTTP screenshots use devtool companion, not a `ui.snapshot` USB verb. Avoid old HIL runbooks and `.claude` paths until reconciled with current source.

## Hardware constraints

Preserve AXP2101 PMIC bring-up order and disabled shutdown (shutdown can latch power off); keep safe transient CST9217 touch reads and calibrated `swap_xy=1, mirror_x=0, mirror_y=1`. Keep audio and diagnostic buffers bounded; host-side conversion avoids extra device memory pressure. Shared `firmware/ui-shared/` LVGL code also compiles in host simulator, but simulator cannot prove physical touch, audio, or memory behavior. See [`../AGENTS.md`](../AGENTS.md) before changing hardware paths.
