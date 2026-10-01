# ESP32 Cube Logging — Details

## Sources and relay

The current firmware uses the devtool companion's `log_relay`, not the retired
`net_logger`. The project manifest `esp32/cube/devtool/boards/cube.yaml` and current debug defaults disable UDP relay; **9000** is the configured port if it is enabled. Consult that manifest and `esp32/devtool/docs/BOARD-MANIFEST.md` rather than hard-coding a port. USB/ring is the default path; UDP absence is not a firmware failure.

`esp32-devtool logs` and `daemon ring` are the supported host views. USB-CDC
captures early/pre-WiFi output; UDP relay is best-effort after WiFi is available.
Never add credentials, tokens, transcripts, raw audio, or other sensitive payloads
to logs. Use identifiers, types, sizes, transitions, and sanitized diagnostics. USB verb replies also enter daemon rings: tree dumps and `sentient.last_transcript` are content-bearing, not safe substitutes for logs. See [agent console details](agent-console-details.md).

## Markers

Use the existing protocol/checkpoint markers for machine synchronization (for
example `>>> READY`, `>>> CHECKPOINT ...`, `<<< RSP`, and `<<< EVT`). Do not use
ad-hoc `printf` for ordinary diagnostics; use the project logging APIs. Keep
markers stable because HIL fixtures parse them.

For a new log path, preserve the manifest-configured transport and JSON/line
contract. Validate the host side without hardware using devtool unit tests and
fixtures; do not assume the relay is enabled in every profile.
