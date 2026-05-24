# esp32-devtool — Foundation Design

**Date:** 2026-05-15
**Branch (proposed):** `feature/esp32-devtool-foundation` off `feature/phase6-cube-sdk`
**Status:** Design — awaiting user approval
**Predecessor context:** Phase 6a smoke surfaced fundamental snapshot-transport unreliability (USB-Serial-JTAG drops bytes under burst). Two USB-CDC fix attempts reverted. Decision: rebuild the entire agent dev-tool surface into one unified CLI that switches USB-CDC ↔ HTTP per capability.

## Goal

One CLI, agent-friendly, **adb-style**, that consolidates every host-side ESP32 dev/debug operation currently scattered across 8 shell + 4 Python scripts. Encapsulates:

- USB-CDC daemon mgmt (auto-spawn, idle-kill, port-scoped)
- HTTP transport for high-throughput operations (screenshot, audio I/O, touch)
- Per-verb transport routing via a board manifest
- Auto-detect of connected boards + multi-board support
- Live log streaming (merged USB ring + UDP relay)
- Firmware-side companion ESP-IDF component (reference impl)
- Compile-out to zero footprint in prod builds

End state: **one binary, one tool, one mental model** for the agent. The legacy `_cube_daemon.py`, `cube-cmd.sh`, `cube-snapshot.sh`, `flash.sh`, `find-port.sh`, `setup-hil.sh`, `gdb-batch.sh`, plus the underlying `_cube_cmd_helper.py` / `_cube_snapshot_helper.py` all retire.

## Non-goals

