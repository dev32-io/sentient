# esp32-devtool Roadmap

Planned capabilities beyond the v1 foundation.

## GDB Extras

- `gdb panic-decode` — parse IDF panic dump from serial log, symbolicate with addr2line,
  print annotated backtrace without needing a live GDB session.
- `gdb multi-thread` — attach OpenOCD + GDB, enumerate FreeRTOS tasks, inspect
  per-task stack and registers interactively.

## sdkconfig Diff

- `sdkconfig diff <profile-a> <profile-b>` — compare two build profiles' sdkconfig
  snapshots, highlight security-relevant differences (flash encryption, JTAG disable,
  log level in prod).

## OTA Pipeline

- `flash --ota` — push a signed firmware image over HTTP to the device's OTA partition
  without a USB cable; device reboots into new image.
- `flash --rollback` — trigger OTA rollback if the new image fails health check within
  the watchdog window.

## Auth / RBAC

- Reverse-proxy patterns for restricting devtool HTTP endpoints in shared-lab
  environments (see `docs/HTTP-CONTRACT.md` Authentication section).
- Token-based auth header support for `--token` flag when a proxy is in the path.

## Additional Chip Support

- ESP32-P4 board manifest + companion component (dual-core, no WiFi built-in).
- ESP32-C6 / ESP32-C3 minimal support (no display, audio subset only).
- Generic fallback manifest for unknown boards with USB-CDC console.
