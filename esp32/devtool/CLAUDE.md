# esp32-devtool — Agent Rules

Agent-facing guide for working inside `esp32/devtool/`. Read this before touching any
file in this directory.

## Invocation Pattern

```
esp32-devtool [GLOBAL FLAGS] <command> [COMMAND FLAGS] [ARGS]
```

Global flags available on every command:

| Flag            | Effect                                              |
|-----------------|-----------------------------------------------------|
| `--board <name>`| Override board auto-detect; load `boards/<name>.yaml` |
| `--port <path>` | Override serial port (e.g. `/dev/cu.usbmodem1234`) |
| `--json`        | Machine-readable output (NDJSON for streaming cmds) |
| `--verbose`     | Debug-level logging to stderr                       |
| `--timeout <s>` | Override default operation timeout (seconds)        |

## Board Auto-Detect

1. If `--board <name>` given: load `boards/<name>.yaml`. Done.
2. Scan `/dev/cu.usbmodem*` (macOS) or `/dev/ttyUSB*` / `/dev/ttyACM*` (Linux).
3. Match each port against `boards/*.yaml` by VID/PID or MAC read via esptool.
4. Exactly 1 match → use; cache to `~/.config/esp32-devtool/last-board`.
5. Zero matches → exit 3 with hint to pass `--board`.
6. Multiple matches → exit 3 with hint to pass `--board=<name> --port=<path>`.

Cache key: `(port, manifest_mtime)`. Auto-invalidated on change.

## Transport Routing

Each capability declares its transport in the board manifest:

- `usb-cdc` — routed through the background daemon (auto-spawned via
  `transport.usb_cdc.ensure_daemon(port)`). Daemon idles out after 60 s of no clients.
- `http` — direct HTTP to board's LAN IP, discovered from `/info` endpoint or mdns.
- `auto` — CLI picks the best available transport (prefer USB-CDC when connected,
  fall back to UDP for `logs`).

## Exit Codes

| Code | Constant                  | Meaning                                     |
|------|---------------------------|---------------------------------------------|
| 0    | `EXIT_OK`                 | Success                                     |
| 2    | `EXIT_BAD_USAGE`          | Bad arguments / flags (mirrors `click`)     |
| 3    | `EXIT_BOARD_NOT_FOUND`    | No board matched or `--board` name unknown  |
| 4    | `EXIT_TRANSPORT_UNAVAILABLE` | Daemon failed / HTTP unreachable         |
| 5    | `EXIT_VERB_ERROR`         | Firmware returned error from JSON-RPC verb  |
| 6    | `EXIT_TIMEOUT`            | Operation did not complete within timeout   |

All error classes live in `cli/errors.py`. Catch `DevtoolError` at the CLI boundary;
its `.exit_code` maps directly to the table above. `.next_step` is printed as a hint.

## When to Use `--json`

Prefer `--json` in:
- HIL test scripts (parse structured output, never scrape human text)
- CI pipelines (snapshot size checks, firmware version assertions)
- Chained shell pipelines (`esp32-devtool info --json | jq .firmware`)

Human-readable output is the default; it may change format between versions.

## Log File Location

- Daemon logs: `/tmp/esp32-devtool/<port-hash>.log`
- CLI verbose output: stderr only (never mixed into stdout)
- Port hash: `sha256(port_path)[:8]`

## Code Layout

```
cli/
  main.py          — Click entry point + PEP-723 dep header (written in Task 2)
  version.py       — __version__ string
  errors.py        — Exit codes + typed error hierarchy
  commands/        — One module per top-level command
  transport/       — USB-CDC daemon client + HTTP client
  daemon/          — Daemon process + socket server
boards/
  _schema.yaml     — Board manifest JSON schema
  cube.yaml        — Sentient Cube board definition
firmware/
  esp32_devtool_companion/  — ESP-IDF component (written in Tasks 9-11)
docs/
  HTTP-CONTRACT.md — Frozen wire spec; board implementers conform
  BOARD-MANIFEST.md — Board manifest schema + cube example
  ROADMAP.md       — Future capability ideas
tests/
  conftest.py      — sys.path setup
  unit/            — Pure unit tests (no hardware)
  e2e/             — Hardware-in-loop tests (require connected board)
```

## Rules

- Never import from `esp32/cube/` — devtool must be board-agnostic.
- Board-specific logic lives in board manifests (YAML), not Python.
- All new commands go in `cli/commands/<command>.py` — one file per command.
- Exit via `sys.exit(error.exit_code)` at the Click boundary only. Never inside logic.
- Tests in `tests/unit/` must run with zero hardware attached.
