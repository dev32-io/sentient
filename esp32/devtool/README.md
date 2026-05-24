# esp32-devtool

One tool to rule all ESP32 development operations — flash, logs, screenshot, touch
injection, audio capture/inject, USB-CDC verb dispatch, GDB panic decode, and more.

## Why

The `esp32/cube/scripts/` directory grew to 8 shell scripts and 4 Python helpers with
overlapping setup, no shared transport layer, and no test surface. `esp32-devtool`
replaces every one of them with a single entry point and a typed, testable CLI.

## Capabilities

| Command           | Transport      | Description                                     |
|-------------------|----------------|-------------------------------------------------|
| `info`            | HTTP / USB-CDC | Device info, capabilities, firmware version     |
| `flash`           | USB-CDC        | Build + flash firmware (debug or prod profile)  |
| `logs`            | USB / UDP      | Stream device logs; filter by tag or level      |
| `screenshot`      | HTTP           | Capture display frame as PNG / JPEG / rgb565    |
| `cmd`             | USB-CDC        | Dispatch JSON-RPC verb to firmware              |
| `touch`           | HTTP           | Inject synthetic touch event at (x, y)          |
| `audio record`    | HTTP           | Record PCM16 audio from device microphone       |
| `audio inject`    | HTTP           | Push PCM16 audio into device speaker path       |
| `gdb`             | USB-CDC        | Attach GDB; decode panic backtraces             |
| `setup`           | local          | Check / install host toolchain dependencies     |
| `daemon`          | local          | Manage the background USB-CDC proxy daemon      |
| `ui`              | HTTP           | Composite screenshot + touch scripting          |
| `audit-prod-strip`| local          | Verify no devtool symbols leak into prod ELF    |

## Install

`esp32-devtool` runs via [uv](https://github.com/astral-sh/uv) — no venv setup needed:

```bash
source scripts/env.sh          # adds esp32/devtool/bin to PATH
esp32-devtool --help
```

Or run directly:

```bash
uv run esp32/devtool/bin/esp32-devtool info
```

Runtime dependencies are declared in the PEP-723 header of `cli/main.py`; `uv` resolves
them on first run. Dev/test deps live in `pyproject.toml`.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).