- Replace `idf.py` / `esptool.py`. Devtool *uses* them under the hood.
- Build-system orchestration beyond `esp32-devtool flash`. CMake stays as-is.
- Cross-chip code generation. Each board ships its own firmware; devtool is host-side only.
- Network deployment / OTA pipeline. Roadmap, not v1.
- Authentication / RBAC. v1 assumes trusted LAN. Auth is documented as an OSS-extraction add-on.
- Replace `bake-creds.sh` internals. Bake-creds is a transient pre-device-pairing hack that lives as an extension (devtool exec's it verbatim); both retire when proper pairing lands.

## Why now

1. **Snapshot foundation collapse.** Phase 6a's `ui.snapshot` USB-CDC chunk pipeline is unfixable in its current shape — two patches reverted because USB-Serial-JTAG drops bytes when host stalls (documented Espressif limitation).
2. **Agent overhead.** Today an agent juggles 8+ scripts with inconsistent argument shapes, daemon mgmt, port detection, transport choice. Single tool collapses all of this.
3. **Reusability cliff.** Snapshot fix work would have re-invented HTTP/log/daemon plumbing for one verb. Better to build the foundation once.
4. **OSS prep.** The user wants this extractable as a standalone tool. Mono-repo coupling needs to be designed away from day one.

## Top-level decisions (from brainstorming)

| Decision | Choice |
|---|---|
| v1 scope | snapshot + logs + flash + cmd + touch + audio I/O; extensible to GDB, panic-decode, sdkconfig diff, OTA later. |
| Grammar | Hybrid: top-level verbs + global flags. `esp32-devtool [GLOBAL FLAGS] <command> [ARGS]`. |
| Genericity | Tool-generic; per-board YAML manifest under `boards/<name>.yaml`. |
| Transport policy | Auto-route per-verb based on manifest. USB-CDC for low-byte/lifecycle/pre-WiFi. HTTP for high-throughput post-WiFi. |
| Daemon | Auto-spawn on first invoke, idle-kill (10 min default). |
| Language | Python with PEP-723 inline-deps + `uv run --script` shim. |
| Board ID | Auto-detect from connected USB + `--board` override. |
| Live logs | Merged daemon-ring (USB) + UDP relay stream. |
| Firmware companion | Ship reference ESP-IDF component (`esp32_devtool_companion`). |
| `agent_console` + `net_logger` (today) | Subsumed by the new firmware companion. |
| `bake-creds.sh` | Wired as a manifest extension; marked `transient: true`. |

## Architecture overview

```
                          host                                cube (ESP-IDF firmware)
                          ────                                ───────────────────────
   ┌─────────────────────────────────────────┐         ┌─────────────────────────────────────┐
   │ esp32-devtool <cmd>                     │         │ esp32_devtool_companion component   │
   │   ↓                                     │         │   ├─ usb_cdc_reader (verb dispatch) │
   │ cli/main.py (PEP-723 uv-run)            │         │   ├─ http_server (esp_http_server)  │
   │   ├─ board.py — auto-detect + manifest  │         │   ├─ log_relay (UDP shipper)        │
   │   ├─ transport/router.py                │         │   └─ handlers/                      │
   │   │    ├─ usb_cdc.py — daemon client    │         │       ├─ info.cc   (GET /info)      │
   │   │    └─ http.py — requests client     │         │       ├─ screenshot.cc              │
   │   ├─ daemon/server.py — port-holder     │  USB    │       ├─ touch.cc                   │
   │   │   + UNIX socket bridge               │ ─CDC─→ │       ├─ audio_record.cc            │
   │   └─ commands/*.py — per-verb modules    │         │       └─ audio_inject.cc            │
   └─────────────────────────────────────────┘         └─────────────────────────────────────┘
                          ↑      ↑                                  │
                          │      │ HTTP                              │
                          │      └────────────────────────────────────┘
                          │
                          │ UDP log datagrams (post-WiFi)
                          └──────────────────────────────────────────
```

Two halves connected by:
- **USB-CDC JSON-RPC** (`>>> CMD` / `<<< RSP` / `<<< EVT` text-line wire format; preserved verbatim from today's agent_console for backwards compat).
- **HTTP/1.1** on TCP port 8081 (default) for high-throughput endpoints.
- **UDP** log relay datagrams (post-WiFi), NDJSON one line per packet.

The CLI's `transport/router.py` picks transport per capability based on the board manifest. Single decision point — no per-command transport spaghetti.

## Directory layout

```
esp32/devtool/
├── README.md                          # OSS-facing entry — "ADB for ESP-IDF boards"
├── CLAUDE.md                          # agent-facing rules + invocation patterns
├── LICENSE                            # MIT or Apache-2.0 (extraction-ready)
├── bin/
│   └── esp32-devtool                  # bash entry: `exec uv run --script $DIR/cli/main.py "$@"`
├── cli/
│   ├── main.py                        # PEP-723 inline-deps; argparse/click dispatch
│   ├── board.py                       # manifest loader + auto-detect
│   ├── version.py                     # SemVer
│   ├── transport/
│   │   ├── usb_cdc.py                 # daemon client (UNIX socket)
│   │   ├── http.py                    # HTTP client
│   │   └── router.py                  # manifest-driven dispatch
│   ├── daemon/
│   │   ├── server.py                  # was _cube_daemon.py — board-agnostic
│   │   └── lifecycle.py               # auto-spawn / idle-kill / port scoping
│   └── commands/
│       ├── info.py
│       ├── flash.py
│       ├── logs.py                    # daemon-ring + UDP merge
│       ├── screenshot.py              # HTTP /screenshot → PNG
│       ├── cmd.py                     # USB-CDC JSON-RPC
│       ├── touch.py                   # HTTP /touch
│       ├── audio.py                   # record/play/inject
│       ├── gdb.py                     # openocd + xtensa-gdb pair
│       ├── setup.py                   # devtool deps / hil venv / lvgl-sim
│       ├── daemon.py                  # start/stop/status/ring
│       ├── ui.py                      # dump-tree, tap
│       ├── restart.py                 # = cmd restart
│       └── audit_prod_strip.py        # objdump check
├── boards/
│   ├── _schema.yaml                   # manifest JSON-Schema
│   ├── cube.yaml                      # Sentient cube manifest
│   └── generic-s3-devkit.yaml         # baseline ESP32-S3 dev board
├── firmware/
│   └── esp32_devtool_companion/       # reference ESP-IDF component (subsumes agent_console + net_logger)
│       ├── CMakeLists.txt
│       ├── Kconfig                    # Master switch + per-endpoint gates
│       ├── include/esp32_devtool/
│       │   ├── companion.h            # esp32_devtool_companion_start(cfg)
│       │   ├── verbs.h                # devtool_register_verb(...)
│       │   └── endpoints.h            # devtool_register_http(...)
│       └── src/
│           ├── companion.cc / companion_stub.cc
│           ├── usb_cdc_reader.cc
│           ├── verb_dispatcher.cc
│           ├── http_server.cc
│           ├── log_relay.cc
│           └── handlers/
│               ├── info.cc            # GET /info → {device_id, ip, version, profile, uptime, capabilities, endpoints}
│               ├── screenshot.cc      # GET /screenshot → JPEG/PNG/RGB565
│               ├── touch.cc           # POST /touch — synthetic LVGL indev event
│               ├── audio_record.cc    # GET /audio/record → raw PCM
│               └── audio_inject.cc    # POST /audio/inject → push PCM
├── docs/
│   ├── HTTP-CONTRACT.md               # board-implementer reference
│   ├── BOARD-MANIFEST.md              # schema reference
│   └── ROADMAP.md                     # gdb extras, panic-decode, sdkconfig diff, OTA
├── skills/                            # placeholder for future Claude Code skills built on devtool
│   └── README.md
└── tests/
    ├── unit/                          # cli/* unit tests (stdlib + pytest only)
    └── e2e/                           # parity tests against real cube
```

## CLI grammar

```
esp32-devtool [GLOBAL FLAGS] <command> [COMMAND ARGS]
```

### Global flags

```
--board <name>          override auto-detect (e.g. cube, generic-s3-devkit)
--port <path>           override USB-CDC port auto-detect
--http <url>            override HTTP base URL (skips ip lookup)
--profile <debug|prod>  pick board build profile (informs flash + manifest)
--repo-root <path>      override git-root inference for ${REPO_ROOT} manifest substitution
--quiet / --verbose     log level
--json                  emit machine-readable output
--no-daemon             every USB-CDC call opens its own serial (debug-only)
```

### v1 commands

```
esp32-devtool info                                # GET /info
esp32-devtool flash [--profile debug|prod]        # idf.py flash + daemon recycle
esp32-devtool logs [--follow] [--since 2m] [--filter R] [--source usb|udp|all]
esp32-devtool screenshot [--out PATH] [--format png|jpeg|rgb565]
esp32-devtool cmd <verb> [--param k=v ...]        # USB-CDC JSON-RPC
esp32-devtool touch <x> <y> [--hold MS]
esp32-devtool audio record  --duration MS --out FILE
esp32-devtool audio play    --in FILE             # USB-CDC; small pre-baked test clips via audio.play_pcm verb
esp32-devtool audio inject  --in FILE             # HTTP; large PCM streams via /audio/inject (no 32KB cap)
esp32-devtool gdb [--batch SCRIPT] [--openocd-config CFG]
esp32-devtool ui dump-tree                        # LVGL widget tree JSON (was ui.dump_tree verb)
esp32-devtool restart                             # = cmd restart
esp32-devtool setup [--hil] [--lvgl-sim]
esp32-devtool daemon {start|stop|status|ring}
esp32-devtool audit-prod-strip
```

### Board extensions (manifest-declared)

```
esp32-devtool bake-creds [--profile debug|prod]   # cube-only, transient
```

Devtool prints a one-line stderr deprecation hint on each `transient: true` extension invoke.

### Exit codes

```
0   success
2   bad usage (argparse error)
3   board not found / not connected
4   transport unavailable (e.g. HTTP needed but WiFi down)
5   verb error / non-zero JSON-RPC `error`
6   timeout
```

### Help

Every command supports `--help` with examples. `esp32-devtool` no-args prints a short menu like adb.

### JSON output

`--json` makes every command machine-readable. Snapshot returns `{"out":"...","size":N,"format":"png"}`. logs streams NDJSON. cmd returns the verb's JSON result directly. info returns `/info` verbatim.

## Board manifest

`boards/_schema.yaml`:

```yaml
name: string
display_name: string
chip: esp32-s3 | esp32-s2 | esp32-p4 | esp32-c3 | esp32-c6
firmware_path: string?               # for `flash`
build_profiles: [string]

usb:
  vid: int?
  pid: int?
  port_glob: string?

http:
  enabled: bool
  port: int
  discover_via: usb-info | mdns | static
  static_host: string?

capabilities:
  flash:        { transport: usb-cdc, require: [usb] }
  logs:         { transport: auto, sources: [usb, udp] }
  cmd:          { transport: usb-cdc, require: [daemon] }
  screenshot:   { transport: http, require: [http], format: [png, jpeg, rgb565] }
  touch:        { transport: http, require: [http] }
  audio_record: { transport: http, require: [http] }
  audio_inject: { transport: http, require: [http] }
  audio_play:   { transport: usb-cdc }

log_relay:
  enabled: bool
  port: int
  format: text | json

verbs: [string]                       # USB-CDC JSON-RPC verbs

extensions:                           # board-specific commands
  - cmd: string
    exec: string                      # ${REPO_ROOT}-aware
    args_passthrough: bool
    transient: bool?                  # prints deprecation hint
    help: string
```

### `boards/cube.yaml`

```yaml
name: cube
display_name: "Sentient Cube (Waveshare ESP32-S3 AMOLED 2.16)"
chip: esp32-s3
firmware_path: esp32/cube/firmware
build_profiles: [debug, prod]

usb:
  port_glob: "/dev/cu.usbmodem*"

http:
  enabled: true
  port: 8081
  discover_via: usb-info               # cube /info verb returns ip

capabilities:
  flash:        { transport: usb-cdc }
  logs:         { transport: auto, sources: [usb, udp] }
  cmd:          { transport: usb-cdc }
  screenshot:   { transport: http }
  touch:        { transport: http }
  audio_record: { transport: http }
  audio_inject: { transport: http }
  audio_play:   { transport: usb-cdc }

log_relay:
  enabled: true
  port: 9000

verbs:
  - sentient.status
  - sentient.force_reconnect
  - sentient.last_transcript
  - button.toggle
  - tts.cancel
  - state
  - restart
  - log_level
  - mark
  - wifi.connect
  - wifi.disconnect
  - wifi.reconnect
  - audio.dump_state
  - audio.play_pcm
  - audio.test_tone

extensions:
  - cmd: bake-creds
    exec: ${REPO_ROOT}/esp32/cube/scripts/bake-creds.sh
    args_passthrough: true
    transient: true
    help: |
      [transient — pre-device-pairing dev hack]
      Bake WiFi/PASETO/etc. from esp32/cube/.e2e-testing into
      firmware/main/sentient_creds.h. Auto-resolves Mac LAN IP +
      mints a fresh PASETO. Retires with proper device-pairing flow.
```

### Auto-detect flow

```
1. If --board <name>: load boards/<name>.yaml. Done.
2. Else scan /dev/cu.usbmodem* (or platform equivalent).
3. For each port: optionally read MAC via esptool, match against boards/*.yaml.
4. Exactly 1 match → use; cache to ~/.config/esp32-devtool/last-board.
5. Zero → exit 3 ("no board connected; --board explicitly?").
6. Two+ → exit 3 ("multiple boards — disambiguate with --board=cube --port=...").
```

Cache key: `(port, manifest_mtime)`. Invalidate if either changes.

### Capability routing

When user runs `esp32-devtool screenshot`:

```
1. Load board manifest.
2. capabilities.screenshot → transport=http, require=[http].
3. Verify reachable: HEAD http://<ip>:<port>/info, 2s timeout.
4. Reachable → dispatch.
5. Unreachable → exit 4 with named alternative.
6. Never silently fall back to USB-CDC for HTTP-only verbs.
```

`logs` (`transport: auto`) special-cases: simultaneously consumes daemon ring (USB) and gateway UDP sink (if `log_relay.enabled`), merges by timestamp, prefixes lines with source.

## Firmware companion

Subsumes today's `agent_console` + `net_logger`. Single Kconfig switch.

### Kconfig

```kconfig
menu "ESP32 devtool companion"

config ESP32_DEVTOOL_COMPANION_ENABLE
    bool "Enable devtool HTTP server + verb hooks"
    default n

if ESP32_DEVTOOL_COMPANION_ENABLE

config ESP32_DEVTOOL_HTTP_PORT
    int "HTTP server port"
    default 8081
    range 1024 65535

config ESP32_DEVTOOL_SCREENSHOT_ENABLE
    bool "GET /screenshot"
    default y

config ESP32_DEVTOOL_TOUCH_ENABLE
    bool "POST /touch"
    default y

config ESP32_DEVTOOL_AUDIO_RECORD_ENABLE
    bool "GET /audio/record"
    default y

config ESP32_DEVTOOL_AUDIO_INJECT_ENABLE
    bool "POST /audio/inject"
    default y

config ESP32_DEVTOOL_LOG_RELAY_ENABLE
    bool "UDP log relay"
    default y

config ESP32_DEVTOOL_LOG_RELAY_PORT
    int "UDP log relay destination port"
    default 9000
    depends on ESP32_DEVTOOL_LOG_RELAY_ENABLE

endif

endmenu
```

### CMakeLists.txt (sketch)

```cmake
if(CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE)
    set(DEVTOOL_SRCS
        src/companion.cc
        src/usb_cdc_reader.cc
        src/verb_dispatcher.cc
        src/http_server.cc
        src/log_relay.cc
        src/handlers/info.cc
    )
    if(CONFIG_ESP32_DEVTOOL_SCREENSHOT_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/screenshot.cc)
    endif()
    # ... per-endpoint gates ...
else()
    set(DEVTOOL_SRCS src/companion_stub.cc)
endif()

idf_component_register(
    SRCS ${DEVTOOL_SRCS}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS .
    REQUIRES esp_http_server esp_netif lvgl__lvgl json
    WHOLE_ARCHIVE                                          # for verb constructor registration
)
```

### Registration API

```cpp
// USB-CDC JSON-RPC verb (replaces agent_dispatcher_register)
typedef int (*devtool_verb_handler_t)(const cJSON* params, cJSON* out_result,
                                       int* out_error_code, const char** out_error_msg);
void devtool_register_verb(const char* method, devtool_verb_handler_t fn);

// HTTP endpoint (extends built-in /info, /screenshot, etc.)
typedef esp_err_t (*devtool_http_handler_t)(httpd_req_t* req);
void devtool_register_http(const char* method, const char* path, devtool_http_handler_t fn);
```

### Caller pattern

```cpp
#include "esp32_devtool/companion.h"

esp32_devtool_companion_config_t cfg = {
    .enable_usb_cdc = true,
    .enable_http   = true,
    .http_port     = CONFIG_ESP32_DEVTOOL_HTTP_PORT,
    .udp_relay     = { .enabled = true, .host = "192.168.0.222", .port = 9000 },
};
esp32_devtool_companion_start(&cfg);

// Board-specific verbs register via the new API:
register_sentient_verbs();
register_audio_verbs();
register_button_verbs();
```

### Stub for prod

```cpp
// src/companion_stub.cc
#include "esp32_devtool/companion.h"

extern "C" {
esp_err_t esp32_devtool_companion_start(const esp32_devtool_companion_config_t*) { return ESP_OK; }
void esp32_devtool_companion_stop(void) { /* no-op */ }
void devtool_register_verb(const char*, devtool_verb_handler_t) { /* no-op */ }
void devtool_register_http(const char*, const char*, devtool_http_handler_t) { /* no-op */ }
}
```

Caller code is unconditional — `#if CONFIG_*` gates live entirely inside the component.

### Pre-WiFi vs post-WiFi

- USB-CDC reader + verb dispatcher: up immediately. Works pre-WiFi.
- HTTP server + log relay: up on `IP_EVENT_STA_GOT_IP`. Companion observes the event internally.

### Size budget

- Prod stub: ~0 bytes (empty functions).
- Debug full: ~25 KB (esp_http_server ~12 KB + handlers ~8 KB + log_relay ~5 KB).
- Cube partition currently has 27% free; room covers it.

### Audit

`esp32-devtool audit-prod-strip` runs `objdump` on prod ELF, fails if any `esp32_devtool_*` symbol leaks.

## HTTP contract

Frozen wire spec. Board implementers conform. CLI assumes shape.

### `GET /info` → 200 application/json

```json
{
  "device_id": "cube-001",
  "board": "cube",
  "chip": "esp32-s3",
  "ip": "192.168.0.121",
  "mac": "aa:bb:cc:dd:ee:ff",
  "firmware": "phase6-cube-sdk-<git-sha>",
  "build_profile": "debug",
  "uptime_s": 3421,
  "wifi_ssid": "InterWeb",
  "wifi_rssi": -42,
  "capabilities": ["screenshot", "touch", "audio_record", "audio_inject", "log_relay"],
  "endpoints": {
    "screenshot": "/screenshot",
    "touch": "/touch",
    "audio_record": "/audio/record",
    "audio_inject": "/audio/inject"
  },
  "contract_version": "1.0"
}
```

### `GET /screenshot?format=png|jpeg|rgb565`

```
200 OK
Content-Type: image/png | image/jpeg | application/octet-stream
X-Screenshot-Width: <int>
X-Screenshot-Height: <int>
X-Screenshot-Format: png|jpeg|rgb565
X-Screenshot-Crc32: <hex>
<binary>
```

Defaults to png. JPEG quality 80 (fixed v1). rgb565 = raw; host converts.

Errors: 503 (LVGL not initialized), 500 (snapshot null), 408 (encoder hang 10s).

### `POST /touch`

```
Body: {"x": int, "y": int, "hold_ms": int? = 60}
200 → {"ok": true}
```

Server enqueues synthetic press at (x,y), release after hold_ms via injected `lv_indev`.

### `GET /audio/record?duration_ms=<int>&sample_rate=<int>`

```
200 OK
Content-Type: audio/L16; rate=<sample_rate>; channels=1
X-Audio-Samples: <int>
<raw PCM16 LE>
```

Default 1000 ms, 16000 Hz. Max 10000 ms. Streams during capture (no full buffer).

### `POST /audio/inject`

```
Content-Type: audio/L16; rate=16000; channels=1
<raw PCM16 LE>
200 → {"ok": true, "samples": <int>}
```

No 32 KB cap (was the USB-CDC verb's b64 limit).

### Log relay (cube → host)

UDP datagrams, NDJSON one line per packet:

```json
{"ts_ms": 12345, "level": "I", "tag": "sentient.cube.sdk.ws", "msg": "status: ..."}
```

Devtool's `logs --source udp` binds the host-side port to receive.

### Headers (all endpoints)

```
X-Devtool-Version: <semver>
```

CLI warns on major mismatch.

### Contract versioning

`contract_version` in `/info`. CLI requires `^MAJOR.MINOR`. Loud error on mismatch.

### Authentication

Out-of-scope v1 (LAN-only). OSS extraction guide will document reverse-proxy patterns.

### CORS

Off v1. Add when a web UI is built.

## Daemon lifecycle

### Auto-spawn / idle-kill

```
1. CLI command needs USB-CDC → transport.usb_cdc.ensure_daemon(port).
2. ensure_daemon:
   a. /tmp/esp32-devtool/daemon-<port-hash>.sock exists + pings within 1s → return.
   b. Else spawn `esp32-devtool daemon start --port <port>` detached.
   c. Wait up to 12s for socket.
   d. Timeout → exit 4 with $LOGFILE pointer.
3. Daemon exposes UNIX socket. Msgs = {kind: cmd|events|ping|subscribe, ...}.
4. Idle 10 min (env `ESP32_DEVTOOL_DAEMON_IDLE_SEC` override) → self-exit.
5. flash kills daemon, runs idf.py flash, respawns daemon post-flash.
```

### Per-board scoping

```
/tmp/esp32-devtool/
├── <port-hash>.sock                  # port-hash = sha1(port)[:12]
├── <port-hash>.pid
└── <port-hash>.log
```

Multiple boards = multiple daemons. No collision.

### Multi-client multiplexing

Daemon supports concurrent clients on same socket: one long-lived `subscribe` (live logs) + many short-lived `cmd`. Inherited from today's `_cube_daemon.py` design.

### `esp32-devtool daemon` user-facing

```
esp32-devtool daemon start [--port PORT] [--detach]
esp32-devtool daemon stop  [--port PORT]
esp32-devtool daemon status
esp32-devtool daemon ring  [--lines N] [--filter R]
```

Rarely-needed. Agents use the auto-spawn path.

### Error surfaces

```
DaemonUnreachable    → "daemon failed to start; check $LOGFILE"
DaemonBusy           → "another process is flashing — retry in 10s"
PortConflict         → "/dev/cu.usbmodem101 owned by PID X — `daemon stop` or kill PID"
SerialReadTimeout    → "cube wedged — try `esp32-devtool restart` or physical recovery"
```

## Live logs

### `esp32-devtool logs [--follow]`

Merged stream from two sources, source-tagged per line:

```
[usb 12:34:56.789] I (4762) wifi: connected with InterWeb
[udp 12:34:56.812] I (4812) sentient.cube.sdk.ws: status: ...
```

Tag = first transport the line arrived on.

### Implementation

`asyncio.Queue` fed by `usb_reader` (subscribed to daemon socket) + `udp_reader` (bound to `log_relay.port`). LRU-dedupe (key = `(ts_bucket_10ms, tag, msg)`) to handle the same line arriving on both paths.

### Flags

```
--follow / -f          stream forever
--since DURATION       seek backwards (2m, 30s, 1h)
--filter PATTERN       regex on tag or msg
--source usb|udp|all   default: all
--level D|I|W|E        min level; default I
--json                 NDJSON output
--no-color             tty-detect on by default
--lines N              non-follow last-N (default 100)
```

### Pre-WiFi window

UDP source empty until WiFi. `--source all` falls back to USB-only silently. After WiFi up, UDP arrives, dedupe handles overlap.

### Performance budget

~50-100 lines/sec INFO steady-state. ~150 lines/sec with per-frame DEBUG. Trivial host-side load.

### Stop conditions

- `Ctrl+C` → clean disconnect.
- Daemon dies → exit 6 with $LOGFILE.
- WiFi disconnect → UDP idles, USB continues.

## Packaging + extraction roadmap

### v1 install (mono-repo)

```bash
$REPO/esp32/devtool/bin/esp32-devtool <cmd>
# Or after `source scripts/env.sh` (which adds bin to PATH):
esp32-devtool <cmd>
```

### bin/esp32-devtool (bash shim)

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec uv run --script "$HERE/../cli/main.py" "$@"
```

### cli/main.py header

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyserial>=3.5",
#   "requests>=2.31",
#   "click>=8.1",
#   "pyyaml>=6.0",
#   "rich>=13",
#   "websockets>=12",
# ]
# ///
```

### Self-containment

`cli/` imports nothing from `gateway/`, `shared/`, `esp32/cube/`. Manifests reference repo paths via `${REPO_ROOT}` substitution; without a repo (post-extraction) the variable resolves to CWD.

### OSS extraction

Pre-planned. 30-min `cp -r` + path-tweak + `git init` produces a standalone repo:

```
github.com/<org>/esp32-devtool/
├── README.md
├── LICENSE
├── pyproject.toml                    # generated from PEP-723 header
├── esp32_devtool/                    # was cli/
├── boards/
│   ├── _schema.yaml
│   ├── generic-s3-devkit.yaml
│   └── examples/cube.yaml
├── firmware/esp32_devtool_companion/
└── docs/
```

Install:
```bash
uvx esp32-devtool screenshot           # quick try
pipx install esp32-devtool             # persistent
git clone <repo> && cd esp32-devtool && uv run esp32-devtool ...  # dev
```

### Versioning

- Tool: SemVer in `cli/version.py`. `esp32-devtool --version` reports.
- HTTP contract: `contract_version` in `/info`. Decoupled.

### Skill integration

`esp32/devtool/skills/` placeholder for future Claude Code skills built on devtool. v1 ships `README.md` only.

### Repo rules

```
.claude/rules/esp32/devtool.md         # how agents invoke devtool, when to prefer over raw scripts
```

The devtool's own `CLAUDE.md` covers OSS-extractable concerns. The repo rule covers mono-repo specifics (e.g. `source scripts/env.sh` first).

## Script migration (no leftovers)

### Migration table

| Script | Fate |
|---|---|
| `_cube_daemon.py` | DELETE → `cli/daemon/server.py` + `cli/daemon/lifecycle.py` |
| `_cube_cmd_helper.py` | DELETE → `cli/transport/usb_cdc.py` |
| `_cube_snapshot_helper.py` | DELETE → `cli/commands/screenshot.py` |
| `cube-cmd.sh` | DELETE → `esp32-devtool cmd` |
| `cube-snapshot.sh` | DELETE → `esp32-devtool screenshot` |
| `flash.sh` | DELETE → `esp32-devtool flash [--profile P]` (daemon kill/respawn baked in) |
| `find-port.sh` | DELETE → `cli/board.py` auto-detect |
| `gdb-batch.sh` | DELETE → `esp32-devtool gdb` |
| `setup-hil.sh` | DELETE → `esp32-devtool setup --hil` |
| `bake-creds.sh` | **KEEP in place**. Manifest extension exposes it as `esp32-devtool bake-creds`. Marked `transient: true`; retires with device-pairing. |

### HIL fixture refactor

`esp32/cube/tests/hil/conftest.py` fixtures (`cube_dut`, `serial_dut`, `gateway_logs`) rewrite their internals to call `esp32-devtool`. Existing Phase 6 test files (`test_sentient_audio_toggle.py` etc.) DON'T CHANGE — backwards compat preserved at the fixture surface.

### Component subsumption

What dies:
- `esp32/cube/firmware/components/agent_console/` — DELETE.
- `esp32/cube/firmware/components/net_logger/` — DELETE.

What moves:
- Cube board-specific verbs (`sentient.cc`, `audio.cc`, `button.cc`, etc.) move to `esp32/cube/firmware/main/devtool_verbs/`, register via the new `devtool_register_verb` API.

### Rules cleanup

- DELETE `.claude/rules/esp32/cube/agent-console.md`.
- ADD `.claude/rules/esp32/devtool.md` (repo-side) referencing `esp32/devtool/CLAUDE.md`.

## E2E acceptance — parity tests

`esp32/devtool/tests/e2e/test_v1_parity.py`. Each prior incantation has a 1:1 devtool equivalent. Tests use real cube hardware.

| Pre-devtool incantation | Post-devtool equivalent | Test file |
|---|---|---|
| `bash esp32/cube/scripts/flash.sh` | `esp32-devtool flash --profile debug` | `test_flash_debug.py` |
| `bash esp32/cube/scripts/flash.sh --profile prod` | `esp32-devtool flash --profile prod` | `test_flash_prod.py` |
| `bash esp32/cube/scripts/cube-cmd.sh state` | `esp32-devtool cmd state` | `test_cmd_state.py` |
| `bash esp32/cube/scripts/cube-cmd.sh button.toggle` | `esp32-devtool cmd button.toggle` | `test_cmd_button_toggle.py` |
| `bash esp32/cube/scripts/cube-cmd.sh sentient.status` | `esp32-devtool cmd sentient.status` | included above |
| `bash esp32/cube/scripts/cube-snapshot.sh /tmp/x.png` | `esp32-devtool screenshot --out /tmp/x.png` | `test_screenshot_5_in_a_row.py` |
| (tail daemon ring) | `esp32-devtool logs --since 2m` | `test_logs_ring.py` |
| (tail gateway log file) | `esp32-devtool logs --source udp --follow` (10s sample) | `test_logs_udp.py` |
| `bash esp32/cube/scripts/cube-cmd.sh audio.inject_pcm --params ...` | `esp32-devtool audio inject --in fixture.pcm` | `test_audio_inject.py` |
| `bash esp32/cube/scripts/cube-cmd.sh audio.record_pcm` | `esp32-devtool audio record --duration 1 --out /tmp/r.pcm` | `test_audio_record.py` |
| `bash esp32/cube/scripts/bake-creds.sh` | `esp32-devtool bake-creds --profile debug` | `test_bake_creds_extension.py` |
| `bash esp32/cube/scripts/find-port.sh` | `esp32-devtool info \| jq -r .port` | `test_auto_detect.py` |
| `bash esp32/cube/scripts/gdb-batch.sh` | `esp32-devtool gdb --batch` | `test_gdb_batch.py` (Group B — interactive) |
| HIL pytest fixtures | Fixtures rewritten under the hood; tests unchanged | `test_fixture_compat.py` |
| `esp32-devtool screenshot` × 5 consecutive | 5/5 success, all PNGs valid | `test_screenshot_5_in_a_row.py` |

### Test discipline

- Each test ≤80 lines.
- Group A (agent-only) by default. Group B (operator-confirmed) for interactive paths (`gdb`, `flash --profile prod` which may reboot the cube).
- Use real cube hardware. No mocks at the transport layer.

## Error handling

### Per-command error contract

- All commands return non-zero on failure (exit codes table above).
- All commands emit human-readable error to stderr with a one-line headline + a "next step" hint.
- `--json` flag wraps errors as `{"error": "code", "message": "...", "next_step": "..."}` on stderr.

### Examples

```
$ esp32-devtool screenshot
[esp32-devtool] HTTP unavailable: GET http://192.168.0.121:8081/info → timeout (2s)
   next step: confirm cube WiFi-up with `esp32-devtool logs --follow`,
              or wait for `sdk: ready` then retry.
$? = 4

$ esp32-devtool cmd sentient.status
[esp32-devtool] cube wedged: daemon timeout after 5.0s
   next step: try `esp32-devtool restart`, or physical recovery
              (unplug, hold BOOT, replug).
$? = 6
```

### Daemon log surfaces

Daemon stderr/stdout split:
- `~/.config/esp32-devtool/daemons/<port-hash>.log` — primary log
- Daemon ring (in-memory, ~20000 lines) — dump via `esp32-devtool daemon ring`

## Testing strategy

### Unit (`tests/unit/`)

- `cli/board.py` manifest loader + auto-detect: real YAML fixtures + mocked port-scan.
- `cli/transport/router.py` capability resolution: matrix of manifest × capability → expected transport.
- `cli/daemon/lifecycle.py` spawn/idle/kill state machine: fake sockets.
- Argparse / click smoke: `esp32-devtool --help` snapshot tests.

No real hardware. Stdlib + pytest only. Runs in CI on Linux/macOS.

### E2E (`tests/e2e/`)

Real cube. Group A automated. See parity table above.

### CI gating

Lint + typecheck + unit tests run in CI. E2E runs only when manually triggered (no cube in CI).

## Pre-merge gate

Before merging `feature/esp32-devtool-foundation` back to `feature/phase6-cube-sdk`:

- ✅ All unit tests green.
- ✅ All E2E parity tests green (operator-run on real cube).
- ✅ Phase 6a smoke S1 + S5 still green via refactored HIL fixtures.
- ✅ Prod build size unchanged ±5%.
- ✅ `esp32-devtool audit-prod-strip` reports zero `esp32_devtool_*` symbols in prod ELF.
- ✅ Legacy scripts directory empty (or contains README pointing to devtool).
- ✅ `lvgl-sim` build still green (no regression to that toolchain).
- ✅ `bun run ci` green (gateway side).

## Branch + commit plan

Branch: `feature/esp32-devtool-foundation` off `feature/phase6-cube-sdk`.

Implementation phases (each = one or more atomic commits):

1. Scaffold `esp32/devtool/` skeleton + manifest schema + `cube.yaml` + `generic-s3-devkit.yaml`.
2. `cli/main.py` + PEP-723 deps + `esp32-devtool info` (real implementation — depends on /info endpoint landing too).
3. Firmware companion: Kconfig + CMakeLists + stub + `/info` handler.
4. Cube firmware: wire the new component, register stub verbs. First flash gate.
5. Port daemon (`cli/daemon/*`) + `esp32-devtool cmd`. Verb registration in companion + cube. Run parity tests for `cmd state`, `cmd button.toggle`, `cmd sentient.status`.
6. Land `/screenshot` endpoint + `cli/commands/screenshot.py`. Run 5-in-a-row parity test.
7. Land `/touch`, `/audio/*` endpoints + companion-side handlers + `cli/commands/touch.py`, `cli/commands/audio.py`.
8. `cli/commands/flash.py` (absorbs flash.sh). Daemon kill/respawn. Parity test.
9. `cli/commands/logs.py` (USB + UDP merge). Parity test.
10. `cli/commands/gdb.py` (absorbs gdb-batch.sh).
11. `cli/commands/setup.py` (absorbs setup-hil.sh).
12. `cli/commands/audit_prod_strip.py`.
13. Board manifest extensions support + wire `bake-creds` extension.
14. Refactor HIL fixtures.
15. DELETE legacy scripts.
16. DELETE `agent_console/` + `net_logger/` components.
17. Update `.claude/rules/` (delete agent-console.md; add devtool.md).
18. Full e2e parity suite green.

Flash budget: ≤8 flashes total. Step 4 (1), step 5 (1-2), step 6 (1), step 7 (1-2), step 8 (1), step 14 (1).

## Open questions

None — all design decisions converged in brainstorming.

## Related artifacts

- Phase 6 plan: `docs/superpowers/plans/2026-05-14-phase6-cube-sdk-plan.md` (mid-phase checkpoint at top)
- Phase 6 design: `docs/superpowers/specs/2026-05-14-cube-sdk-design.md`
- Today's HTTP-contract reference search: see brainstorm session web-search citations
- esp32/todo.md — `ui.tap_at` + `lvgl-sim coverage for toggle_button_screen` entries become moot once devtool's `touch` + sim integration land
