---
paths:
  - "esp32/cube/firmware/**"
---
# ESP32 Cube Logging Rules

> When a rule is unclear, read `agents/docs/esp32/cube/logging-details.md`.

- Tag hierarchy: `sentient.cube.<area>` or `sentient.cube.<area>.<subarea>`.
  Examples: `sentient.cube.board`, `sentient.cube.ui.toggle`,
  `sentient.cube.devtool`.

- All `ESP_LOGx` calls are automatically teed through the
  `esp32_devtool_companion` log_relay (UDP NDJSON to gateway:9000 after
  WiFi up). Same lines land on USB-CDC AND on the gateway UDP sink. No
  special call per file.

- Pre-WiFi logs land on USB-CDC only. This is an accepted gap — the gateway log
  file may have a 2-5s window missing from boot. Do not try to buffer or replay.

- The `device_id=<id>` token MUST be present for the gateway sink's deviceId
  extractor. The companion's log_relay prepends `device_id=<id>` automatically
  to any line that doesn't already contain it. Do not duplicate it manually.

- Truncate string previews to ≤120 chars (matches root `.claude/rules/logging.md`).
  Never dump raw buffers, full PASETO tokens, WiFi PSKs, or binary audio.

- Boundary stdout markers (`>>> CHECKPOINT`, `>>> READY`, `<<< RSP`, `<<< EVT`)
  use `printf` directly and intentionally bypass the devtool log_relay. They
  appear on USB-CDC only. HIL parses them via the serial reader — not via
  gateway logs. Do NOT route them through `ESP_LOGX`.

- Log every state transition with previous state, new state, and trigger.
  Log every WiFi + WS connect/disconnect event with a reason field.
  Log every cycle dispatch and completion with `cycle_id`.
