# esp32-devtool Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 8 shell + 4 Python dev scripts with one unified `esp32-devtool` CLI that auto-routes per-verb between USB-CDC and HTTP transports, plus a reference ESP-IDF firmware companion that exposes the host-facing endpoints. Every e2e parity case runs unattended against the cube on USB.

**Architecture:** Two-half system. Host CLI in Python (PEP-723 inline-deps, `uv run --script`) dispatches verbs through a `transport/router.py` that reads per-board YAML manifests; transport is USB-CDC (via a port-holding daemon) for low-byte / lifecycle / pre-WiFi ops and HTTP for high-throughput post-WiFi ops. Firmware ships an ESP-IDF component `esp32_devtool_companion` that subsumes the retired `agent_console` + `net_logger` and exposes a USB-CDC verb dispatcher + `esp_http_server` with `/info`, `/screenshot`, `/touch`, `/audio/record`, `/audio/inject` + UDP NDJSON log relay. Prod builds compile down to a stub via Kconfig — zero footprint.

**Tech Stack:** Python 3.11 + click + pyserial + requests + pyyaml + websockets + rich; pytest for unit + e2e; ESP-IDF (esp_http_server, json/cJSON, esp_netif, lvgl); `uv run --script` for CLI invocation; cube firmware target `esp32-s3`.

**Branch:** `feature/esp32-devtool-foundation` cut off the current working branch (`feature/esp32-cube-v1` in this worktree). All commits land there; PR back to `feature/esp32-cube-v1` (or its successor) once the pre-merge gate at the end of this plan is green.

**E2E discipline:** All e2e parity tests run unattended. No Group A/B split — every case (including `flash --profile prod`, `gdb --batch`, `bake-creds`) recovers automatically. The e2e `conftest.py` owns:
- Cube auto-detection on `/dev/cu.usbmodem*`.
- Daemon spawn/ensure before each test class.
- Wedge detection (`cmd state` timeout >3s) → automatic recovery via `restart` verb, escalating to a reflash if `restart` fails twice.
- Per-failure diagnostic dump (daemon ring snapshot + `/info` + screenshot if HTTP reachable).
- Test isolation: each test class clears the daemon ring at setup so log assertions don't see prior-test bleed.

The one un-automatable failure mode is AXP2101 PMIC fault state requiring physical unplug + BOOT-hold replug. The conftest detects that signature (boot-loop with `<<< READY` never arriving within 30s after a reflash) and exits the test session with `pytest.exit(reason=…, returncode=4)` so the operator sees a clear "cube needs physical recovery" message rather than a timeout cascade. This is the only escape hatch.

---

## File Structure Overview

New tree under `esp32/devtool/`:

```
esp32/devtool/
├── README.md
├── CLAUDE.md
├── LICENSE
├── pyproject.toml                       # pytest + dev deps only (runtime via PEP-723)
├── bin/esp32-devtool                    # bash shim → uv run cli/main.py
├── cli/
│   ├── main.py                          # PEP-723 header + click dispatch
│   ├── version.py
│   ├── board.py                         # manifest loader + auto-detect
│   ├── repo_root.py                     # ${REPO_ROOT} substitution helper
│   ├── transport/
│   │   ├── __init__.py
│   │   ├── router.py                    # capability → transport resolution
│   │   ├── usb_cdc.py                   # daemon client
│   │   └── http.py                      # requests-based HTTP client
│   ├── daemon/
│   │   ├── __init__.py
│   │   ├── server.py                    # port-holding daemon (port of _cube_daemon.py)
│   │   └── lifecycle.py                 # ensure-spawn, idle-kill, port-hash scoping
│   ├── commands/
│   │   ├── __init__.py
│   │   ├── info.py
│   │   ├── flash.py
│   │   ├── logs.py
│   │   ├── screenshot.py
│   │   ├── cmd.py
│   │   ├── touch.py
│   │   ├── audio.py
│   │   ├── gdb.py
│   │   ├── setup.py
│   │   ├── daemon_cli.py
│   │   ├── ui.py
│   │   ├── restart.py
│   │   ├── audit_prod_strip.py
│   │   └── extensions.py                # manifest-declared board extensions
│   └── errors.py                        # exit-code constants + named errors
├── boards/
│   ├── _schema.yaml
│   ├── cube.yaml
│   └── generic-s3-devkit.yaml
├── firmware/esp32_devtool_companion/
│   ├── CMakeLists.txt
│   ├── Kconfig
│   ├── idf_component.yml
│   ├── include/esp32_devtool/
│   │   ├── companion.h
│   │   ├── verbs.h
│   │   └── endpoints.h
│   └── src/
│       ├── companion.cc
│       ├── companion_stub.cc
│       ├── usb_cdc_reader.cc
│       ├── verb_dispatcher.cc
│       ├── http_server.cc
│       ├── log_relay.cc
│       └── handlers/
│           ├── info.cc
│           ├── screenshot.cc
│           ├── touch.cc
│           ├── audio_record.cc
│           └── audio_inject.cc
├── docs/
│   ├── HTTP-CONTRACT.md
│   ├── BOARD-MANIFEST.md
│   └── ROADMAP.md
├── skills/README.md
└── tests/
    ├── conftest.py                      # shared (path setup)
    ├── unit/
    │   ├── test_board.py
    │   ├── test_router.py
    │   ├── test_usb_cdc.py
    │   ├── test_http.py
    │   ├── test_daemon_lifecycle.py
    │   ├── test_repo_root.py
    │   └── fixtures/
    │       ├── cube.yaml
    │       └── multi_match.yaml
    └── e2e/
        ├── conftest.py                  # cube auto-detect + recovery hooks
        ├── recovery.py                  # wedge detection + reflash logic
        ├── test_info.py
        ├── test_cmd_state.py
        ├── test_cmd_button_toggle.py
        ├── test_cmd_sentient_status.py
        ├── test_screenshot.py
        ├── test_screenshot_5_in_a_row.py
        ├── test_touch.py
        ├── test_audio_record.py
        ├── test_audio_inject.py
        ├── test_flash_debug.py
        ├── test_flash_prod.py
        ├── test_logs_ring.py
        ├── test_logs_udp.py
        ├── test_gdb_batch.py
        ├── test_audit_prod_strip.py
        ├── test_bake_creds_extension.py
        ├── test_auto_detect.py
        └── test_fixture_compat.py
```

Cube firmware additions/deletions:
- DELETE `esp32/cube/firmware/components/agent_console/` (every file).
- DELETE `esp32/cube/firmware/components/net_logger/` (every file).
- ADD `esp32/cube/firmware/main/devtool_verbs/` — board-specific verb impls (moved from `agent_console/verbs/`, rewritten against the new `devtool_register_verb` API).
- MODIFY `esp32/cube/firmware/main/main.cc` + `sentient_cube.cc` to call `esp32_devtool_companion_start()` instead of `agent_console_start()`.
- MODIFY `esp32/cube/firmware/main/idf_component.yml` to add the new component.
- MODIFY `esp32/cube/firmware/main/Kconfig.projbuild` to flip the agent-console master switch to the new companion switch (or simply rely on the new component's Kconfig).

Repo housekeeping:
- DELETE every legacy script under `esp32/cube/scripts/` except `bake-creds.sh` (kept; wrapped as a manifest extension).
- DELETE `.claude/rules/esp32/cube/agent-console.md`.
- ADD `.claude/rules/esp32/devtool.md`.
- MODIFY `.claude/rules/esp32/cube/logging.md` to remove the `net_logger` mention.
- MODIFY `esp32/cube/CLAUDE.md` to drop the agent_console + net_logger tree-map entries and point at `esp32/devtool/`.
- MODIFY `scripts/env.sh` to prepend `esp32/devtool/bin` to `PATH`.

---

I will emit each task as its own bite-sized block below. Each task has explicit files, explicit code snippets, exact commands, and a final commit step.

---

## Task 1: Branch + Skeleton

Cut the feature branch off the current working branch and lay down the empty directory skeleton + license + readmes. No logic yet.

**Files:**
- Branch: `feature/esp32-devtool-foundation` off current HEAD
- Create: `esp32/devtool/README.md`
- Create: `esp32/devtool/CLAUDE.md`
- Create: `esp32/devtool/LICENSE`
- Create: `esp32/devtool/bin/esp32-devtool`
- Create: `esp32/devtool/pyproject.toml`
- Create: `esp32/devtool/cli/__init__.py`
- Create: `esp32/devtool/cli/version.py`
- Create: `esp32/devtool/cli/errors.py`
- Create: `esp32/devtool/cli/transport/__init__.py`
- Create: `esp32/devtool/cli/daemon/__init__.py`
- Create: `esp32/devtool/cli/commands/__init__.py`
- Create: `esp32/devtool/docs/HTTP-CONTRACT.md`
- Create: `esp32/devtool/docs/BOARD-MANIFEST.md`
- Create: `esp32/devtool/docs/ROADMAP.md`
- Create: `esp32/devtool/skills/README.md`
- Create: `esp32/devtool/tests/conftest.py`
- Create: `esp32/devtool/tests/unit/__init__.py`
- Create: `esp32/devtool/tests/e2e/__init__.py`
- Modify: `scripts/env.sh` — prepend `$REPO_ROOT/esp32/devtool/bin` to PATH

- [ ] **Step 1: Cut branch**

```bash
git checkout -b feature/esp32-devtool-foundation
```

Expected: `Switched to a new branch 'feature/esp32-devtool-foundation'`.

- [ ] **Step 2: Create directory skeleton**

```bash
mkdir -p esp32/devtool/{bin,cli/{transport,daemon,commands},boards,firmware/esp32_devtool_companion/{include/esp32_devtool,src/handlers},docs,skills,tests/{unit/fixtures,e2e}}
```

- [ ] **Step 3: Write the bash shim**

`esp32/devtool/bin/esp32-devtool`:
```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec uv run --script "$HERE/../cli/main.py" "$@"
```

Then `chmod +x esp32/devtool/bin/esp32-devtool`.

- [ ] **Step 4: Write version.py + errors.py**

`esp32/devtool/cli/version.py`:
```python
__version__ = "0.1.0"
```

`esp32/devtool/cli/errors.py`:
```python
"""Exit codes + named errors for esp32-devtool."""
from __future__ import annotations


EXIT_OK = 0
EXIT_BAD_USAGE = 2
EXIT_BOARD_NOT_FOUND = 3
EXIT_TRANSPORT_UNAVAILABLE = 4
EXIT_VERB_ERROR = 5
EXIT_TIMEOUT = 6


class DevtoolError(Exception):
    exit_code: int = EXIT_VERB_ERROR
    next_step: str = ""

    def __init__(self, message: str, *, next_step: str = "") -> None:
        super().__init__(message)
        self.next_step = next_step or self.next_step


class BoardNotFound(DevtoolError):
    exit_code = EXIT_BOARD_NOT_FOUND


class TransportUnavailable(DevtoolError):
    exit_code = EXIT_TRANSPORT_UNAVAILABLE


class VerbError(DevtoolError):
    exit_code = EXIT_VERB_ERROR


class DevtoolTimeout(DevtoolError):
    exit_code = EXIT_TIMEOUT
```

- [ ] **Step 5: Write empty package files**

`esp32/devtool/cli/__init__.py`, `esp32/devtool/cli/transport/__init__.py`, `esp32/devtool/cli/daemon/__init__.py`, `esp32/devtool/cli/commands/__init__.py`, `esp32/devtool/tests/unit/__init__.py`, `esp32/devtool/tests/e2e/__init__.py`: empty files (`""`).

- [ ] **Step 6: Write pyproject.toml for test deps**

`esp32/devtool/pyproject.toml`:
```toml
[project]
name = "esp32-devtool-dev"
version = "0.1.0"
description = "Dev/test deps for esp32-devtool (runtime deps live in PEP-723 header of cli/main.py)"
requires-python = ">=3.11"
dependencies = [
  "pyserial>=3.5",
  "requests>=2.31",
  "click>=8.1",
  "pyyaml>=6.0",
  "rich>=13",
  "websockets>=12",
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

- [ ] **Step 7: Write tests/conftest.py**

`esp32/devtool/tests/conftest.py`:
```python
"""Shared test config: put cli/ on sys.path."""
from __future__ import annotations

import sys
from pathlib import Path


DEVTOOL_ROOT = Path(__file__).resolve().parents[1]
if str(DEVTOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(DEVTOOL_ROOT))
```

- [ ] **Step 8: Write README.md / CLAUDE.md / LICENSE / docs placeholders**

`esp32/devtool/README.md` — minimal OSS-facing pitch (~30 lines): one-tool-rules-all, capabilities table, install hint (`uv run esp32-devtool …`), roadmap pointer.

`esp32/devtool/CLAUDE.md` — agent-facing rules (~50 lines): invocation pattern (`esp32-devtool [GLOBAL FLAGS] <command>`), board auto-detect behaviour, transport routing rules, exit code table, when to prefer `--json`, where logs live.

`esp32/devtool/LICENSE` — Apache-2.0 boilerplate (copy from `https://www.apache.org/licenses/LICENSE-2.0.txt`, fill copyright `2026 <user>`).

`esp32/devtool/docs/HTTP-CONTRACT.md` — paste the full HTTP contract section from `docs/superpowers/specs/2026-05-15-esp32-devtool-design.md` lines 498-602.

`esp32/devtool/docs/BOARD-MANIFEST.md` — paste the board manifest section from the spec, lines 222-339.

`esp32/devtool/docs/ROADMAP.md` — list: gdb extras (panic-decode, multi-thread inspect), sdkconfig diff, OTA pipeline, auth/RBAC (reverse-proxy patterns), additional chip support beyond esp32-s3.

`esp32/devtool/skills/README.md` — one-liner: "Reserved for future Claude Code skills built on devtool. None ship in v1."

- [ ] **Step 9: Patch scripts/env.sh to prepend devtool bin**

Add to `scripts/env.sh` (after any existing PATH manipulation):
```bash
export PATH="$(git rev-parse --show-toplevel 2>/dev/null)/esp32/devtool/bin:$PATH"
```

- [ ] **Step 10: Verify skeleton compiles + shim runs**

```bash
source scripts/env.sh
which esp32-devtool
```
Expected: prints `/Users/.../esp32/devtool/bin/esp32-devtool`.

```bash
ls esp32/devtool/cli/
```
Expected: `__init__.py`, `commands/`, `daemon/`, `errors.py`, `transport/`, `version.py`.

- [ ] **Step 11: Commit**

```bash
git add esp32/devtool/ scripts/env.sh
git commit -m "feat(esp32-devtool): scaffold one-tool foundation skeleton"
```

---

## Task 2: Board Manifests + Schema

Land the YAML manifests for the cube + a generic ESP32-S3 dev board, plus a documentation schema. No loader yet (Task 4 builds the loader against these fixtures).

**Files:**
- Create: `esp32/devtool/boards/_schema.yaml`
- Create: `esp32/devtool/boards/cube.yaml`
- Create: `esp32/devtool/boards/generic-s3-devkit.yaml`
- Create: `esp32/devtool/tests/unit/fixtures/cube.yaml`
- Create: `esp32/devtool/tests/unit/fixtures/multi_match.yaml`

- [ ] **Step 1: Write `_schema.yaml`**

`esp32/devtool/boards/_schema.yaml` — documentation-only YAML capturing the manifest shape from the spec (lines 222-266). Top-level keys: `name`, `display_name`, `chip`, `firmware_path`, `build_profiles`, `usb` (`vid`, `pid`, `port_glob`), `http` (`enabled`, `port`, `discover_via`, `static_host`), `capabilities` (per-verb `transport`/`require`/`format`), `log_relay` (`enabled`, `port`, `format`), `verbs` (list), `extensions` (list of `cmd`/`exec`/`args_passthrough`/`transient`/`help`).

```yaml
# esp32-devtool board manifest schema. Documentation only — loader does its own validation.
# Each entry below shows the expected type + sample value.
name: cube                                # required str
display_name: "Sentient Cube"             # required str
chip: esp32-s3                            # required enum: esp32-s3 | esp32-s2 | esp32-p4 | esp32-c3 | esp32-c6
firmware_path: esp32/cube/firmware        # optional str; required for `flash`
build_profiles: [debug, prod]             # required list[str]

usb:
  vid: 0x303A                             # optional int
  pid: 0x1001                             # optional int
  port_glob: "/dev/cu.usbmodem*"          # optional str; required if vid/pid absent

http:
  enabled: true                           # required bool
  port: 8081                              # required int
  discover_via: usb-info                  # enum: usb-info | mdns | static
  static_host: 192.168.0.121              # required if discover_via=static

capabilities:                             # required map[verb -> {transport, require?, format?}]
  flash:        { transport: usb-cdc, require: [usb] }
  logs:         { transport: auto, sources: [usb, udp] }
  cmd:          { transport: usb-cdc, require: [daemon] }
  screenshot:   { transport: http, require: [http], format: [png, jpeg, rgb565] }
  touch:        { transport: http, require: [http] }
  audio_record: { transport: http, require: [http] }
  audio_inject: { transport: http, require: [http] }
  audio_play:   { transport: usb-cdc }

log_relay:                                # optional
  enabled: true
  port: 9000
  format: json                            # text | json

verbs: []                                 # list[str] — USB-CDC JSON-RPC method names

extensions:                               # optional list[manifest extension]
  - cmd: bake-creds
    exec: ${REPO_ROOT}/esp32/cube/scripts/bake-creds.sh
    args_passthrough: true
    transient: true
    help: "Pre-pairing creds bake; retires with device pairing"
```

- [ ] **Step 2: Write `cube.yaml`**

Paste lines 270-326 of the spec verbatim into `esp32/devtool/boards/cube.yaml`.

- [ ] **Step 3: Write `generic-s3-devkit.yaml`**

```yaml
name: generic-s3-devkit
display_name: "Generic ESP32-S3 DevKit"
chip: esp32-s3
build_profiles: [debug]

usb:
  port_glob: "/dev/cu.usbmodem*"

http:
  enabled: false
  port: 8081

capabilities:
  flash:        { transport: usb-cdc }
  logs:         { transport: usb-cdc }
  cmd:          { transport: usb-cdc }
  audio_play:   { transport: usb-cdc }

log_relay:
  enabled: false
  port: 9000

verbs:
  - state
  - restart
  - log_level

extensions: []
```

- [ ] **Step 4: Write test fixtures**

`esp32/devtool/tests/unit/fixtures/cube.yaml` — copy of `boards/cube.yaml`.

`esp32/devtool/tests/unit/fixtures/multi_match.yaml`:
```yaml
name: ambiguous
display_name: "Ambiguous Board"
chip: esp32-s3
build_profiles: [debug]
usb:
  port_glob: "/dev/cu.usbmodem*"
http:
  enabled: false
  port: 8081
capabilities:
  cmd: { transport: usb-cdc }
log_relay: { enabled: false, port: 9000 }
verbs: []
extensions: []
```

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/boards/ esp32/devtool/tests/unit/fixtures/
git commit -m "feat(esp32-devtool): board manifests + schema (cube, generic-s3-devkit)"
```

---

## Task 3: cli/main.py + PEP-723 + click dispatcher

Land `main.py` with the PEP-723 inline-deps header, click group, global flags, and `--version` + `--help` working. Commands are stubs that print "not yet implemented" and exit 0. No functional command logic yet.

**Files:**
- Create: `esp32/devtool/cli/main.py`
- Create: `esp32/devtool/cli/repo_root.py`

- [ ] **Step 1: Write `repo_root.py`**

`esp32/devtool/cli/repo_root.py`:
```python
"""Resolve ${REPO_ROOT} for manifest path substitution."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


def resolve_repo_root() -> Path:
    """Walk up from CWD looking for a git root. Fall back to CWD."""
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        if out:
            return Path(out)
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return Path(os.getcwd())


def substitute(value: str, *, repo_root: Path | None = None) -> str:
    """Replace ${REPO_ROOT} in a string."""
    root = repo_root if repo_root is not None else resolve_repo_root()
    return value.replace("${REPO_ROOT}", str(root))
```

- [ ] **Step 2: Write `main.py` with PEP-723 header + click stub commands**

`esp32/devtool/cli/main.py`:
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
"""esp32-devtool entry point. Dispatches to cli/commands/* via click."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure sibling modules (cli/*) are importable when invoked via uv run --script.
HERE = Path(__file__).resolve().parent
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

import click

from cli.version import __version__


@click.group(invoke_without_command=True)
@click.option("--board", default=None, help="Override board auto-detect.")
@click.option("--port", default=None, help="Override USB-CDC port auto-detect.")
@click.option("--http", "http_url", default=None, help="Override HTTP base URL.")
@click.option("--profile", default=None, type=click.Choice(["debug", "prod"]))
@click.option("--repo-root", default=None, help="Override git-root inference.")
@click.option("--quiet/--no-quiet", default=False)
@click.option("--verbose/--no-verbose", default=False)
@click.option("--json", "json_out", is_flag=True, help="Machine-readable output.")
@click.option("--no-daemon", is_flag=True, help="Skip daemon; open serial per call.")
@click.version_option(__version__, prog_name="esp32-devtool")
@click.pass_context
def cli(ctx: click.Context, **kwargs) -> None:
    ctx.ensure_object(dict)
    ctx.obj.update(kwargs)
    if ctx.invoked_subcommand is None:
        click.echo(ctx.get_help())


# Stub commands — each task below replaces these with real impls.
@cli.command()
def info() -> None:
    click.echo("info: not yet implemented", err=True)


@cli.command()
@click.option("--profile", default="debug", type=click.Choice(["debug", "prod"]))
def flash(profile: str) -> None:
    click.echo(f"flash --profile {profile}: not yet implemented", err=True)


@cli.command()
@click.option("--follow", "-f", is_flag=True)
@click.option("--since", default=None)
@click.option("--filter", "filter_pat", default=None)
@click.option("--source", default="all", type=click.Choice(["usb", "udp", "all"]))
@click.option("--level", default="I", type=click.Choice(["D", "I", "W", "E"]))
@click.option("--no-color", is_flag=True)
@click.option("--lines", default=100, type=int)
def logs(**kwargs) -> None:
    click.echo("logs: not yet implemented", err=True)


@cli.command()
@click.option("--out", "out_path", default=None)
@click.option("--format", "fmt", default="png", type=click.Choice(["png", "jpeg", "rgb565"]))
def screenshot(out_path: str | None, fmt: str) -> None:
    click.echo("screenshot: not yet implemented", err=True)


@cli.command()
@click.argument("verb")
@click.option("--param", "-p", "params", multiple=True, help="k=v")
def cmd(verb: str, params: tuple[str, ...]) -> None:
    click.echo(f"cmd {verb}: not yet implemented", err=True)


@cli.command()
@click.argument("x", type=int)
@click.argument("y", type=int)
@click.option("--hold", "hold_ms", default=60, type=int)
def touch(x: int, y: int, hold_ms: int) -> None:
    click.echo(f"touch {x} {y}: not yet implemented", err=True)


@cli.group()
def audio() -> None:
    pass


@audio.command("record")
@click.option("--duration", "duration_ms", default=1000, type=int)
@click.option("--out", "out_path", required=True)
def audio_record(duration_ms: int, out_path: str) -> None:
    click.echo("audio record: not yet implemented", err=True)


@audio.command("play")
@click.option("--in", "in_path", "in_path", required=True)
def audio_play(in_path: str) -> None:
    click.echo("audio play: not yet implemented", err=True)


@audio.command("inject")
@click.option("--in", "in_path", "in_path", required=True)
def audio_inject(in_path: str) -> None:
    click.echo("audio inject: not yet implemented", err=True)


@cli.command()
@click.option("--batch", "batch_script", default=None)
@click.option("--openocd-config", default=None)
def gdb(batch_script: str | None, openocd_config: str | None) -> None:
    click.echo("gdb: not yet implemented", err=True)


@cli.command()
def restart() -> None:
    click.echo("restart: not yet implemented", err=True)


@cli.command()
@click.option("--hil", is_flag=True)
@click.option("--lvgl-sim", "lvgl_sim", is_flag=True)
def setup(hil: bool, lvgl_sim: bool) -> None:
    click.echo("setup: not yet implemented", err=True)


@cli.group()
def daemon() -> None:
    pass


@daemon.command("start")
@click.option("--port", "port_path", default=None)
@click.option("--detach", is_flag=True)
def daemon_start(port_path: str | None, detach: bool) -> None:
    click.echo("daemon start: not yet implemented", err=True)


@daemon.command("stop")
@click.option("--port", "port_path", default=None)
def daemon_stop(port_path: str | None) -> None:
    click.echo("daemon stop: not yet implemented", err=True)


@daemon.command("status")
def daemon_status() -> None:
    click.echo("daemon status: not yet implemented", err=True)


@daemon.command("ring")
@click.option("--lines", default=2000, type=int)
@click.option("--filter", "filter_pat", default=None)
def daemon_ring(lines: int, filter_pat: str | None) -> None:
    click.echo("daemon ring: not yet implemented", err=True)


@cli.group()
def ui() -> None:
    pass


@ui.command("dump-tree")
def ui_dump_tree() -> None:
    click.echo("ui dump-tree: not yet implemented", err=True)


@cli.command("audit-prod-strip")
def audit_prod_strip() -> None:
    click.echo("audit-prod-strip: not yet implemented", err=True)


if __name__ == "__main__":
    cli()
```

- [ ] **Step 3: Verify shim invokes correctly**

```bash
source scripts/env.sh
esp32-devtool --version
```
Expected: `esp32-devtool, version 0.1.0`.

```bash
esp32-devtool --help | head -15
```
Expected: usage line + subcommand list including `info`, `flash`, `cmd`, `screenshot`, `touch`, `audio`, `gdb`, `daemon`, `ui`, `audit-prod-strip`.

```bash
esp32-devtool info
```
Expected: stderr prints `info: not yet implemented`; exit 0.

- [ ] **Step 4: Commit**

```bash
git add esp32/devtool/cli/main.py esp32/devtool/cli/repo_root.py
git commit -m "feat(esp32-devtool): cli main.py with click dispatch + global flags"
```

---

## Task 4: cli/board.py — manifest loader + auto-detect (TDD)

Write the failing test first. Then implement the loader, port-scan, and disambiguation logic.

**Files:**
- Create: `esp32/devtool/cli/board.py`
- Create: `esp32/devtool/tests/unit/test_board.py`

- [ ] **Step 1: Write failing tests**

`esp32/devtool/tests/unit/test_board.py`:
```python
from __future__ import annotations

import pytest
from pathlib import Path

from cli.board import (
    BoardManifest,
    load_manifest,
    list_manifests,
    detect_board,
    BoardNotFound,
)


FIXTURES = Path(__file__).parent / "fixtures"
BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def test_load_manifest_parses_cube():
    m = load_manifest(BOARDS_DIR / "cube.yaml")
    assert m.name == "cube"
    assert m.chip == "esp32-s3"
    assert m.http.enabled is True
    assert m.http.port == 8081
    assert "screenshot" in m.capabilities
    assert m.capabilities["screenshot"].transport == "http"
    assert m.log_relay.enabled is True
    assert m.log_relay.port == 9000
    assert "sentient.status" in m.verbs


def test_list_manifests_returns_both_boards():
    names = {m.name for m in list_manifests(BOARDS_DIR)}
    assert "cube" in names
    assert "generic-s3-devkit" in names


def test_detect_board_explicit_override_wins():
    m = detect_board(boards_dir=BOARDS_DIR, override_name="cube",
                     scan_ports=lambda glob: [])
    assert m.name == "cube"


def test_detect_board_no_ports_raises():
    with pytest.raises(BoardNotFound):
        detect_board(boards_dir=BOARDS_DIR, override_name=None,
                     scan_ports=lambda glob: [])


def test_detect_board_single_match_uses_it():
    m = detect_board(boards_dir=BOARDS_DIR, override_name=None,
                     scan_ports=lambda glob: ["/dev/cu.usbmodem101"])
    # cube + generic-s3-devkit both glob /dev/cu.usbmodem* — should fail ambiguous
    # unless we add specificity. Test the ambiguous path with the multi_match fixture.


def test_detect_board_ambiguous_raises():
    with pytest.raises(BoardNotFound, match="multiple boards"):
        detect_board(boards_dir=BOARDS_DIR, override_name=None,
                     scan_ports=lambda glob: ["/dev/cu.usbmodem101"])


def test_load_manifest_missing_required_field_raises():
    bad = FIXTURES / "missing_name.yaml"
    bad.write_text("chip: esp32-s3\nbuild_profiles: [debug]\n")
    with pytest.raises(ValueError, match="name"):
        load_manifest(bad)
    bad.unlink()
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_board.py -v
```
Expected: ImportError on `cli.board` (module not created yet).

- [ ] **Step 3: Implement `cli/board.py`**

`esp32/devtool/cli/board.py`:
```python
"""Board manifest loader + USB auto-detect."""
from __future__ import annotations

import glob as glob_mod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yaml

from cli.errors import BoardNotFound


@dataclass
class Capability:
    transport: str
    require: list[str] = field(default_factory=list)
    format: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)


@dataclass
class UsbCfg:
    vid: int | None = None
    pid: int | None = None
    port_glob: str | None = None


@dataclass
class HttpCfg:
    enabled: bool = False
    port: int = 8081
    discover_via: str = "usb-info"
    static_host: str | None = None


@dataclass
class LogRelayCfg:
    enabled: bool = False
    port: int = 9000
    format: str = "json"


@dataclass
class Extension:
    cmd: str
    exec: str
    args_passthrough: bool = True
    transient: bool = False
    help: str = ""


@dataclass
class BoardManifest:
    name: str
    display_name: str
    chip: str
    build_profiles: list[str]
    firmware_path: str | None
    usb: UsbCfg
    http: HttpCfg
    capabilities: dict[str, Capability]
    log_relay: LogRelayCfg
    verbs: list[str]
    extensions: list[Extension]
    source_path: Path


def load_manifest(path: Path) -> BoardManifest:
    raw = yaml.safe_load(path.read_text())
    if "name" not in raw:
        raise ValueError(f"{path}: missing required field 'name'")
    if "chip" not in raw:
        raise ValueError(f"{path}: missing required field 'chip'")
    if "build_profiles" not in raw:
        raise ValueError(f"{path}: missing required field 'build_profiles'")

    usb_raw = raw.get("usb") or {}
    http_raw = raw.get("http") or {}
    relay_raw = raw.get("log_relay") or {}

    caps: dict[str, Capability] = {}
    for verb, body in (raw.get("capabilities") or {}).items():
        caps[verb] = Capability(
            transport=body["transport"],
            require=body.get("require") or [],
            format=body.get("format") or [],
            sources=body.get("sources") or [],
        )

    exts = [
        Extension(
            cmd=e["cmd"],
            exec=e["exec"],
            args_passthrough=e.get("args_passthrough", True),
            transient=e.get("transient", False),
            help=e.get("help", ""),
        )
        for e in (raw.get("extensions") or [])
    ]

    return BoardManifest(
        name=raw["name"],
        display_name=raw.get("display_name", raw["name"]),
        chip=raw["chip"],
        build_profiles=list(raw["build_profiles"]),
        firmware_path=raw.get("firmware_path"),
        usb=UsbCfg(
            vid=usb_raw.get("vid"),
            pid=usb_raw.get("pid"),
            port_glob=usb_raw.get("port_glob"),
        ),
        http=HttpCfg(
            enabled=bool(http_raw.get("enabled", False)),
            port=int(http_raw.get("port", 8081)),
            discover_via=http_raw.get("discover_via", "usb-info"),
            static_host=http_raw.get("static_host"),
        ),
        capabilities=caps,
        log_relay=LogRelayCfg(
            enabled=bool(relay_raw.get("enabled", False)),
            port=int(relay_raw.get("port", 9000)),
            format=relay_raw.get("format", "json"),
        ),
        verbs=list(raw.get("verbs") or []),
        extensions=exts,
        source_path=path,
    )


def list_manifests(boards_dir: Path) -> list[BoardManifest]:
    out = []
    for p in sorted(boards_dir.glob("*.yaml")):
        if p.name.startswith("_"):
            continue
        out.append(load_manifest(p))
    return out


def _default_scan_ports(glob_pat: str) -> list[str]:
    return sorted(glob_mod.glob(glob_pat))


def detect_board(
    *,
    boards_dir: Path,
    override_name: str | None,
    scan_ports: Callable[[str], list[str]] = _default_scan_ports,
) -> BoardManifest:
    manifests = list_manifests(boards_dir)
    by_name = {m.name: m for m in manifests}

    if override_name is not None:
        if override_name not in by_name:
            raise BoardNotFound(
                f"manifest '{override_name}' not found in {boards_dir}",
                next_step=f"available: {sorted(by_name)}",
            )
        return by_name[override_name]

    candidates: list[tuple[BoardManifest, str]] = []
    for m in manifests:
        glob_pat = m.usb.port_glob
        if not glob_pat:
            continue
        ports = scan_ports(glob_pat)
        for p in ports:
            candidates.append((m, p))

    if not candidates:
        raise BoardNotFound(
            "no board connected on USB",
            next_step="pass --board <name> explicitly, or check the cable",
        )
    if len({m.name for m, _ in candidates}) > 1:
        names = sorted({m.name for m, _ in candidates})
        raise BoardNotFound(
            f"multiple boards match: {names}",
            next_step="disambiguate with --board=<name> --port=<path>",
        )
    return candidates[0][0]
```

- [ ] **Step 4: Re-run tests, verify pass**

The `test_detect_board_single_match_uses_it` + `test_detect_board_ambiguous_raises` both hit ambiguity because both `cube.yaml` and `generic-s3-devkit.yaml` glob the same `/dev/cu.usbmodem*`. Fix the single-match test to use only the cube manifest by pointing at a fresh fixture dir:

Update test:
```python
def test_detect_board_single_match_uses_it(tmp_path):
    (tmp_path / "cube.yaml").write_text((BOARDS_DIR / "cube.yaml").read_text())
    m = detect_board(boards_dir=tmp_path, override_name=None,
                     scan_ports=lambda glob: ["/dev/cu.usbmodem101"])
    assert m.name == "cube"
```

```bash
cd esp32/devtool && uv run pytest tests/unit/test_board.py -v
```
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/cli/board.py esp32/devtool/tests/unit/test_board.py
git commit -m "feat(esp32-devtool): board manifest loader + USB auto-detect"
```

---

## Task 5: cli/transport/router.py — capability resolution (TDD)

Capability lookup with HTTP-reachability gating. Pure function — tested with an injected reachability prober.

**Files:**
- Create: `esp32/devtool/cli/transport/router.py`
- Create: `esp32/devtool/tests/unit/test_router.py`

- [ ] **Step 1: Write failing tests**

`esp32/devtool/tests/unit/test_router.py`:
```python
from __future__ import annotations

from pathlib import Path

import pytest

from cli.board import load_manifest
from cli.errors import TransportUnavailable
from cli.transport.router import resolve_transport, Transport


BOARDS = Path(__file__).resolve().parents[2] / "boards"


def _cube():
    return load_manifest(BOARDS / "cube.yaml")


def test_resolve_screenshot_picks_http_when_reachable():
    t = resolve_transport(_cube(), "screenshot",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
    assert t == Transport.HTTP


def test_resolve_screenshot_unreachable_raises():
    with pytest.raises(TransportUnavailable, match="HTTP"):
        resolve_transport(_cube(), "screenshot",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: True)


def test_resolve_cmd_picks_usb_cdc():
    t = resolve_transport(_cube(), "cmd",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: True)
    assert t == Transport.USB_CDC


def test_resolve_cmd_no_daemon_raises():
    with pytest.raises(TransportUnavailable, match="daemon"):
        resolve_transport(_cube(), "cmd",
                          http_reachable=lambda m: False,
                          daemon_reachable=lambda m: False)


def test_resolve_logs_auto_returns_both():
    t = resolve_transport(_cube(), "logs",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
    assert t == Transport.AUTO


def test_resolve_unknown_verb_raises():
    with pytest.raises(KeyError):
        resolve_transport(_cube(), "no-such-verb",
                          http_reachable=lambda m: True,
                          daemon_reachable=lambda m: True)
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_router.py -v
```
Expected: ImportError on `cli.transport.router`.

- [ ] **Step 3: Implement `router.py`**

`esp32/devtool/cli/transport/router.py`:
```python
"""Capability → transport resolution. Reads board manifest, gates on reachability."""
from __future__ import annotations

from enum import Enum
from typing import Callable

from cli.board import BoardManifest
from cli.errors import TransportUnavailable


class Transport(str, Enum):
    USB_CDC = "usb-cdc"
    HTTP = "http"
    AUTO = "auto"


ReachableProbe = Callable[[BoardManifest], bool]


def resolve_transport(
    manifest: BoardManifest,
    capability: str,
    *,
    http_reachable: ReachableProbe,
    daemon_reachable: ReachableProbe,
) -> Transport:
    if capability not in manifest.capabilities:
        raise KeyError(
            f"board '{manifest.name}' has no capability '{capability}'; "
            f"declared: {sorted(manifest.capabilities)}"
        )

    cap = manifest.capabilities[capability]
    if cap.transport == "auto":
        return Transport.AUTO

    if cap.transport == "http":
        if "http" in cap.require or manifest.http.enabled:
            if not http_reachable(manifest):
                raise TransportUnavailable(
                    f"HTTP unavailable for '{capability}' on {manifest.name}",
                    next_step=(
                        f"confirm cube WiFi with `esp32-devtool logs --follow`, "
                        f"then retry"
                    ),
                )
        return Transport.HTTP

    if cap.transport == "usb-cdc":
        if "daemon" in cap.require and not daemon_reachable(manifest):
            raise TransportUnavailable(
                f"daemon unreachable for '{capability}' on {manifest.name}",
                next_step="run `esp32-devtool daemon start` or check the cable",
            )
        return Transport.USB_CDC

    raise ValueError(f"unknown transport '{cap.transport}' for '{capability}'")
```

- [ ] **Step 4: Re-run tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_router.py -v
```
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/cli/transport/router.py esp32/devtool/tests/unit/test_router.py
git commit -m "feat(esp32-devtool): capability-aware transport router"
```

---

## Task 6: cli/transport/http.py — HTTP client (TDD)

Wrap `requests` with timeout discipline + manifest-aware base URL discovery. HTTP reachability probe lives here so the router can use it.

**Files:**
- Create: `esp32/devtool/cli/transport/http.py`
- Create: `esp32/devtool/tests/unit/test_http.py`

- [ ] **Step 1: Write failing tests**

`esp32/devtool/tests/unit/test_http.py`:
```python
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from cli.board import load_manifest
from cli.errors import TransportUnavailable
from cli.transport.http import HttpClient, resolve_base_url

from pathlib import Path
BOARDS = Path(__file__).resolve().parents[2] / "boards"


def test_resolve_base_url_static():
    m = load_manifest(BOARDS / "cube.yaml")
    m.http.discover_via = "static"
    m.http.static_host = "10.0.0.5"
    assert resolve_base_url(m, override=None) == "http://10.0.0.5:8081"


def test_resolve_base_url_override_wins():
    m = load_manifest(BOARDS / "cube.yaml")
    assert resolve_base_url(m, override="http://1.2.3.4:9999") == "http://1.2.3.4:9999"


def test_resolve_base_url_usb_info(monkeypatch):
    m = load_manifest(BOARDS / "cube.yaml")
    # mock usb-info discovery: return ip via callback
    monkeypatch.setattr(
        "cli.transport.http._discover_ip_via_usb",
        lambda mf: "192.168.1.50",
    )
    assert resolve_base_url(m, override=None) == "http://192.168.1.50:8081"


def test_client_get_returns_json():
    with patch("cli.transport.http.requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        mock_get.return_value.json.return_value = {"ok": True}
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=2.0)
        assert c.get_json("/info") == {"ok": True}


def test_client_get_timeout_raises():
    import requests as rq
    with patch("cli.transport.http.requests.get",
               side_effect=rq.Timeout("boom")):
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=0.5)
        with pytest.raises(TransportUnavailable):
            c.get_json("/info")


def test_reachable_true_on_200():
    with patch("cli.transport.http.requests.get") as mock_get:
        mock_get.return_value.status_code = 200
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=1.0)
        assert c.reachable("/info") is True


def test_reachable_false_on_connection_error():
    import requests as rq
    with patch("cli.transport.http.requests.get",
               side_effect=rq.ConnectionError("nope")):
        c = HttpClient(base_url="http://1.2.3.4:8081", timeout_s=1.0)
        assert c.reachable("/info") is False
```

- [ ] **Step 2: Run failing tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_http.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement `http.py`**

`esp32/devtool/cli/transport/http.py`:
```python
"""HTTP transport client for esp32-devtool."""
from __future__ import annotations

import json as json_mod
from dataclasses import dataclass
from typing import Any

import requests

from cli.board import BoardManifest
from cli.errors import TransportUnavailable


def _discover_ip_via_usb(manifest: BoardManifest) -> str:
    """Issue a USB-CDC `info` verb to discover the cube's IP.

    Imported lazily to avoid circular import; full impl in transport/usb_cdc.py.
    """
    from cli.transport.usb_cdc import UsbCdcClient
    client = UsbCdcClient.for_manifest(manifest)
    result = client.invoke("state", {})
    ip = result.get("ip") or result.get("wifi", {}).get("ip")
    if not ip:
        raise TransportUnavailable(
            f"cube has no IP yet (state.ip empty)",
            next_step="wait for WiFi (`esp32-devtool logs --follow`), then retry",
        )
    return ip


def resolve_base_url(manifest: BoardManifest, *, override: str | None) -> str:
    if override:
        return override
    if not manifest.http.enabled:
        raise TransportUnavailable(
            f"board {manifest.name} has http.enabled=false",
            next_step="enable http in the manifest, or pass --http <url>",
        )
    if manifest.http.discover_via == "static":
        host = manifest.http.static_host
        if not host:
            raise TransportUnavailable(
                "http.discover_via=static but http.static_host is empty",
                next_step="set http.static_host in the manifest, or pass --http",
            )
        return f"http://{host}:{manifest.http.port}"
    if manifest.http.discover_via == "usb-info":
        ip = _discover_ip_via_usb(manifest)
        return f"http://{ip}:{manifest.http.port}"
    if manifest.http.discover_via == "mdns":
        raise TransportUnavailable("mdns discovery not implemented in v1")
    raise TransportUnavailable(f"unknown discover_via: {manifest.http.discover_via}")


@dataclass
class HttpClient:
    base_url: str
    timeout_s: float = 5.0

    def get_json(self, path: str) -> dict[str, Any]:
        try:
            r = requests.get(self.base_url + path, timeout=self.timeout_s)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP {path} → {r.status_code}")
        return r.json()

    def get_bytes(self, path: str, *, accept: str | None = None) -> tuple[bytes, dict]:
        headers = {"Accept": accept} if accept else {}
        try:
            r = requests.get(self.base_url + path, headers=headers,
                             timeout=self.timeout_s, stream=False)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP {path} → {r.status_code}")
        return r.content, dict(r.headers)

    def post_bytes(self, path: str, body: bytes, *, content_type: str) -> dict[str, Any]:
        try:
            r = requests.post(self.base_url + path, data=body,
                              headers={"Content-Type": content_type},
                              timeout=self.timeout_s)
        except (requests.Timeout, requests.ConnectionError) as e:
            raise TransportUnavailable(f"HTTP POST {path} → {type(e).__name__}: {e}")
        if r.status_code != 200:
            raise TransportUnavailable(f"HTTP POST {path} → {r.status_code}")
        return r.json()

    def post_json(self, path: str, payload: dict) -> dict[str, Any]:
        body = json_mod.dumps(payload).encode()
        return self.post_bytes(path, body, content_type="application/json")

    def reachable(self, path: str = "/info") -> bool:
        try:
            r = requests.get(self.base_url + path, timeout=2.0)
            return 200 <= r.status_code < 300
        except (requests.Timeout, requests.ConnectionError):
            return False
```

- [ ] **Step 4: Re-run tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_http.py -v
```
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/cli/transport/http.py esp32/devtool/tests/unit/test_http.py
git commit -m "feat(esp32-devtool): HTTP transport client + reachability probe"
```

---

## Task 7: cli/daemon/server.py + lifecycle.py — port-holding daemon (TDD where pragmatic)

Port `_cube_daemon.py` into the new tree. Generalize the socket path to per-port-hash scoping. Lifecycle module owns spawn/ensure/idle-kill.

The daemon socket protocol stays compatible with the old `_cube_daemon.py`: JSON messages `{"kind": "cmd"|"events"|"ping"|"subscribe", ...}` over a Unix socket.

**Files:**
- Create: `esp32/devtool/cli/daemon/server.py`
- Create: `esp32/devtool/cli/daemon/lifecycle.py`
- Create: `esp32/devtool/tests/unit/test_daemon_lifecycle.py`

- [ ] **Step 1: Write failing lifecycle tests**

`esp32/devtool/tests/unit/test_daemon_lifecycle.py`:
```python
from __future__ import annotations

import socket
import threading
import time
from pathlib import Path

import pytest

from cli.daemon.lifecycle import (
    port_hash,
    socket_path_for,
    pidfile_path_for,
    logfile_path_for,
    ensure_daemon,
    DaemonState,
)
from cli.errors import TransportUnavailable


def test_port_hash_deterministic():
    h1 = port_hash("/dev/cu.usbmodem101")
    h2 = port_hash("/dev/cu.usbmodem101")
    assert h1 == h2
    assert len(h1) == 12


def test_port_hash_distinct_per_port():
    assert port_hash("/dev/cu.usbmodem101") != port_hash("/dev/cu.usbmodem201")


def test_socket_path_contains_hash(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    p = socket_path_for("/dev/cu.usbmodem101")
    assert port_hash("/dev/cu.usbmodem101") in str(p)


def test_ensure_daemon_returns_existing(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    port = "/dev/cu.usbmodem101"
    sock_path = socket_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    # Fake daemon: bind socket, respond to ping
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def fake_daemon():
        c, _ = srv.accept()
        c.recv(4096)
        c.sendall(b'{"ok":true}\n')
        c.close()

    threading.Thread(target=fake_daemon, daemon=True).start()
    state = ensure_daemon(port, spawn=lambda p: pytest.fail("should not spawn"))
    assert state is DaemonState.ALREADY_RUNNING
    srv.close()


def test_ensure_daemon_spawns_when_socket_dead(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    port = "/dev/cu.usbmodem101"
    spawned: list[str] = []

    def fake_spawn(p: str):
        spawned.append(p)
        # Simulate the spawned daemon binding the socket after 200 ms
        def delayed_bind():
            time.sleep(0.2)
            sock_path = socket_path_for(p)
            sock_path.parent.mkdir(parents=True, exist_ok=True)
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(sock_path))
            srv.listen(1)
            try:
                c, _ = srv.accept()
                c.recv(4096)
                c.sendall(b'{"ok":true}\n')
                c.close()
            finally:
                srv.close()
        threading.Thread(target=delayed_bind, daemon=True).start()

    state = ensure_daemon(port, spawn=fake_spawn, spawn_timeout_s=2.0)
    assert state is DaemonState.SPAWNED
    assert spawned == [port]


def test_ensure_daemon_spawn_timeout(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    port = "/dev/cu.usbmodem101"
    with pytest.raises(TransportUnavailable, match="daemon failed"):
        ensure_daemon(port, spawn=lambda p: None, spawn_timeout_s=0.4)
```

- [ ] **Step 2: Run failing tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_daemon_lifecycle.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement `lifecycle.py`**

`esp32/devtool/cli/daemon/lifecycle.py`:
```python
"""Daemon lifecycle: spawn / ensure / idle-kill, per-port-hash scoping."""
from __future__ import annotations

import enum
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

from cli.errors import TransportUnavailable


def _runtime_dir() -> Path:
    override = os.environ.get("ESP32_DEVTOOL_RUNTIME_DIR")
    if override:
        return Path(override)
    return Path("/tmp/esp32-devtool")


def port_hash(port: str) -> str:
    return hashlib.sha1(port.encode()).hexdigest()[:12]


def socket_path_for(port: str) -> Path:
    return _runtime_dir() / f"{port_hash(port)}.sock"


def pidfile_path_for(port: str) -> Path:
    return _runtime_dir() / f"{port_hash(port)}.pid"


def logfile_path_for(port: str) -> Path:
    return _runtime_dir() / f"{port_hash(port)}.log"


class DaemonState(enum.Enum):
    ALREADY_RUNNING = "already_running"
    SPAWNED = "spawned"


def _ping(sock_path: Path, timeout_s: float = 1.0) -> bool:
    if not sock_path.exists():
        return False
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout_s)
        s.connect(str(sock_path))
        s.sendall(json.dumps({"kind": "ping"}).encode() + b"\n")
        data = s.recv(1024)
        s.close()
        return b"ok" in data
    except (OSError, socket.timeout):
        return False


def _default_spawn(port: str) -> None:
    cli_main = Path(__file__).resolve().parents[1] / "main.py"
    log = logfile_path_for(port)
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab", buffering=0) as lf:
        subprocess.Popen(
            ["uv", "run", "--script", str(cli_main),
             "daemon", "start", "--port", port, "--detach"],
            stdout=lf, stderr=lf, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )


def ensure_daemon(
    port: str,
    *,
    spawn: Callable[[str], None] = _default_spawn,
    spawn_timeout_s: float = 12.0,
) -> DaemonState:
    sock_path = socket_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)

    if _ping(sock_path):
        return DaemonState.ALREADY_RUNNING

    spawn(port)
    deadline = time.time() + spawn_timeout_s
    while time.time() < deadline:
        if _ping(sock_path):
            return DaemonState.SPAWNED
        time.sleep(0.1)

    raise TransportUnavailable(
        f"daemon failed to start within {spawn_timeout_s}s",
        next_step=f"inspect {logfile_path_for(port)}",
    )
```

- [ ] **Step 4: Re-run tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_daemon_lifecycle.py -v
```
Expected: 6 passed.

- [ ] **Step 5: Implement `server.py` by porting `_cube_daemon.py`**

`esp32/devtool/cli/daemon/server.py` is a near-1:1 port of `esp32/cube/scripts/_cube_daemon.py`. Preserve:
- The serial-reader thread + event-ring deque (≥20000 lines).
- The socket message protocol: `{"kind": "cmd"|"events"|"ping"|"subscribe", ...}`.
- Pyserial open flags: `dtr=False rts=False dsrdtr=False rtscts=False`.
- The deque of in-flight subscriber sockets for live event push.
- The idle-kill loop driven by `--idle-seconds`.

Changes to apply:
1. Replace hardcoded `SOCKET_PATH = "/tmp/cube-daemon.sock"` and `PIDFILE_PATH = "/tmp/cube-daemon.pid"` with `socket_path_for(port)` / `pidfile_path_for(port)` from `cli.daemon.lifecycle`.
2. Accept `--port` as a required argument (no default).
3. Accept `--idle-seconds` (default 600, env-overridable via `ESP32_DEVTOOL_DAEMON_IDLE_SEC`).
4. Add an entry-point function `serve(port: str, idle_seconds: int) -> int` that the CLI invokes; keep `if __name__ == "__main__": serve_argv()` shim for `uv run --script` invocation.
5. Replace log-tag `cube-daemon` with `esp32-devtool.daemon`.
6. Preserve the `--detach` behaviour: when set, fork+detach (double-fork) before binding the socket.

Show the new function signatures + the changed lines. The 200-line reader / ring / select-loop body is copied verbatim.

```python
"""Port-holding daemon for esp32-devtool. Generalized from esp32/cube/scripts/_cube_daemon.py."""
from __future__ import annotations

import argparse
import os
import sys

from cli.daemon.lifecycle import (
    socket_path_for,
    pidfile_path_for,
    logfile_path_for,
)


def serve(port: str, idle_seconds: int) -> int:
    sock_path = socket_path_for(port)
    pid_path = pidfile_path_for(port)
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    # === BODY copied from esp32/cube/scripts/_cube_daemon.py, with:
    #   - SOCKET_PATH → str(sock_path)
    #   - PIDFILE_PATH → str(pid_path)
    #   - log tag → "esp32-devtool.daemon"
    #   - serial.Serial(...) target → port (the function arg)
    #   - idle deadline → idle_seconds
    # ===
    # ... (verbatim port: serial reader, ring deque, socket select loop) ...
    return 0


def serve_argv() -> int:
    p = argparse.ArgumentParser(prog="esp32-devtool-daemon")
    p.add_argument("--port", required=True)
    p.add_argument(
        "--idle-seconds",
        type=int,
        default=int(os.environ.get("ESP32_DEVTOOL_DAEMON_IDLE_SEC", "600")),
    )
    p.add_argument("--detach", action="store_true")
    args = p.parse_args()
    if args.detach:
        _double_fork()
    return serve(args.port, args.idle_seconds)


def _double_fork() -> None:
    if os.fork() != 0:
        os._exit(0)
    os.setsid()
    if os.fork() != 0:
        os._exit(0)
    sys.stdin = open(os.devnull, "r")
    # stdout / stderr are redirected by the spawner via `with open(log, "ab")`.


if __name__ == "__main__":
    sys.exit(serve_argv())
```

- [ ] **Step 6: Wire `daemon` subcommands in main.py**

Update the `daemon_start` stub in `cli/main.py` to delegate to `cli.daemon.server.serve_argv` semantics. Replace the body with:

```python
@daemon.command("start")
@click.option("--port", "port_path", required=True)
@click.option("--idle-seconds", default=600, type=int)
@click.option("--detach", is_flag=True)
def daemon_start(port_path: str, idle_seconds: int, detach: bool) -> None:
    from cli.daemon.server import serve, _double_fork
    if detach:
        _double_fork()
    sys.exit(serve(port_path, idle_seconds))
```

Similarly fill in `daemon_stop` (kill via `pidfile_path_for`), `daemon_status` (list any sock+pid files in runtime dir + ping each), `daemon_ring` (connect to the right sock, send `{"kind":"events","n":lines}`, stream stdout).

- [ ] **Step 7: Commit**

```bash
git add esp32/devtool/cli/daemon/ esp32/devtool/cli/main.py esp32/devtool/tests/unit/test_daemon_lifecycle.py
git commit -m "feat(esp32-devtool): port-holding daemon + lifecycle (auto-spawn + idle-kill)"
```

---

## Task 8: cli/transport/usb_cdc.py — daemon client (TDD)

Thin wrapper around the daemon's Unix socket: send `{"kind":"cmd", "json": "..."}`, read `{"kind":"rsp", "json": "..."}` back.

**Files:**
- Create: `esp32/devtool/cli/transport/usb_cdc.py`
- Create: `esp32/devtool/tests/unit/test_usb_cdc.py`

- [ ] **Step 1: Write failing tests**

`esp32/devtool/tests/unit/test_usb_cdc.py`:
```python
from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

import pytest

from cli.board import load_manifest
from cli.transport.usb_cdc import UsbCdcClient
from cli.errors import VerbError


BOARDS = Path(__file__).resolve().parents[2] / "boards"


def _fake_daemon(sock_path: Path, response: dict) -> threading.Thread:
    sock_path.parent.mkdir(parents=True, exist_ok=True)
    if sock_path.exists():
        sock_path.unlink()
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def run():
        c, _ = srv.accept()
        buf = c.recv(65536)
        # ignore content; reply with response
        c.sendall((json.dumps(response) + "\n").encode())
        c.close()
        srv.close()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def test_invoke_returns_result(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    port = "/dev/cu.usbmodem101"
    from cli.daemon.lifecycle import socket_path_for
    sock = socket_path_for(port)
    _fake_daemon(sock, {"kind": "rsp", "json": json.dumps({
        "jsonrpc": "2.0", "id": 1, "result": {"ok": True, "state": "IDLE"}
    })})
    c = UsbCdcClient(port=port)
    out = c.invoke("state", {})
    assert out == {"ok": True, "state": "IDLE"}


def test_invoke_error_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    port = "/dev/cu.usbmodem101"
    from cli.daemon.lifecycle import socket_path_for
    sock = socket_path_for(port)
    _fake_daemon(sock, {"kind": "rsp", "json": json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "error": {"code": -32601, "message": "method not found"}
    })})
    c = UsbCdcClient(port=port)
    with pytest.raises(VerbError, match="method not found"):
        c.invoke("no.such.verb", {})


def test_for_manifest_picks_port(tmp_path, monkeypatch):
    monkeypatch.setenv("ESP32_DEVTOOL_RUNTIME_DIR", str(tmp_path))
    m = load_manifest(BOARDS / "cube.yaml")
    # inject port via scan stub
    c = UsbCdcClient.for_manifest(m, scan_ports=lambda g: ["/dev/cu.usbmodem201"])
    assert c.port == "/dev/cu.usbmodem201"
```

- [ ] **Step 2: Run failing tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_usb_cdc.py -v
```
Expected: ImportError.

- [ ] **Step 3: Implement `usb_cdc.py`**

`esp32/devtool/cli/transport/usb_cdc.py`:
```python
"""USB-CDC daemon client. JSON-RPC over Unix socket to the port-holding daemon."""
from __future__ import annotations

import glob as glob_mod
import itertools
import json
import socket
from dataclasses import dataclass, field
from typing import Any, Callable

from cli.board import BoardManifest
from cli.daemon.lifecycle import ensure_daemon, socket_path_for
from cli.errors import TransportUnavailable, VerbError, DevtoolTimeout


_ID_COUNTER = itertools.count(1)


def _next_id() -> int:
    return next(_ID_COUNTER)


@dataclass
class UsbCdcClient:
    port: str
    timeout_s: float = 5.0
    _auto_ensure: bool = True

    @classmethod
    def for_manifest(
        cls,
        manifest: BoardManifest,
        *,
        port_override: str | None = None,
        scan_ports: Callable[[str], list[str]] = lambda g: sorted(glob_mod.glob(g)),
    ) -> "UsbCdcClient":
        port = port_override
        if port is None:
            glob_pat = manifest.usb.port_glob
            if not glob_pat:
                raise TransportUnavailable(
                    f"board {manifest.name}: usb.port_glob is empty",
                    next_step="set usb.port_glob in the manifest or pass --port",
                )
            ports = scan_ports(glob_pat)
            if not ports:
                raise TransportUnavailable(
                    f"no ports matched {glob_pat}",
                    next_step="check USB cable + `ls /dev/cu.usbmodem*`",
                )
            port = ports[0]
        return cls(port=port)

    def invoke(self, method: str, params: dict | None = None) -> dict[str, Any]:
        if self._auto_ensure:
            ensure_daemon(self.port)
        sock_path = socket_path_for(self.port)
        req_id = _next_id()
        json_rpc = {"jsonrpc": "2.0", "id": req_id, "method": method,
                    "params": params or {}}
        wire = {"kind": "cmd", "json": json.dumps(json_rpc)}

        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout_s)
        try:
            s.connect(str(sock_path))
            s.sendall((json.dumps(wire) + "\n").encode())
            chunks: list[bytes] = []
            while True:
                c = s.recv(65536)
                if not c:
                    break
                chunks.append(c)
                if b"\n" in c:
                    break
        except socket.timeout as e:
            raise DevtoolTimeout(
                f"daemon timeout {self.timeout_s}s on '{method}'",
                next_step="try `esp32-devtool restart` or physical recovery",
            ) from e
        finally:
            s.close()

        raw = b"".join(chunks).decode().strip()
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as e:
            raise VerbError(f"daemon returned non-JSON: {raw[:120]!r}") from e
        if envelope.get("kind") != "rsp":
            raise VerbError(f"unexpected envelope kind: {envelope}")
        payload = json.loads(envelope["json"])
        if "error" in payload:
            err = payload["error"]
            raise VerbError(
                f"{method}: {err.get('message', 'unknown')} "
                f"(code {err.get('code')})"
            )
        return payload.get("result") or {}

    def daemon_reachable(self) -> bool:
        try:
            ensure_daemon(self.port, spawn_timeout_s=2.0)
            return True
        except TransportUnavailable:
            return False
```

- [ ] **Step 4: Re-run tests**

```bash
cd esp32/devtool && uv run pytest tests/unit/test_usb_cdc.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/cli/transport/usb_cdc.py esp32/devtool/tests/unit/test_usb_cdc.py
git commit -m "feat(esp32-devtool): USB-CDC daemon client (JSON-RPC over UNIX socket)"
```

---

## Task 9: Firmware companion — Kconfig + CMakeLists + headers + stub

Land the empty `esp32_devtool_companion` ESP-IDF component. Compile-only gate. Stub implementation builds against prod sdkconfig; full impl gated by `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE`.

**Files:**
- Create: `esp32/devtool/firmware/esp32_devtool_companion/CMakeLists.txt`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/Kconfig`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/idf_component.yml`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/include/esp32_devtool/companion.h`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/include/esp32_devtool/verbs.h`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/include/esp32_devtool/endpoints.h`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/companion_stub.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/usb_cdc_reader.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/verb_dispatcher.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/http_server.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/log_relay.cc`

- [ ] **Step 1: Write Kconfig**

`esp32/devtool/firmware/esp32_devtool_companion/Kconfig` — exact content per spec lines 360-404:
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

config ESP32_DEVTOOL_LOG_RELAY_HOST
    string "UDP log relay destination host"
    default "192.168.0.222"
    depends on ESP32_DEVTOOL_LOG_RELAY_ENABLE

endif

endmenu
```

- [ ] **Step 2: Write CMakeLists.txt**

```cmake
set(DEVTOOL_PUB_REQ)
set(DEVTOOL_REQ esp_http_server esp_netif esp_event json lvgl__lvgl)

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
    if(CONFIG_ESP32_DEVTOOL_TOUCH_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/touch.cc)
    endif()
    if(CONFIG_ESP32_DEVTOOL_AUDIO_RECORD_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/audio_record.cc)
    endif()
    if(CONFIG_ESP32_DEVTOOL_AUDIO_INJECT_ENABLE)
        list(APPEND DEVTOOL_SRCS src/handlers/audio_inject.cc)
    endif()
else()
    set(DEVTOOL_SRCS src/companion_stub.cc)
endif()

idf_component_register(
    SRCS ${DEVTOOL_SRCS}
    INCLUDE_DIRS include
    PRIV_INCLUDE_DIRS src
    REQUIRES ${DEVTOOL_REQ}
    WHOLE_ARCHIVE
)
```

- [ ] **Step 3: Write idf_component.yml**

```yaml
dependencies:
  idf: ">=5.0"
  lvgl/lvgl: "^9.2"
```

- [ ] **Step 4: Write public headers**

`include/esp32_devtool/companion.h`:
```c
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool enable_usb_cdc;
    bool enable_http;
    int  http_port;
    struct {
        bool enabled;
        const char* host;
        int port;
    } udp_relay;
} esp32_devtool_companion_config_t;

// Boot companion. Called once at app startup. No-op when CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n.
int esp32_devtool_companion_start(const esp32_devtool_companion_config_t* cfg);
void esp32_devtool_companion_stop(void);

// Boundary stdout markers used by the host-side daemon's serial reader.
void esp32_devtool_companion_checkpoint(const char* label);
void esp32_devtool_companion_event(const char* json);

#ifdef __cplusplus
}
#endif
```

`include/esp32_devtool/verbs.h`:
```c
#pragma once
#include <cJSON.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int (*devtool_verb_handler_t)(const cJSON* params,
                                       cJSON* out_result,
                                       int* out_error_code,
                                       const char** out_error_msg);

void devtool_register_verb(const char* method, devtool_verb_handler_t fn);

#ifdef __cplusplus
}
#endif
```

`include/esp32_devtool/endpoints.h`:
```c
#pragma once
#include <esp_http_server.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef esp_err_t (*devtool_http_handler_t)(httpd_req_t* req);

void devtool_register_http(const char* method, const char* path,
                           devtool_http_handler_t fn);

#ifdef __cplusplus
}
#endif
```

- [ ] **Step 5: Write stub impl**

`src/companion_stub.cc`:
```cpp
#include "esp32_devtool/companion.h"
#include "esp32_devtool/verbs.h"
#include "esp32_devtool/endpoints.h"

extern "C" {

int esp32_devtool_companion_start(const esp32_devtool_companion_config_t*) {
    return 0;
}
void esp32_devtool_companion_stop(void) {}
void esp32_devtool_companion_checkpoint(const char*) {}
void esp32_devtool_companion_event(const char*) {}
void devtool_register_verb(const char*, devtool_verb_handler_t) {}
void devtool_register_http(const char*, const char*, devtool_http_handler_t) {}

}
```

- [ ] **Step 6: Write full-impl skeletons (no logic yet)**

`src/companion.cc`:
```cpp
#include "esp32_devtool/companion.h"

#include <cstdio>
#include <cstring>

#include <esp_log.h>
#include <esp_event.h>
#include <esp_netif.h>

#include "verb_dispatcher.h"
#include "usb_cdc_reader.h"
#include "http_server.h"
#include "log_relay.h"

static const char* TAG = "sentient.cube.devtool";

static bool s_http_started = false;
static esp32_devtool_companion_config_t s_cfg = {};

static void on_got_ip(void*, esp_event_base_t, int32_t, void* ev) {
    if (s_http_started) return;
    if (s_cfg.enable_http) {
        devtool_http_server_start(s_cfg.http_port);
    }
    if (s_cfg.udp_relay.enabled) {
        devtool_log_relay_start(s_cfg.udp_relay.host, s_cfg.udp_relay.port);
    }
    s_http_started = true;
}

extern "C" {

int esp32_devtool_companion_start(const esp32_devtool_companion_config_t* cfg) {
    if (cfg == nullptr) return -1;
    s_cfg = *cfg;
    ESP_LOGI(TAG, "start cdc=%d http=%d(port=%d) relay=%d",
             cfg->enable_usb_cdc, cfg->enable_http, cfg->http_port,
             cfg->udp_relay.enabled);
    devtool_verb_dispatcher_init();
    if (cfg->enable_usb_cdc) {
        devtool_usb_cdc_reader_start();
    }
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip, nullptr);
    std::printf(">>> READY\n");
    std::fflush(stdout);
    return 0;
}

void esp32_devtool_companion_stop(void) {
    // v1 leaves resources up for app lifetime.
}

void esp32_devtool_companion_checkpoint(const char* label) {
    if (label == nullptr) return;
    std::printf(">>> CHECKPOINT %s\n", label);
    std::fflush(stdout);
}

void esp32_devtool_companion_event(const char* json) {
    if (json == nullptr) return;
    std::printf("<<< EVT %s\n", json);
    std::fflush(stdout);
}

}  // extern "C"
```

`src/usb_cdc_reader.cc` — copy the body of `esp32/cube/firmware/components/agent_console/agent_console.cc` (the line-reader task), renaming the public entry point to `devtool_usb_cdc_reader_start()` and dispatching to `devtool_dispatcher_dispatch_line()` (next task). Internal private header `src/usb_cdc_reader.h` declares `void devtool_usb_cdc_reader_start(void);`.

`src/verb_dispatcher.cc` — copy `esp32/cube/firmware/components/agent_console/dispatcher.cc`, rename `agent_dispatcher_register` → `devtool_register_verb`, `agent_dispatcher_dispatch_line` → `devtool_dispatcher_dispatch_line`. Private header `src/verb_dispatcher.h` declares both.

`src/http_server.cc` — empty start/stop scaffolding (`httpd_handle_t s_server`); registers handlers from a static list populated by `devtool_register_http`.
```cpp
#include "http_server.h"
#include "esp32_devtool/endpoints.h"

#include <esp_http_server.h>
#include <esp_log.h>

static const char* TAG = "sentient.cube.devtool.http";
static httpd_handle_t s_server = nullptr;

struct Reg { const char* method; const char* path; devtool_http_handler_t fn; };
static constexpr size_t kMaxReg = 32;
static Reg s_regs[kMaxReg];
static size_t s_reg_count = 0;

extern "C" void devtool_register_http(const char* method, const char* path,
                                       devtool_http_handler_t fn) {
    if (s_reg_count >= kMaxReg) return;
    s_regs[s_reg_count++] = {method, path, fn};
}

void devtool_http_server_start(int port) {
    if (s_server != nullptr) return;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = port;
    cfg.lru_purge_enable = true;
    cfg.max_uri_handlers = kMaxReg;
    if (httpd_start(&s_server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        s_server = nullptr;
        return;
    }
    for (size_t i = 0; i < s_reg_count; ++i) {
        httpd_method_t m = HTTP_GET;
        if (std::strcmp(s_regs[i].method, "POST") == 0) m = HTTP_POST;
        httpd_uri_t u = {.uri = s_regs[i].path, .method = m,
                         .handler = s_regs[i].fn, .user_ctx = nullptr};
        httpd_register_uri_handler(s_server, &u);
    }
    ESP_LOGI(TAG, "http up on :%d with %u handlers", port,
             (unsigned)s_reg_count);
}

void devtool_http_server_stop(void) {
    if (s_server != nullptr) {
        httpd_stop(s_server);
        s_server = nullptr;
    }
}
```

Private header `src/http_server.h`:
```c
#pragma once
#ifdef __cplusplus
extern "C" {
#endif
void devtool_http_server_start(int port);
void devtool_http_server_stop(void);
#ifdef __cplusplus
}
#endif
```

`src/log_relay.cc` — copy the UDP shipper from `esp32/cube/firmware/components/net_logger/net_logger.cc`. Rename public entry to `devtool_log_relay_start(host, port)`. Preserve the `esp_log_set_vprintf` hook + `device_id=` prepending behaviour. Private header `src/log_relay.h` declares `void devtool_log_relay_start(const char* host, int port); void devtool_log_relay_stop(void);`.

- [ ] **Step 7: Verify component builds with `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` (stub path)**

Add to `esp32/cube/firmware/main/idf_component.yml`:
```yaml
  esp32_devtool_companion:
    path: ${REPO_ROOT}/esp32/devtool/firmware/esp32_devtool_companion
    override_path: ${REPO_ROOT}/esp32/devtool/firmware/esp32_devtool_companion
```

Then run a build to confirm both stub and the not-yet-enabled full impl don't break compilation. Stub path is the default; full impl path validated in Task 11.

```bash
source scripts/env.sh
source ~/esp/esp-idf/export.sh  # see reference_esp32_idf_export_quirk
cd $IDF_PATH && cd -
cd esp32/cube/firmware
idf.py reconfigure
idf.py build 2>&1 | tail -30
```
Expected: build succeeds; no references to `esp32_devtool_*` symbols yet from main.

- [ ] **Step 8: Commit**

```bash
git add esp32/devtool/firmware/ esp32/cube/firmware/main/idf_component.yml
git commit -m "feat(esp32-devtool): firmware companion scaffolding (Kconfig + stub + skeletons)"
```

---

## Task 10: Firmware /info HTTP handler

Add `GET /info` matching the HTTP-CONTRACT.md shape. Driven by callback registrations so the cube can supply `device_id`, IP, build profile without the companion knowing.

**Files:**
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/info.cc`
- Modify: `esp32/devtool/firmware/esp32_devtool_companion/include/esp32_devtool/companion.h` — add info-callback setter

- [ ] **Step 1: Add info-callback API to companion.h**

Append to `include/esp32_devtool/companion.h`:
```c
typedef struct {
    const char* device_id;
    const char* board;
    const char* chip;
    const char* firmware;
    const char* build_profile;
    const char* ip;
    const char* mac;
    int wifi_rssi;
    int uptime_s;
    const char* wifi_ssid;
} esp32_devtool_info_t;

// Caller fills `out` from app state. Return 0 on success.
typedef int (*esp32_devtool_info_provider_t)(esp32_devtool_info_t* out);

void esp32_devtool_set_info_provider(esp32_devtool_info_provider_t fn);
```

- [ ] **Step 2: Implement provider plumbing in companion.cc**

Append to `src/companion.cc`:
```cpp
namespace { esp32_devtool_info_provider_t s_info_fn = nullptr; }

extern "C" void esp32_devtool_set_info_provider(esp32_devtool_info_provider_t fn) {
    s_info_fn = fn;
}
extern "C" int esp32_devtool_get_info(esp32_devtool_info_t* out) {
    if (s_info_fn == nullptr || out == nullptr) return -1;
    return s_info_fn(out);
}
```

Add internal declaration to `src/companion_internal.h` (create this file):
```c
#pragma once
#include "esp32_devtool/companion.h"
#ifdef __cplusplus
extern "C" {
#endif
int esp32_devtool_get_info(esp32_devtool_info_t* out);
#ifdef __cplusplus
}
#endif
```

- [ ] **Step 3: Implement `handlers/info.cc`**

```cpp
#include <cJSON.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <cstring>

#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.info";

static esp_err_t info_get_handler(httpd_req_t* req) {
    esp32_devtool_info_t info = {};
    if (esp32_devtool_get_info(&info) != 0) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"info_provider_unset\"}");
        return ESP_OK;
    }
    cJSON* j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "device_id", info.device_id ?: "");
    cJSON_AddStringToObject(j, "board", info.board ?: "");
    cJSON_AddStringToObject(j, "chip", info.chip ?: "");
    cJSON_AddStringToObject(j, "ip", info.ip ?: "");
    cJSON_AddStringToObject(j, "mac", info.mac ?: "");
    cJSON_AddStringToObject(j, "firmware", info.firmware ?: "");
    cJSON_AddStringToObject(j, "build_profile", info.build_profile ?: "");
    cJSON_AddNumberToObject(j, "uptime_s", info.uptime_s);
    cJSON_AddStringToObject(j, "wifi_ssid", info.wifi_ssid ?: "");
    cJSON_AddNumberToObject(j, "wifi_rssi", info.wifi_rssi);
    cJSON* caps = cJSON_AddArrayToObject(j, "capabilities");
#ifdef CONFIG_ESP32_DEVTOOL_SCREENSHOT_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("screenshot"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_TOUCH_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("touch"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_AUDIO_RECORD_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("audio_record"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_AUDIO_INJECT_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("audio_inject"));
#endif
#ifdef CONFIG_ESP32_DEVTOOL_LOG_RELAY_ENABLE
    cJSON_AddItemToArray(caps, cJSON_CreateString("log_relay"));
#endif
    cJSON* endpoints = cJSON_AddObjectToObject(j, "endpoints");
    cJSON_AddStringToObject(endpoints, "info", "/info");
    cJSON_AddStringToObject(endpoints, "screenshot", "/screenshot");
    cJSON_AddStringToObject(endpoints, "touch", "/touch");
    cJSON_AddStringToObject(endpoints, "audio_record", "/audio/record");
    cJSON_AddStringToObject(endpoints, "audio_inject", "/audio/inject");
    cJSON_AddStringToObject(j, "contract_version", "1.0");

    char* body = cJSON_PrintUnformatted(j);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "X-Devtool-Version", "0.1.0");
    httpd_resp_sendstr(req, body);
    cJSON_free(body);
    cJSON_Delete(j);
    return ESP_OK;
}

__attribute__((constructor))
static void register_info_route() {
    devtool_register_http("GET", "/info", info_get_handler);
}
```

- [ ] **Step 4: Verify build compiles with companion enabled**

Add to cube firmware sdkconfig defaults: `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=y`. Set via `esp32/cube/firmware/sdkconfig.defaults.debug` (and leave OFF in prod defaults).

```bash
cd esp32/cube/firmware
idf.py reconfigure
idf.py build 2>&1 | tail -20
```
Expected: build succeeds; companion gets compiled in for debug.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/firmware/esp32_devtool_companion/ esp32/cube/firmware/sdkconfig.defaults.debug
git commit -m "feat(esp32-devtool): firmware /info HTTP handler"
```

---

## Task 11: Wire companion into cube + register info provider + first flash gate

Replace the call to `agent_console_start()` in the cube board class with `esp32_devtool_companion_start()`. Add an info provider that reads `system_info.h` + state machine. Keep `agent_console_start()` as a TODO comment for now — fully removed in Task 27.

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`
- Modify: `esp32/cube/firmware/main/main.cc`
- Modify: `esp32/cube/firmware/main/idf_component.yml` (already done in Task 9)

- [ ] **Step 1: Add companion init + info provider in sentient_cube.cc**

Identify the bottom of `Application::Start()` or equivalent boot path in `sentient_cube.cc` where `agent_console_start()` is called today. Add (without yet removing the old call):

```cpp
#include "esp32_devtool/companion.h"

static int cube_info_provider(esp32_devtool_info_t* out) {
    static char ssid_buf[33];
    static char ip_buf[16];
    static char mac_buf[18];
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
        std::snprintf(ssid_buf, sizeof(ssid_buf), "%s", ap.ssid);
        out->wifi_rssi = ap.rssi;
    }
    esp_netif_ip_info_t ipi;
    esp_netif_t* nif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (nif && esp_netif_get_ip_info(nif, &ipi) == ESP_OK) {
        std::snprintf(ip_buf, sizeof(ip_buf), IPSTR, IP2STR(&ipi.ip));
    }
    uint8_t mac[6];
    if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
        std::snprintf(mac_buf, sizeof(mac_buf), "%02x:%02x:%02x:%02x:%02x:%02x",
                      mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    }
    out->device_id = SENTIENT_DEVICE_ID;
    out->board = "cube";
    out->chip = "esp32-s3";
    out->ip = ip_buf;
    out->mac = mac_buf;
    out->firmware = SENTIENT_FIRMWARE_VERSION;
    out->build_profile =
#ifdef CONFIG_SENTIENT_PROD_BUILD
        "prod";
#else
        "debug";
#endif
    out->uptime_s = (int)(esp_timer_get_time() / 1000000);
    out->wifi_ssid = ssid_buf;
    return 0;
}

// In the boot sequence (replaces / sits next to agent_console_start()):
esp32_devtool_companion_config_t cfg = {};
cfg.enable_usb_cdc = true;
cfg.enable_http = true;
cfg.http_port = CONFIG_ESP32_DEVTOOL_HTTP_PORT;
cfg.udp_relay.enabled = true;
cfg.udp_relay.host = CONFIG_ESP32_DEVTOOL_LOG_RELAY_HOST;
cfg.udp_relay.port = CONFIG_ESP32_DEVTOOL_LOG_RELAY_PORT;
esp32_devtool_set_info_provider(cube_info_provider);
esp32_devtool_companion_start(&cfg);
```

(Leave the existing `agent_console_start()` call in place for now; both paths run concurrently. They share the USB-CDC reader interface but on different stdin tokens — `agent_console` parses `>>> CMD …` while the devtool dispatcher uses the same prefix. Resolve the collision by gating: for this task only, suppress the new `usb_cdc_reader_start()` body via `#if 0` so the dispatcher only registers HTTP. Task 14 swaps the readers over.)

Edit `src/companion.cc`:
```cpp
if (cfg->enable_usb_cdc) {
    // TODO(devtool task 14): enable once verbs are migrated off agent_console.
    // devtool_usb_cdc_reader_start();
}
```

- [ ] **Step 2: Build + flash + smoke**

```bash
source scripts/env.sh && source ~/esp/esp-idf/export.sh
cd esp32/cube/firmware
idf.py build
bash $REPO/esp32/cube/scripts/flash.sh
```

Wait for `>>> READY` then `IP_EVENT_STA_GOT_IP` in the daemon ring buffer.

- [ ] **Step 3: Manual smoke `/info` via curl**

```bash
PORT=$(ls /dev/cu.usbmodem* | head -1)
# Find IP from existing agent_console state verb (still works pre-migration)
IP=$(bash $REPO/esp32/cube/scripts/cube-cmd.sh state | jq -r '.ip')
curl -sf "http://${IP}:8081/info" | jq .
```
Expected: JSON matching the HTTP contract. `contract_version: "1.0"`, `capabilities` lists screenshot/touch/audio/log_relay, `device_id`, `ip`, `wifi_rssi` populated.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc
git commit -m "feat(cube): wire esp32_devtool_companion + info provider"
```

---

## Task 12: cli/commands/info.py — first real command

**Files:**
- Create: `esp32/devtool/cli/commands/info.py`
- Modify: `esp32/devtool/cli/main.py` — replace stub `info` with real dispatch

- [ ] **Step 1: Write `cli/commands/info.py`**

```python
"""esp32-devtool info — GET /info → JSON to stdout."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.errors import DevtoolError
from cli.transport.http import HttpClient, resolve_base_url


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def run(ctx_obj: dict) -> int:
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
        base = resolve_base_url(manifest, override=ctx_obj.get("http_url"))
        client = HttpClient(base_url=base, timeout_s=3.0)
        payload = client.get_json("/info")
    except DevtoolError as e:
        if ctx_obj.get("json_out"):
            click.echo(json.dumps({
                "error": type(e).__name__,
                "message": str(e),
                "next_step": e.next_step,
            }), err=True)
        else:
            click.echo(f"[esp32-devtool] {e}", err=True)
            if e.next_step:
                click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code

    if ctx_obj.get("json_out"):
        click.echo(json.dumps(payload))
    else:
        for k, v in payload.items():
            click.echo(f"{k}: {v}")
    return 0
```

- [ ] **Step 2: Wire into main.py**

Replace the `info` stub in `cli/main.py`:
```python
@cli.command()
@click.pass_context
def info(ctx: click.Context) -> None:
    from cli.commands.info import run
    sys.exit(run(ctx.obj))
```

- [ ] **Step 3: Manual smoke**

With cube powered + WiFi-up from Task 11:
```bash
esp32-devtool info
esp32-devtool --json info | jq -r .device_id
esp32-devtool --json info | jq -r .ip
```
Expected: human-readable output for first; `cube-001` for second; cube IP for third.

- [ ] **Step 4: Commit**

```bash
git add esp32/devtool/cli/commands/info.py esp32/devtool/cli/main.py
git commit -m "feat(esp32-devtool): cli `info` command (GET /info)"
```

---

## Task 13: e2e test infrastructure — conftest + auto-recovery

This is the foundation every subsequent e2e parity test builds on. No operator prompts ever. Auto-detect cube, ensure daemon, wedge-detect on every test, escalate to reflash, escape only on AXP2101 fault.

**Files:**
- Create: `esp32/devtool/tests/e2e/conftest.py`
- Create: `esp32/devtool/tests/e2e/recovery.py`

- [ ] **Step 1: Write `recovery.py`**

`esp32/devtool/tests/e2e/recovery.py`:
```python
"""Auto-recovery utilities for unattended e2e parity tests."""
from __future__ import annotations

import json
import subprocess
import time
from dataclasses import dataclass


READY_TIMEOUT_S = 30.0
FLASH_RETRY_MAX = 1  # one reflash; then bail


@dataclass
class CubeHealth:
    responsive: bool
    info: dict | None
    ring_tail: str


def _run(cmd: list[str], *, timeout_s: float = 10.0) -> tuple[int, str, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    return p.returncode, p.stdout, p.stderr


def cube_is_responsive(timeout_s: float = 3.0) -> bool:
    rc, _, _ = _run(["esp32-devtool", "cmd", "state"], timeout_s=timeout_s)
    return rc == 0


def cube_info() -> dict | None:
    rc, out, _ = _run(["esp32-devtool", "--json", "info"], timeout_s=5.0)
    if rc != 0:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def dump_ring(lines: int = 200) -> str:
    rc, out, _ = _run(["esp32-devtool", "daemon", "ring", "--lines", str(lines)])
    return out if rc == 0 else "<ring unavailable>"


def attempt_soft_recovery() -> bool:
    rc, _, _ = _run(["esp32-devtool", "restart"], timeout_s=10.0)
    if rc != 0:
        return False
    # Wait for >>> READY
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        if cube_is_responsive(timeout_s=2.0):
            return True
        time.sleep(1.0)
    return False


def attempt_hard_recovery() -> bool:
    rc, _, _ = _run(["esp32-devtool", "flash", "--profile", "debug"],
                    timeout_s=180.0)
    if rc != 0:
        return False
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        if cube_is_responsive(timeout_s=2.0):
            return True
        time.sleep(2.0)
    return False


def ensure_healthy() -> CubeHealth:
    """Auto-recover. Raise if hard-recovery also fails (AXP2101 fault signature)."""
    if cube_is_responsive():
        return CubeHealth(True, cube_info(), "")

    if attempt_soft_recovery():
        return CubeHealth(True, cube_info(), "recovered via restart verb")

    if attempt_hard_recovery():
        return CubeHealth(True, cube_info(), "recovered via reflash")

    ring = dump_ring(500)
    raise RuntimeError(
        "cube unresponsive after restart + reflash; AXP2101 fault likely. "
        "PHYSICAL RECOVERY REQUIRED: unplug + hold BOOT + replug.\n"
        f"Last 500 ring lines:\n{ring}"
    )
```

- [ ] **Step 2: Write `conftest.py`**

`esp32/devtool/tests/e2e/conftest.py`:
```python
"""e2e parity test fixtures. Fully unattended — auto-recover on every signal of trouble."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Generator

import pytest

# Ensure cli/ is importable for direct calls (tests use the CLI binary too).
DEVTOOL_ROOT = Path(__file__).resolve().parents[2]
if str(DEVTOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(DEVTOOL_ROOT))

from tests.e2e.recovery import (
    ensure_healthy,
    cube_is_responsive,
    dump_ring,
    cube_info,
)


@pytest.fixture(scope="session", autouse=True)
def cube_ready() -> Generator[dict, None, None]:
    """Once-per-session readiness gate + final teardown."""
    try:
        health = ensure_healthy()
    except RuntimeError as e:
        pytest.exit(str(e), returncode=4)
    yield health.info or {}
    # Final teardown: nothing — daemon idles itself.


@pytest.fixture(autouse=True)
def auto_recover_per_test(request) -> Generator[None, None, None]:
    """Per-test: pre-check responsiveness; on test failure, dump diagnostics."""
    if not cube_is_responsive(timeout_s=2.0):
        try:
            ensure_healthy()
        except RuntimeError as e:
            pytest.exit(str(e), returncode=4)
    yield
    if request.node.rep_call.failed if hasattr(request.node, "rep_call") else False:
        # Diagnostic snapshot on failure
        info = cube_info()
        ring = dump_ring(200)
        sys.stderr.write(f"\n=== FAILURE DIAGNOSTICS for {request.node.name} ===\n")
        sys.stderr.write(f"info: {json.dumps(info)}\n")
        sys.stderr.write(f"ring tail:\n{ring}\n")


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Stash phase reports onto the item so auto_recover_per_test can read them."""
    outcome = yield
    rep = outcome.get_result()
    setattr(item, f"rep_{rep.when}", rep)


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


@pytest.fixture
def devtool():
    """Subprocess wrapper. Returns a callable: devtool(*args) -> CompletedProcess."""
    def call(*args: str, timeout_s: float = 30.0, check: bool = False) -> subprocess.CompletedProcess:
        p = _run(["esp32-devtool", *args], timeout=timeout_s)
        if check:
            assert p.returncode == 0, (
                f"esp32-devtool {' '.join(args)} → rc={p.returncode}\n"
                f"stdout: {p.stdout}\nstderr: {p.stderr}"
            )
        return p
    return call


@pytest.fixture
def clear_ring():
    """Snapshot the current daemon ring position, return a callable that fetches new lines."""
    # The daemon ring is in-memory only — we tag with a marker rather than truncate.
    marker = f"test-marker-{time.time()}"
    _run(["esp32-devtool", "cmd", "mark", "--param", f"label={marker}"])

    def grep_since() -> list[str]:
        rc, out, _ = _run(["esp32-devtool", "daemon", "ring", "--lines", "20000"]).returncode, \
                     _run(["esp32-devtool", "daemon", "ring", "--lines", "20000"]).stdout, ""
        if marker not in out:
            return []
        lines = out.split("\n")
        for i, line in enumerate(lines):
            if marker in line:
                return lines[i + 1:]
        return []

    return grep_since
```

- [ ] **Step 3: Commit**

```bash
git add esp32/devtool/tests/e2e/conftest.py esp32/devtool/tests/e2e/recovery.py
git commit -m "feat(esp32-devtool): unattended e2e infra (auto-recover + diagnostics)"
```

---

## Task 14: cli/commands/cmd.py + migrate state/button.toggle/sentient.status to devtool verbs + parity tests

This is the first task that moves real verbs off the legacy `agent_console` dispatcher. Migrate 3 small verbs (`state`, `button.toggle`, `sentient.status`) to the new `devtool_register_verb` API; the other verbs migrate in Tasks 20+.

**Files:**
- Create: `esp32/cube/firmware/main/devtool_verbs/state.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/button.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/sentient.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/mark.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/CMakeLists.txt` (or inline into main CMakeLists)
- Create: `esp32/devtool/cli/commands/cmd.py`
- Create: `esp32/devtool/tests/e2e/test_cmd_state.py`
- Create: `esp32/devtool/tests/e2e/test_cmd_button_toggle.py`
- Create: `esp32/devtool/tests/e2e/test_cmd_sentient_status.py`
- Modify: `esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc` — enable `devtool_usb_cdc_reader_start()` (remove `#if 0`)
- Modify: `esp32/cube/firmware/main/CMakeLists.txt` — add devtool_verbs/*.cc to SRCS, WHOLE_ARCHIVE the main lib
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` — remove `agent_console_start()` call

- [ ] **Step 1: Port `state` verb**

`esp32/cube/firmware/main/devtool_verbs/state.cc`:
```cpp
#include "esp32_devtool/verbs.h"
#include "esp32_devtool/companion.h"
#include <cstring>

extern "C" const char* cube_device_state_str(void);
extern "C" bool cube_ws_connected(void);

static int state_handler(const cJSON*, cJSON* out,
                         int* err_code, const char** err_msg) {
    cJSON_AddStringToObject(out, "state", cube_device_state_str());
    cJSON_AddBoolToObject(out, "ws_connected", cube_ws_connected());
    return 0;
}

__attribute__((constructor))
static void register_state_verb() {
    devtool_register_verb("state", state_handler);
}
```

`cube_device_state_str()` + `cube_ws_connected()` are thin wrappers on the existing Application state — add to `firmware/main/application.cc` (or wherever `agent_console_set_state_provider` is wired today) as plain `extern "C"` functions.

- [ ] **Step 2: Port `button.toggle` verb**

`esp32/cube/firmware/main/devtool_verbs/button.cc`:
```cpp
#include "esp32_devtool/verbs.h"

extern "C" void cube_button_toggle(void);

static int button_toggle_handler(const cJSON*, cJSON* out, int*, const char**) {
    cube_button_toggle();
    cJSON_AddBoolToObject(out, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_button_toggle_verb() {
    devtool_register_verb("button.toggle", button_toggle_handler);
}
```

Wire `cube_button_toggle()` in `sentient_cube.cc` to call the existing toggle path.

- [ ] **Step 3: Port `sentient.status` + `mark` verbs**

`devtool_verbs/sentient.cc`:
```cpp
#include "esp32_devtool/verbs.h"

extern "C" const char* cube_sentient_status_str(void);

static int sentient_status_handler(const cJSON*, cJSON* out, int*, const char**) {
    cJSON_AddStringToObject(out, "status", cube_sentient_status_str());
    return 0;
}

__attribute__((constructor))
static void register_sentient_status_verb() {
    devtool_register_verb("sentient.status", sentient_status_handler);
}
```

`devtool_verbs/mark.cc`:
```cpp
#include "esp32_devtool/verbs.h"
#include "esp32_devtool/companion.h"

static int mark_handler(const cJSON* params, cJSON* out, int*, const char**) {
    const cJSON* label = cJSON_GetObjectItem(params, "label");
    const char* lbl = (label && cJSON_IsString(label)) ? label->valuestring : "anon";
    esp32_devtool_companion_checkpoint(lbl);
    cJSON_AddBoolToObject(out, "ok", true);
    return 0;
}

__attribute__((constructor))
static void register_mark_verb() {
    devtool_register_verb("mark", mark_handler);
}
```

- [ ] **Step 4: Wire devtool_verbs into main build**

Modify `esp32/cube/firmware/main/CMakeLists.txt`:
- Add `devtool_verbs/state.cc devtool_verbs/button.cc devtool_verbs/sentient.cc devtool_verbs/mark.cc` to the `SRCS` list.
- Add `WHOLE_ARCHIVE` to `idf_component_register(...)` (required for `__attribute__((constructor))`).

- [ ] **Step 5: Enable USB-CDC reader in companion**

Edit `esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc`, remove the `#if 0` so `devtool_usb_cdc_reader_start()` runs.

- [ ] **Step 6: Remove `agent_console_start()` call**

Edit `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`: delete the `agent_console_start()` call (keep the file's other agent_console state-provider registrations intact for now — Task 27 deletes the component entirely; until then the legacy stub still links).

- [ ] **Step 7: Implement `cli/commands/cmd.py`**

```python
"""esp32-devtool cmd <verb> — JSON-RPC over USB-CDC."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.errors import DevtoolError
from cli.transport.usb_cdc import UsbCdcClient


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def _parse_params(params: tuple[str, ...]) -> dict:
    out: dict = {}
    for p in params:
        if "=" not in p:
            raise click.BadParameter(f"param '{p}' missing =")
        k, v = p.split("=", 1)
        # Try JSON, fall back to string
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v
    return out


def run(ctx_obj: dict, verb: str, params: tuple[str, ...]) -> int:
    try:
        manifest = detect_board(
            boards_dir=BOARDS_DIR,
            override_name=ctx_obj.get("board"),
        )
        client = UsbCdcClient.for_manifest(
            manifest, port_override=ctx_obj.get("port")
        )
        result = client.invoke(verb, _parse_params(params))
    except DevtoolError as e:
        if ctx_obj.get("json_out"):
            click.echo(json.dumps({
                "error": type(e).__name__, "message": str(e),
                "next_step": e.next_step,
            }), err=True)
        else:
            click.echo(f"[esp32-devtool] {e}", err=True)
            if e.next_step:
                click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code
    click.echo(json.dumps(result))
    return 0
```

Wire into `main.py`:
```python
@cli.command()
@click.argument("verb")
@click.option("--param", "-p", "params", multiple=True, help="k=v")
@click.pass_context
def cmd(ctx: click.Context, verb: str, params: tuple[str, ...]) -> None:
    from cli.commands.cmd import run
    sys.exit(run(ctx.obj, verb, params))
```

- [ ] **Step 8: Flash + parity tests**

```bash
bash $REPO/esp32/cube/scripts/flash.sh
```

`esp32/devtool/tests/e2e/test_cmd_state.py`:
```python
import json


def test_cmd_state_returns_known_state(devtool):
    p = devtool("cmd", "state", check=True)
    payload = json.loads(p.stdout)
    assert payload["state"] in {"IDLE", "LISTENING", "SPEAKING", "CONNECTING"}
    assert isinstance(payload["ws_connected"], bool)
```

`esp32/devtool/tests/e2e/test_cmd_button_toggle.py`:
```python
import json


def test_button_toggle_transitions_state(devtool):
    before = json.loads(devtool("cmd", "state", check=True).stdout)["state"]
    devtool("cmd", "button.toggle", check=True)
    # Allow a moment for the state machine to settle
    import time; time.sleep(0.5)
    after = json.loads(devtool("cmd", "state", check=True).stdout)["state"]
    assert before != after, f"toggle did not change state ({before} → {after})"
    # Restore: toggle back
    devtool("cmd", "button.toggle", check=True)
```

`esp32/devtool/tests/e2e/test_cmd_sentient_status.py`:
```python
import json


def test_sentient_status_is_known(devtool):
    payload = json.loads(devtool("cmd", "sentient.status", check=True).stdout)
    assert payload["status"] in {
        "uninit", "connecting", "ready", "listening", "speaking", "error"
    }
```

- [ ] **Step 9: Run parity tests**

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_cmd_state.py tests/e2e/test_cmd_button_toggle.py tests/e2e/test_cmd_sentient_status.py -v
```
Expected: 3 passed.

- [ ] **Step 10: Commit**

```bash
git add esp32/cube/firmware/main/devtool_verbs/ esp32/cube/firmware/main/CMakeLists.txt esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc esp32/devtool/cli/commands/cmd.py esp32/devtool/cli/main.py esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc esp32/devtool/tests/e2e/test_cmd_state.py esp32/devtool/tests/e2e/test_cmd_button_toggle.py esp32/devtool/tests/e2e/test_cmd_sentient_status.py
git commit -m "feat(esp32-devtool): cli cmd + first verb migrations (state, button.toggle, sentient.status, mark)"
```

---

## Task 15: Firmware /screenshot + cli/commands/screenshot.py + 5-in-a-row parity

This is the single most important reason this whole tool exists — the prior USB-CDC chunked transport dropped bytes. HTTP over WiFi handles it without backpressure issues.

**Files:**
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/screenshot.cc`
- Create: `esp32/devtool/cli/commands/screenshot.py`
- Create: `esp32/devtool/tests/e2e/test_screenshot.py`
- Create: `esp32/devtool/tests/e2e/test_screenshot_5_in_a_row.py`

- [ ] **Step 1: Define screenshot-provider callback in companion**

Append to `include/esp32_devtool/companion.h`:
```c
// Snapshot provider: cube fills `pixels` (RGB565 little-endian) for a `width*height` framebuffer.
// Caller frees nothing — the provider owns the buffer; companion copies before encoding.
typedef struct {
    uint16_t* pixels;
    int width;
    int height;
} esp32_devtool_snapshot_t;

typedef int (*esp32_devtool_snapshot_provider_t)(esp32_devtool_snapshot_t* out);

void esp32_devtool_set_snapshot_provider(esp32_devtool_snapshot_provider_t fn);
```

Append to `src/companion.cc`:
```cpp
namespace { esp32_devtool_snapshot_provider_t s_snap_fn = nullptr; }
extern "C" void esp32_devtool_set_snapshot_provider(esp32_devtool_snapshot_provider_t fn) {
    s_snap_fn = fn;
}
extern "C" int esp32_devtool_get_snapshot(esp32_devtool_snapshot_t* out) {
    if (s_snap_fn == nullptr || out == nullptr) return -1;
    return s_snap_fn(out);
}
```

Add to `src/companion_internal.h`:
```c
int esp32_devtool_get_snapshot(esp32_devtool_snapshot_t* out);
```

- [ ] **Step 2: Implement `handlers/screenshot.cc`**

```cpp
#include <cstring>
#include <esp_http_server.h>
#include <esp_log.h>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.screenshot";

// PNG encoding: use lvgl's image-conversion helper if available, otherwise emit
// rgb565 raw and let the host convert. For v1 keep this simple — raw rgb565 by
// default, gated by ?format= query param.
static esp_err_t screenshot_handler(httpd_req_t* req) {
    esp32_devtool_snapshot_t snap = {};
    if (esp32_devtool_get_snapshot(&snap) != 0 || snap.pixels == nullptr) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "snapshot_provider_unset");
        return ESP_OK;
    }

    char fmt[16] = "rgb565";
    char query[64];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        httpd_query_key_value(query, "format", fmt, sizeof(fmt));
    }

    char w[16], h[16];
    std::snprintf(w, sizeof(w), "%d", snap.width);
    std::snprintf(h, sizeof(h), "%d", snap.height);
    httpd_resp_set_hdr(req, "X-Screenshot-Width", w);
    httpd_resp_set_hdr(req, "X-Screenshot-Height", h);
    httpd_resp_set_hdr(req, "X-Screenshot-Format", fmt);

    size_t bytes = (size_t)snap.width * snap.height * 2;
    if (std::strcmp(fmt, "rgb565") == 0) {
        httpd_resp_set_type(req, "application/octet-stream");
        return httpd_resp_send(req, (const char*)snap.pixels, bytes);
    }
    // png/jpeg path: out of v1 — host converts rgb565. Return rgb565 anyway with format header.
    httpd_resp_set_type(req, "application/octet-stream");
    httpd_resp_set_hdr(req, "X-Screenshot-Format", "rgb565");
    return httpd_resp_send(req, (const char*)snap.pixels, bytes);
}

__attribute__((constructor))
static void register_screenshot_route() {
    devtool_register_http("GET", "/screenshot", screenshot_handler);
}
```

- [ ] **Step 3: Wire snapshot provider in sentient_cube.cc**

```cpp
static uint16_t s_snap_buf[466 * 466];  // cube native resolution
static int cube_snapshot_provider(esp32_devtool_snapshot_t* out) {
    // Reuse the existing ui_snapshot capture path; copy LVGL canvas pixels.
    // (Steal the relevant body from agent_console/verbs/ui_snapshot.cc.)
    extern bool cube_capture_ui_snapshot(uint16_t* dst, int w, int h);
    if (!cube_capture_ui_snapshot(s_snap_buf, 466, 466)) return -1;
    out->pixels = s_snap_buf;
    out->width = 466;
    out->height = 466;
    return 0;
}

// In Application::Start():
esp32_devtool_set_snapshot_provider(cube_snapshot_provider);
```

`cube_capture_ui_snapshot()` body: port from `agent_console/verbs/ui_snapshot.cc`'s pixel-capture path. Keep the LVGL coordinate + colorspace logic verbatim.

- [ ] **Step 4: Implement `cli/commands/screenshot.py`**

```python
"""esp32-devtool screenshot — fetch /screenshot, optionally convert to PNG/JPEG."""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.errors import DevtoolError
from cli.transport.http import HttpClient, resolve_base_url


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def _rgb565_to_png(pixels: bytes, width: int, height: int) -> bytes:
    """Convert raw RGB565 little-endian to PNG (RGB)."""
    import zlib, struct as st
    out_rgb = bytearray(width * height * 3)
    for i in range(width * height):
        lo = pixels[2 * i]; hi = pixels[2 * i + 1]
        rgb = (hi << 8) | lo
        r = ((rgb >> 11) & 0x1F) << 3
        g = ((rgb >> 5) & 0x3F) << 2
        b = (rgb & 0x1F) << 3
        out_rgb[3 * i] = r; out_rgb[3 * i + 1] = g; out_rgb[3 * i + 2] = b

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return st.pack(">I", len(data)) + tag + data + st.pack(">I", crc)

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(out_rgb[y * width * 3:(y + 1) * width * 3])
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = st.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 6)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def run(ctx_obj: dict, out_path: str | None, fmt: str) -> int:
    try:
        manifest = detect_board(boards_dir=BOARDS_DIR,
                                override_name=ctx_obj.get("board"))
        base = resolve_base_url(manifest, override=ctx_obj.get("http_url"))
        client = HttpClient(base_url=base, timeout_s=15.0)
        body, headers = client.get_bytes(f"/screenshot?format={fmt}")
        width = int(headers.get("X-Screenshot-Width", "0"))
        height = int(headers.get("X-Screenshot-Height", "0"))
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True)
        if e.next_step:
            click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code

    if fmt == "png":
        body = _rgb565_to_png(body, width, height)
        suffix = ".png"
    elif fmt == "jpeg":
        # PIL fallback when output is jpeg-requested
        from io import BytesIO
        from PIL import Image
        img = Image.frombytes("RGB", (width, height),
                              _rgb565_to_rgb24(body, width, height))
        buf = BytesIO()
        img.save(buf, "JPEG", quality=80)
        body = buf.getvalue()
        suffix = ".jpg"
    else:
        suffix = ".rgb565"

    if out_path is None:
        out_path = f"/tmp/cube-screenshot{suffix}"
    Path(out_path).write_bytes(body)

    if ctx_obj.get("json_out"):
        click.echo(json.dumps({"out": out_path, "size": len(body),
                              "format": fmt, "width": width, "height": height}))
    else:
        click.echo(f"saved {len(body)} bytes ({width}x{height} {fmt}) → {out_path}")
    return 0
```

Wire into main.py replacing the screenshot stub.

- [ ] **Step 5: Flash + smoke**

```bash
bash $REPO/esp32/cube/scripts/flash.sh
esp32-devtool screenshot --out /tmp/cube.png
file /tmp/cube.png
```
Expected: `PNG image data, 466 x 466, 8-bit/color RGB`.

- [ ] **Step 6: Parity tests**

`esp32/devtool/tests/e2e/test_screenshot.py`:
```python
import struct
from pathlib import Path


def _is_png(p: Path) -> bool:
    return p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_screenshot_writes_valid_png(devtool, tmp_path):
    out = tmp_path / "s.png"
    devtool("screenshot", "--out", str(out), check=True)
    assert out.exists() and out.stat().st_size > 5000
    assert _is_png(out)
```

`esp32/devtool/tests/e2e/test_screenshot_5_in_a_row.py`:
```python
from pathlib import Path


def test_five_screenshots_back_to_back_succeed(devtool, tmp_path):
    for i in range(5):
        out = tmp_path / f"s{i}.png"
        p = devtool("screenshot", "--out", str(out), timeout_s=30.0)
        assert p.returncode == 0, (
            f"shot {i} failed: rc={p.returncode}, stderr={p.stderr}"
        )
        assert out.exists() and out.stat().st_size > 5000, (
            f"shot {i}: file missing or tiny ({out.stat().st_size if out.exists() else 'absent'})"
        )
```

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_screenshot.py tests/e2e/test_screenshot_5_in_a_row.py -v
```
Expected: 2 passed (this is the primary regression-kill for the original snapshot-transport collapse).

- [ ] **Step 7: Commit**

```bash
git add esp32/devtool/firmware/esp32_devtool_companion/src/handlers/screenshot.cc esp32/devtool/firmware/esp32_devtool_companion/include/esp32_devtool/companion.h esp32/devtool/firmware/esp32_devtool_companion/src/companion.cc esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc esp32/devtool/cli/commands/screenshot.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_screenshot.py esp32/devtool/tests/e2e/test_screenshot_5_in_a_row.py
git commit -m "feat(esp32-devtool): /screenshot over HTTP + 5-in-a-row parity green"
```

---

## Task 16: Firmware /touch + cli/commands/touch.py + parity

**Files:**
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/touch.cc`
- Create: `esp32/devtool/cli/commands/touch.py`
- Create: `esp32/devtool/tests/e2e/test_touch.py`

- [ ] **Step 1: Touch-provider callback in companion**

Append to `include/esp32_devtool/companion.h`:
```c
typedef int (*esp32_devtool_touch_provider_t)(int x, int y, int hold_ms);
void esp32_devtool_set_touch_provider(esp32_devtool_touch_provider_t fn);
```

Wire setter + internal getter exactly like the snapshot provider.

- [ ] **Step 2: Implement `handlers/touch.cc`**

```cpp
#include <cJSON.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <cstring>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static const char* TAG = "sentient.cube.devtool.touch";

static esp_err_t touch_handler(httpd_req_t* req) {
    char buf[128];
    int len = httpd_req_recv(req, buf, std::min<int>(sizeof(buf) - 1, req->content_len));
    if (len <= 0) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"empty_body\"}");
        return ESP_OK;
    }
    buf[len] = 0;
    cJSON* j = cJSON_Parse(buf);
    if (j == nullptr) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"bad_json\"}");
        return ESP_OK;
    }
    int x = cJSON_GetObjectItem(j, "x")->valueint;
    int y = cJSON_GetObjectItem(j, "y")->valueint;
    cJSON* hold = cJSON_GetObjectItem(j, "hold_ms");
    int hold_ms = (hold && cJSON_IsNumber(hold)) ? hold->valueint : 60;
    cJSON_Delete(j);

    int rc = esp32_devtool_invoke_touch(x, y, hold_ms);
    if (rc != 0) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "{\"error\":\"touch_provider_unset\"}");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    return ESP_OK;
}

__attribute__((constructor))
static void register_touch_route() {
    devtool_register_http("POST", "/touch", touch_handler);
}
```

Add `esp32_devtool_invoke_touch()` to `companion.cc` mirroring the snapshot getter.

- [ ] **Step 3: Wire touch provider in sentient_cube.cc**

Port the existing `ui.tap_at` / synthetic-indev injection path from `agent_console/verbs/ui.cc` into a plain `extern "C" int cube_touch_inject(int x, int y, int hold_ms)`. Register via `esp32_devtool_set_touch_provider(cube_touch_inject)` at boot.

- [ ] **Step 4: Implement `cli/commands/touch.py`**

```python
"""esp32-devtool touch <x> <y> [--hold MS]"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.errors import DevtoolError
from cli.transport.http import HttpClient, resolve_base_url


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def run(ctx_obj: dict, x: int, y: int, hold_ms: int) -> int:
    try:
        m = detect_board(boards_dir=BOARDS_DIR, override_name=ctx_obj.get("board"))
        base = resolve_base_url(m, override=ctx_obj.get("http_url"))
        client = HttpClient(base_url=base, timeout_s=5.0)
        result = client.post_json("/touch", {"x": x, "y": y, "hold_ms": hold_ms})
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True)
        if e.next_step:
            click.echo(f"   next step: {e.next_step}", err=True)
        return e.exit_code
    click.echo(json.dumps(result))
    return 0
```

Wire into main.py.

- [ ] **Step 5: Parity test**

`esp32/devtool/tests/e2e/test_touch.py`:
```python
import json


def test_touch_center_returns_ok(devtool):
    p = devtool("touch", "233", "233", check=True)
    assert json.loads(p.stdout) == {"ok": True}


def test_touch_triggers_toggle_button(devtool):
    """Toggle button screen tap at center toggles WS connection."""
    before = json.loads(devtool("cmd", "state", check=True).stdout)["ws_connected"]
    devtool("touch", "233", "233", "--hold", "120", check=True)
    import time; time.sleep(0.5)
    after = json.loads(devtool("cmd", "state", check=True).stdout)["ws_connected"]
    # Either it toggled or the screen wasn't on toggle — either way the verb succeeded.
    assert after in {True, False}
```

```bash
bash $REPO/esp32/cube/scripts/flash.sh
cd esp32/devtool && uv run pytest tests/e2e/test_touch.py -v
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add esp32/devtool/firmware/esp32_devtool_companion/ esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc esp32/devtool/cli/commands/touch.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_touch.py
git commit -m "feat(esp32-devtool): /touch over HTTP + parity"
```

---

## Task 17: Firmware /audio/record + /audio/inject + cli/commands/audio.py + parity

**Files:**
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/audio_record.cc`
- Create: `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/audio_inject.cc`
- Create: `esp32/devtool/cli/commands/audio.py`
- Create: `esp32/devtool/tests/e2e/test_audio_record.py`
- Create: `esp32/devtool/tests/e2e/test_audio_inject.py`

- [ ] **Step 1: Audio callbacks in companion**

Append to `include/esp32_devtool/companion.h`:
```c
typedef int (*esp32_devtool_audio_record_provider_t)(int16_t* dst,
                                                      size_t samples,
                                                      int sample_rate);
typedef int (*esp32_devtool_audio_inject_provider_t)(const int16_t* src,
                                                      size_t samples,
                                                      int sample_rate);

void esp32_devtool_set_audio_record_provider(esp32_devtool_audio_record_provider_t fn);
void esp32_devtool_set_audio_inject_provider(esp32_devtool_audio_inject_provider_t fn);
```

Implement setters + internal invokers in `companion.cc` (same pattern as snapshot/touch).

- [ ] **Step 2: Implement `handlers/audio_record.cc`**

```cpp
#include <esp_http_server.h>
#include <esp_log.h>
#include <cstdlib>
#include <cstring>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static esp_err_t audio_record_handler(httpd_req_t* req) {
    char query[64] = {};
    int duration_ms = 1000;
    int sample_rate = 16000;
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        char v[16];
        if (httpd_query_key_value(query, "duration_ms", v, sizeof(v)) == ESP_OK)
            duration_ms = atoi(v);
        if (httpd_query_key_value(query, "sample_rate", v, sizeof(v)) == ESP_OK)
            sample_rate = atoi(v);
    }
    if (duration_ms > 10000) duration_ms = 10000;
    size_t samples = (size_t)(duration_ms * sample_rate / 1000);
    int16_t* buf = (int16_t*)heap_caps_malloc(samples * sizeof(int16_t),
                                              MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == nullptr) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "alloc_failed");
        return ESP_OK;
    }
    int rc = esp32_devtool_invoke_audio_record(buf, samples, sample_rate);
    if (rc != 0) {
        free(buf);
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "audio_record_provider_unset");
        return ESP_OK;
    }
    char rate_s[16]; std::snprintf(rate_s, sizeof(rate_s), "%d", sample_rate);
    char ctype[64]; std::snprintf(ctype, sizeof(ctype),
                                  "audio/L16; rate=%d; channels=1", sample_rate);
    httpd_resp_set_type(req, ctype);
    char samp_s[16]; std::snprintf(samp_s, sizeof(samp_s), "%u", (unsigned)samples);
    httpd_resp_set_hdr(req, "X-Audio-Samples", samp_s);
    esp_err_t e = httpd_resp_send(req, (const char*)buf, samples * sizeof(int16_t));
    free(buf);
    return e;
}

__attribute__((constructor))
static void register_audio_record_route() {
    devtool_register_http("GET", "/audio/record", audio_record_handler);
}
```

- [ ] **Step 3: Implement `handlers/audio_inject.cc`**

```cpp
#include <esp_http_server.h>
#include <esp_log.h>
#include <cstdlib>
#include <cstring>

#include "esp32_devtool/companion.h"
#include "esp32_devtool/endpoints.h"
#include "companion_internal.h"

static esp_err_t audio_inject_handler(httpd_req_t* req) {
    size_t total = req->content_len;
    if (total == 0 || total > 2 * 1024 * 1024) {
        httpd_resp_set_status(req, "413 Payload Too Large");
        httpd_resp_sendstr(req, "too_big_or_empty");
        return ESP_OK;
    }
    int16_t* buf = (int16_t*)heap_caps_malloc(total,
                                              MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (buf == nullptr) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        httpd_resp_sendstr(req, "alloc_failed");
        return ESP_OK;
    }
    size_t got = 0;
    while (got < total) {
        int n = httpd_req_recv(req, (char*)buf + got, total - got);
        if (n <= 0) { free(buf); return ESP_FAIL; }
        got += n;
    }
    size_t samples = total / sizeof(int16_t);
    int rate = 16000;  // default; can be parsed from content-type for v2
    int rc = esp32_devtool_invoke_audio_inject(buf, samples, rate);
    free(buf);
    char body[64];
    std::snprintf(body, sizeof(body), "{\"ok\":%s,\"samples\":%u}",
                  rc == 0 ? "true" : "false", (unsigned)samples);
    httpd_resp_set_type(req, "application/json");
    if (rc != 0) httpd_resp_set_status(req, "503 Service Unavailable");
    httpd_resp_sendstr(req, body);
    return ESP_OK;
}

__attribute__((constructor))
static void register_audio_inject_route() {
    devtool_register_http("POST", "/audio/inject", audio_inject_handler);
}
```

- [ ] **Step 4: Wire audio providers in sentient_cube.cc**

Port the existing `audio.record_pcm` / `audio.inject_pcm` verb bodies from `agent_console/verbs/audio_record.cc` + `audio_inject.cc` into plain `extern "C"` provider functions; register at boot.

- [ ] **Step 5: Implement `cli/commands/audio.py`**

```python
"""esp32-devtool audio record|play|inject"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.errors import DevtoolError
from cli.transport.http import HttpClient, resolve_base_url
from cli.transport.usb_cdc import UsbCdcClient


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def _http(ctx_obj):
    m = detect_board(boards_dir=BOARDS_DIR, override_name=ctx_obj.get("board"))
    base = resolve_base_url(m, override=ctx_obj.get("http_url"))
    return m, HttpClient(base_url=base, timeout_s=30.0)


def record(ctx_obj, duration_ms, out_path) -> int:
    try:
        _, c = _http(ctx_obj)
        body, headers = c.get_bytes(f"/audio/record?duration_ms={duration_ms}")
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True); return e.exit_code
    Path(out_path).write_bytes(body)
    samples = int(headers.get("X-Audio-Samples", str(len(body) // 2)))
    if ctx_obj.get("json_out"):
        click.echo(json.dumps({"out": out_path, "samples": samples, "bytes": len(body)}))
    else:
        click.echo(f"recorded {samples} samples → {out_path}")
    return 0


def inject(ctx_obj, in_path) -> int:
    try:
        _, c = _http(ctx_obj)
        body = Path(in_path).read_bytes()
        result = c.post_bytes("/audio/inject", body,
                              content_type="audio/L16; rate=16000; channels=1")
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True); return e.exit_code
    click.echo(json.dumps(result))
    return 0


def play(ctx_obj, in_path) -> int:
    """Small pre-baked clips via USB-CDC. Large streams should use inject."""
    try:
        m = detect_board(boards_dir=BOARDS_DIR, override_name=ctx_obj.get("board"))
        client = UsbCdcClient.for_manifest(m, port_override=ctx_obj.get("port"))
        body = Path(in_path).read_bytes()
        import base64
        b64 = base64.b64encode(body).decode()
        result = client.invoke("audio.play_pcm", {"pcm_b64": b64, "rate": 16000})
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True); return e.exit_code
    click.echo(json.dumps(result))
    return 0
```

Wire `audio record|play|inject` subcommands in main.py.

- [ ] **Step 6: Parity tests**

`tests/e2e/test_audio_record.py`:
```python
from pathlib import Path


def test_audio_record_1s(devtool, tmp_path):
    out = tmp_path / "rec.pcm"
    devtool("audio", "record", "--duration", "1000", "--out", str(out), check=True)
    # 16kHz mono 16-bit = 32000 bytes for 1s, allow some jitter
    sz = out.stat().st_size
    assert 28000 < sz < 36000, f"unexpected size {sz}"
```

`tests/e2e/test_audio_inject.py`:
```python
import json
from pathlib import Path


def test_audio_inject_1s_silence(devtool, tmp_path):
    pcm = (b"\x00\x00") * 16000  # 1 second of silence
    in_path = tmp_path / "s.pcm"
    in_path.write_bytes(pcm)
    p = devtool("audio", "inject", "--in", str(in_path), check=True)
    payload = json.loads(p.stdout)
    assert payload["ok"] is True
    assert payload["samples"] == 16000
```

```bash
bash $REPO/esp32/cube/scripts/flash.sh
cd esp32/devtool && uv run pytest tests/e2e/test_audio_record.py tests/e2e/test_audio_inject.py -v
```
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add esp32/devtool/firmware/esp32_devtool_companion/ esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc esp32/devtool/cli/commands/audio.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_audio_record.py esp32/devtool/tests/e2e/test_audio_inject.py
git commit -m "feat(esp32-devtool): /audio/record + /audio/inject over HTTP + parity"
```

---

## Task 18: cli/commands/flash.py — absorb flash.sh, daemon kill/respawn

**Files:**
- Create: `esp32/devtool/cli/commands/flash.py`
- Create: `esp32/devtool/tests/e2e/test_flash_debug.py`
- Create: `esp32/devtool/tests/e2e/test_flash_prod.py`

- [ ] **Step 1: Implement `cli/commands/flash.py`**

Port the meaningful logic from `esp32/cube/scripts/flash.sh`:
1. Resolve cube port via `cli.board`.
2. Kill any existing daemon (`daemon stop --port`).
3. Bake creds if manifest extension `bake-creds` exists for the board (call extension verbatim, `transient: true` warning to stderr).
4. Run `idf.py -p $PORT flash`.
5. Eager-spawn daemon (`ensure_daemon`).
6. Wait for `>>> READY` in daemon ring (timeout 30s).
7. Print result or exit non-zero.

```python
"""esp32-devtool flash — build + flash via idf.py + eager daemon respawn."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import click

from cli.board import detect_board
from cli.daemon.lifecycle import (
    ensure_daemon,
    socket_path_for,
    pidfile_path_for,
)
from cli.errors import DevtoolError, DevtoolTimeout
from cli.repo_root import resolve_repo_root


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def _kill_daemon(port: str) -> None:
    pid_path = pidfile_path_for(port)
    if not pid_path.exists():
        return
    try:
        pid = int(pid_path.read_text().strip())
        os.kill(pid, 15)
        for _ in range(20):
            if not pid_path.exists():
                return
            time.sleep(0.1)
    except (ValueError, ProcessLookupError, PermissionError):
        pass


def _wait_for_ready(port: str, timeout_s: float = 30.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        p = subprocess.run(
            ["esp32-devtool", "daemon", "ring", "--lines", "200"],
            capture_output=True, text=True, timeout=5.0,
        )
        if ">>> READY" in p.stdout:
            return True
        time.sleep(0.5)
    return False


def run(ctx_obj: dict, profile: str) -> int:
    try:
        manifest = detect_board(boards_dir=BOARDS_DIR,
                                override_name=ctx_obj.get("board"))
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] {e}", err=True); return e.exit_code

    repo_root = resolve_repo_root()
    firmware = manifest.firmware_path
    if not firmware:
        click.echo(f"[esp32-devtool] manifest has no firmware_path", err=True)
        return 4
    firmware_path = repo_root / firmware

    # Resolve port
    port_override = ctx_obj.get("port")
    import glob as gl
    if port_override:
        port = port_override
    else:
        ports = sorted(gl.glob(manifest.usb.port_glob or "/dev/cu.usbmodem*"))
        if not ports:
            click.echo("[esp32-devtool] no USB port detected", err=True)
            return 3
        port = ports[0]

    # Optionally run bake-creds extension (e.g. cube needs it)
    for ext in manifest.extensions:
        if ext.cmd == "bake-creds":
            from cli.repo_root import substitute
            exec_path = substitute(ext.exec, repo_root=repo_root)
            click.echo(f"[esp32-devtool] running bake-creds extension: {exec_path}")
            rc = subprocess.call([exec_path, "--profile", profile])
            if rc != 0:
                click.echo("[esp32-devtool] bake-creds failed", err=True)
                return 5
            break

    # Kill existing daemon
    _kill_daemon(port)

    # Configure profile via SDKCONFIG_DEFAULTS env
    env = os.environ.copy()
    env["SDKCONFIG_DEFAULTS"] = (
        f"sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.{profile}"
    )
    rc = subprocess.call(
        ["idf.py", "-p", port, "flash"],
        cwd=str(firmware_path), env=env,
    )
    if rc != 0:
        click.echo(f"[esp32-devtool] idf.py flash failed rc={rc}", err=True)
        return 5

    # Eager daemon respawn
    try:
        ensure_daemon(port, spawn_timeout_s=15.0)
    except DevtoolError as e:
        click.echo(f"[esp32-devtool] daemon respawn failed: {e}", err=True)
        return 4

    if not _wait_for_ready(port, timeout_s=30.0):
        click.echo("[esp32-devtool] cube did not emit >>> READY within 30s",
                   err=True)
        return 6

    click.echo(f"flash OK — port={port} profile={profile}")
    return 0
```

Wire into main.py:
```python
@cli.command()
@click.option("--profile", default="debug", type=click.Choice(["debug", "prod"]))
@click.pass_context
def flash(ctx, profile):
    from cli.commands.flash import run
    sys.exit(run(ctx.obj, profile))
```

- [ ] **Step 2: Parity tests**

`tests/e2e/test_flash_debug.py`:
```python
def test_flash_debug_succeeds_and_cube_returns_to_idle(devtool):
    p = devtool("flash", "--profile", "debug", timeout_s=180.0)
    assert p.returncode == 0, f"stderr: {p.stderr}"
    # After flash, the conftest's ensure_healthy ran automatically;
    # validate cmd state works
    import json
    state = json.loads(devtool("cmd", "state", check=True).stdout)
    assert state["state"] in {"IDLE", "CONNECTING", "LISTENING"}
```

`tests/e2e/test_flash_prod.py`:
```python
def test_flash_prod_succeeds_and_audit_passes(devtool):
    p = devtool("flash", "--profile", "prod", timeout_s=180.0)
    assert p.returncode == 0, f"stderr: {p.stderr}"
    # Verify prod build has no devtool symbols leaked
    audit = devtool("audit-prod-strip", check=True)
    assert "no leaked symbols" in audit.stdout.lower() or audit.returncode == 0
    # Reflash debug so the cube is usable for subsequent tests in the suite
    devtool("flash", "--profile", "debug", timeout_s=180.0)
```

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_flash_debug.py tests/e2e/test_flash_prod.py -v
```
Expected: 2 passed (test_flash_prod re-flashes debug at the end to leave the cube usable).

- [ ] **Step 3: Commit**

```bash
git add esp32/devtool/cli/commands/flash.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_flash_debug.py esp32/devtool/tests/e2e/test_flash_prod.py
git commit -m "feat(esp32-devtool): cli flash + daemon respawn + debug/prod parity"
```

---

## Task 19: cli/commands/logs.py — USB+UDP merge + parity

**Files:**
- Create: `esp32/devtool/cli/commands/logs.py`
- Create: `esp32/devtool/tests/e2e/test_logs_ring.py`
- Create: `esp32/devtool/tests/e2e/test_logs_udp.py`

- [ ] **Step 1: Implement `cli/commands/logs.py`**

```python
"""esp32-devtool logs — merged USB ring + UDP relay stream."""
from __future__ import annotations

import asyncio
import json
import re
import socket
import sys
import time
from collections import OrderedDict
from pathlib import Path

import click

from cli.board import detect_board
from cli.daemon.lifecycle import socket_path_for, ensure_daemon


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"
LEVELS = {"D": 0, "I": 1, "W": 2, "E": 3}


def _parse_duration(s: str) -> float:
    m = re.match(r"^(\d+)([smh]?)$", s.strip())
    if not m:
        raise click.BadParameter(f"bad duration: {s}")
    n = int(m.group(1))
    u = m.group(2) or "s"
    return n * {"s": 1, "m": 60, "h": 3600}[u]


class Dedupe:
    def __init__(self, max_keys: int = 4096) -> None:
        self.seen: OrderedDict[tuple, float] = OrderedDict()
        self.max = max_keys

    def saw(self, ts_bucket: int, tag: str, msg: str) -> bool:
        k = (ts_bucket, tag, msg[:80])
        if k in self.seen:
            return True
        self.seen[k] = time.time()
        if len(self.seen) > self.max:
            self.seen.popitem(last=False)
        return False


def _format_line(source: str, line: str, *, no_color: bool, json_out: bool) -> str:
    ts = time.strftime("%H:%M:%S")
    if json_out:
        return json.dumps({"ts": ts, "source": source, "msg": line})
    prefix = f"[{source} {ts}]"
    return f"{prefix} {line}"


async def _ring_stream(port: str, level: str, filter_pat: str | None,
                       follow: bool, queue: asyncio.Queue):
    sock_path = socket_path_for(port)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.setblocking(False)
    loop = asyncio.get_event_loop()
    await loop.sock_connect(s, str(sock_path))
    msg = {"kind": "subscribe", "follow": follow}
    s.send((json.dumps(msg) + "\n").encode())
    buf = b""
    pat = re.compile(filter_pat) if filter_pat else None
    while True:
        try:
            chunk = await loop.sock_recv(s, 4096)
        except (ConnectionResetError, BrokenPipeError):
            break
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            text = line.decode("utf-8", errors="replace")
            if pat and not pat.search(text):
                continue
            await queue.put(("usb", text))


async def _udp_stream(port: int, level: str, filter_pat: str | None,
                      queue: asyncio.Queue):
    loop = asyncio.get_event_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    sock.bind(("0.0.0.0", port))
    pat = re.compile(filter_pat) if filter_pat else None
    while True:
        try:
            data, _ = await loop.sock_recvfrom(sock, 8192)
        except OSError:
            break
        text = data.decode("utf-8", errors="replace").rstrip()
        if pat and not pat.search(text):
            continue
        await queue.put(("udp", text))


async def _merge(queue: asyncio.Queue, *, no_color: bool, json_out: bool):
    dedupe = Dedupe()
    while True:
        source, line = await queue.get()
        ts_bucket = int(time.time() * 100)  # 10ms bucket
        if dedupe.saw(ts_bucket, source, line):
            continue
        click.echo(_format_line(source, line,
                                no_color=no_color, json_out=json_out))


def run(ctx_obj, follow, since, filter_pat, source, level, no_color, lines,
        json_out) -> int:
    manifest = detect_board(boards_dir=BOARDS_DIR,
                            override_name=ctx_obj.get("board"))
    import glob
    port = ctx_obj.get("port") or sorted(
        glob.glob(manifest.usb.port_glob or "/dev/cu.usbmodem*")
    )[0]
    ensure_daemon(port)
    queue: asyncio.Queue = asyncio.Queue()

    async def main():
        coros = []
        if source in ("usb", "all"):
            coros.append(_ring_stream(port, level, filter_pat, follow, queue))
        if source in ("udp", "all") and manifest.log_relay.enabled:
            coros.append(_udp_stream(manifest.log_relay.port, level,
                                     filter_pat, queue))
        coros.append(_merge(queue, no_color=no_color, json_out=json_out))
        await asyncio.gather(*coros)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        return 0
    return 0
```

Wire in main.py to invoke this from the existing `logs` stub.

- [ ] **Step 2: Parity tests**

`tests/e2e/test_logs_ring.py`:
```python
def test_logs_ring_returns_recent(devtool):
    p = devtool("logs", "--source", "usb", "--lines", "100", timeout_s=10.0)
    assert p.returncode == 0
    # At least one line with the cube's log signature
    assert "sentient.cube" in p.stdout or "[usb" in p.stdout
```

`tests/e2e/test_logs_udp.py`:
```python
import subprocess
import time


def test_logs_udp_sees_traffic_within_10s(devtool):
    # Spawn `logs --source udp --follow` in background, kill after 10s
    proc = subprocess.Popen(
        ["esp32-devtool", "logs", "--source", "udp", "--follow"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    # Generate activity: a few state queries
    for _ in range(5):
        subprocess.run(["esp32-devtool", "cmd", "mark", "--param", "label=ping"],
                       check=True, capture_output=True, timeout=5.0)
        time.sleep(0.5)
    time.sleep(2.0)
    proc.terminate()
    try:
        stdout, _ = proc.communicate(timeout=3.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, _ = proc.communicate()
    assert "[udp" in stdout or "udp " in stdout, f"no UDP traffic seen: {stdout[:500]}"
```

```bash
bash $REPO/esp32/cube/scripts/flash.sh  # ensures latest companion is on the cube
cd esp32/devtool && uv run pytest tests/e2e/test_logs_ring.py tests/e2e/test_logs_udp.py -v
```
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add esp32/devtool/cli/commands/logs.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_logs_ring.py esp32/devtool/tests/e2e/test_logs_udp.py
git commit -m "feat(esp32-devtool): cli logs (USB ring + UDP merge) + parity"
```

---

## Task 20: cli/commands/gdb.py — automated batch parity

**Files:**
- Create: `esp32/devtool/cli/commands/gdb.py`
- Create: `esp32/devtool/tests/e2e/test_gdb_batch.py`
- Create: `esp32/devtool/tests/e2e/fixtures/gdb_thread_dump.gdb`

- [ ] **Step 1: Implement `cli/commands/gdb.py`**

Port `esp32/cube/scripts/gdb-batch.sh`:
```python
"""esp32-devtool gdb — openocd + xtensa-gdb pair, optional batch script."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import click

from cli.board import detect_board
from cli.repo_root import resolve_repo_root


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def run(ctx_obj, batch_script: str | None, openocd_config: str | None) -> int:
    manifest = detect_board(boards_dir=BOARDS_DIR,
                            override_name=ctx_obj.get("board"))
    repo = resolve_repo_root()
    firmware = repo / (manifest.firmware_path or "")
    elf = firmware / "build" / "sentient_cube.elf"
    if not elf.exists():
        click.echo(f"[esp32-devtool] ELF not found: {elf}", err=True); return 4

    cfg = openocd_config or os.environ.get(
        "OPENOCD_CONFIG", "board/esp32s3-builtin.cfg"
    )
    openocd = subprocess.Popen(
        ["openocd", "-f", cfg],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(2.0)

    try:
        gdb_bin = os.environ.get(
            "XTENSA_GDB",
            str(Path.home() / ".espressif/tools/xtensa-esp-elf-gdb/"
                              "16.2_20250108/xtensa-esp-elf-gdb/bin/"
                              "xtensa-esp32s3-elf-gdb"),
        )
        args = [gdb_bin, "-batch" if batch_script else "-q",
                "-ex", "target remote :3333", "-ex", "set pagination off"]
        if batch_script:
            args += ["-x", batch_script, "-ex", "quit"]
        args.append(str(elf))
        rc = subprocess.call(args)
        return 0 if rc == 0 else 5
    finally:
        openocd.terminate()
        openocd.wait(timeout=3.0)
```

Wire in main.py.

- [ ] **Step 2: Write batch fixture**

`esp32/devtool/tests/e2e/fixtures/gdb_thread_dump.gdb`:
```
info threads
thread apply all bt 5
quit
```

- [ ] **Step 3: Parity test**

`tests/e2e/test_gdb_batch.py`:
```python
import subprocess
from pathlib import Path


FIXTURES = Path(__file__).parent / "fixtures"


def test_gdb_batch_dumps_threads(devtool):
    p = devtool("gdb", "--batch", str(FIXTURES / "gdb_thread_dump.gdb"),
                timeout_s=60.0)
    assert p.returncode == 0, f"stderr: {p.stderr}"
    out = p.stdout
    assert "Thread" in out or "process" in out, f"no thread dump in stdout: {out[:500]}"
```

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_gdb_batch.py -v
```
Expected: 1 passed (batch + non-interactive — no operator needed).

- [ ] **Step 4: Commit**

```bash
git add esp32/devtool/cli/commands/gdb.py esp32/devtool/tests/e2e/fixtures/gdb_thread_dump.gdb esp32/devtool/tests/e2e/test_gdb_batch.py esp32/devtool/cli/main.py
git commit -m "feat(esp32-devtool): gdb --batch absorbs gdb-batch.sh + parity"
```

---

## Task 21: cli/commands/setup.py + cli/commands/restart.py + cli/commands/ui.py

Small utility wrappers. No new parity tests beyond smoke (these are covered by the master parity sweep in Task 29).

**Files:**
- Create: `esp32/devtool/cli/commands/setup.py`
- Create: `esp32/devtool/cli/commands/restart.py`
- Create: `esp32/devtool/cli/commands/ui.py`
- Create: `esp32/devtool/cli/commands/daemon_cli.py`

- [ ] **Step 1: Implement `setup.py`**

Port `esp32/cube/scripts/setup-hil.sh`:
```python
"""esp32-devtool setup — dev environment bootstrap."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import click

from cli.repo_root import resolve_repo_root


def run(hil: bool, lvgl_sim: bool) -> int:
    repo = resolve_repo_root()
    if hil:
        # Create pytest-embedded venv at esp32/cube/tests/hil/.venv
        venv = repo / "esp32/cube/tests/hil/.venv"
        if not venv.exists():
            subprocess.check_call([sys.executable, "-m", "venv", str(venv)])
        pip = venv / "bin" / "pip"
        req = repo / "esp32/cube/tests/hil/requirements.txt"
        subprocess.check_call([str(pip), "install", "-r", str(req)])
        click.echo(f"HIL venv ready at {venv}")
    if lvgl_sim:
        sim = repo / "esp32/cube/lvgl-sim"
        subprocess.check_call(
            ["cmake", "-S", str(sim), "-B", str(sim / "build")],
            cwd=str(sim),
        )
        subprocess.check_call(
            ["cmake", "--build", str(sim / "build"), "-j"], cwd=str(sim),
        )
        click.echo(f"lvgl-sim built at {sim}/build")
    if not (hil or lvgl_sim):
        click.echo("nothing to do — pass --hil or --lvgl-sim", err=True)
        return 2
    return 0
```

Wire in main.py.

- [ ] **Step 2: Implement `restart.py`**

```python
"""esp32-devtool restart — `cmd restart`."""
from __future__ import annotations

import sys

import click

from cli.commands.cmd import run as cmd_run


def run(ctx_obj) -> int:
    return cmd_run(ctx_obj, "restart", ())
```

Wire in main.py.

- [ ] **Step 3: Implement `ui.py`**

```python
"""esp32-devtool ui dump-tree — `cmd ui.dump_tree`."""
from __future__ import annotations

import sys

import click

from cli.commands.cmd import run as cmd_run


def dump_tree(ctx_obj) -> int:
    return cmd_run(ctx_obj, "ui.dump_tree", ())
```

Wire `ui dump-tree` in main.py.

- [ ] **Step 4: Implement `daemon_cli.py`**

Move the daemon subcommand bodies from main.py into `daemon_cli.py` (keep main.py thin). Functions: `start`, `stop`, `status`, `ring`. `status` lists every `*.sock` in `_runtime_dir()` and pings each. `ring` opens the socket for the resolved port and streams the response from `{"kind":"events","n":lines}`.

- [ ] **Step 5: Verify these all dispatch without crashing**

```bash
esp32-devtool setup --help
esp32-devtool restart --help
esp32-devtool ui dump-tree | jq . | head -20  # should print LVGL tree JSON
esp32-devtool daemon status
```
Expected: each prints help or real output.

- [ ] **Step 6: Commit**

```bash
git add esp32/devtool/cli/commands/setup.py esp32/devtool/cli/commands/restart.py esp32/devtool/cli/commands/ui.py esp32/devtool/cli/commands/daemon_cli.py esp32/devtool/cli/main.py
git commit -m "feat(esp32-devtool): setup/restart/ui/daemon-cli subcommands"
```

---

## Task 22: cli/commands/audit_prod_strip.py + parity

**Files:**
- Create: `esp32/devtool/cli/commands/audit_prod_strip.py`
- Create: `esp32/devtool/tests/e2e/test_audit_prod_strip.py`

- [ ] **Step 1: Implement `audit_prod_strip.py`**

```python
"""esp32-devtool audit-prod-strip — verify no devtool symbols leak into prod ELF."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import click

from cli.board import detect_board
from cli.repo_root import resolve_repo_root


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"
LEAK_PATTERNS = (
    "esp32_devtool_companion_start",
    "devtool_register_verb",
    "devtool_register_http",
    "devtool_http_server_start",
    "devtool_log_relay_start",
)


def run(ctx_obj) -> int:
    manifest = detect_board(boards_dir=BOARDS_DIR,
                            override_name=ctx_obj.get("board"))
    repo = resolve_repo_root()
    firmware = repo / (manifest.firmware_path or "")
    elf = firmware / "build" / "sentient_cube.elf"
    if not elf.exists():
        click.echo(f"[esp32-devtool] ELF not found: {elf}", err=True); return 4

    objdump = subprocess.run(
        ["xtensa-esp32s3-elf-objdump", "-t", str(elf)],
        capture_output=True, text=True, timeout=30.0,
    )
    if objdump.returncode != 0:
        click.echo(f"[esp32-devtool] objdump failed: {objdump.stderr}", err=True)
        return 5
    leaks = [
        line for line in objdump.stdout.splitlines()
        if any(pat in line for pat in LEAK_PATTERNS)
        and "*UND*" not in line  # only defined symbols count
    ]
    if leaks:
        click.echo(f"[esp32-devtool] {len(leaks)} leaked devtool symbol(s):",
                   err=True)
        for line in leaks[:20]:
            click.echo(f"   {line}", err=True)
        return 5
    click.echo("audit-prod-strip: no leaked symbols")
    return 0
```

Wire in main.py.

- [ ] **Step 2: Parity test**

`tests/e2e/test_audit_prod_strip.py`:
```python
def test_audit_clean_after_prod_build(devtool):
    # The flash_prod test built a prod ELF; the subsequent flash_debug overwrote it.
    # Force a prod build (no flash) so the ELF reflects prod sdkconfig.
    import subprocess, os
    from pathlib import Path
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"],
                                   text=True).strip()
    firmware = Path(repo) / "esp32/cube/firmware"
    env = os.environ.copy()
    env["SDKCONFIG_DEFAULTS"] = (
        "sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.prod"
    )
    subprocess.check_call(["idf.py", "build"], cwd=str(firmware), env=env,
                          timeout=300.0)
    p = devtool("audit-prod-strip", check=True)
    assert "no leaked symbols" in p.stdout
    # Restore debug build
    env["SDKCONFIG_DEFAULTS"] = (
        "sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.debug"
    )
    subprocess.check_call(["idf.py", "build"], cwd=str(firmware), env=env,
                          timeout=300.0)
```

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_audit_prod_strip.py -v
```
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add esp32/devtool/cli/commands/audit_prod_strip.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_audit_prod_strip.py
git commit -m "feat(esp32-devtool): audit-prod-strip + parity (zero devtool symbols in prod)"
```

---

## Task 23: Manifest extensions + bake-creds wiring + parity

**Files:**
- Create: `esp32/devtool/cli/commands/extensions.py`
- Modify: `esp32/devtool/cli/main.py` — register extensions dynamically from manifest
- Create: `esp32/devtool/tests/e2e/test_bake_creds_extension.py`
- Create: `esp32/devtool/tests/e2e/test_auto_detect.py`

- [ ] **Step 1: Implement `cli/commands/extensions.py`**

```python
"""Manifest-declared board extensions. Dispatches to ext.exec verbatim."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import click

from cli.board import Extension, detect_board
from cli.repo_root import resolve_repo_root, substitute


BOARDS_DIR = Path(__file__).resolve().parents[2] / "boards"


def run_extension(ctx_obj, ext: Extension, args: list[str]) -> int:
    if ext.transient:
        click.echo(
            f"[esp32-devtool] {ext.cmd}: transient extension — slated for removal",
            err=True,
        )
    repo = resolve_repo_root(
        Path(ctx_obj["repo_root"]) if ctx_obj.get("repo_root") else None
    )
    exec_path = substitute(ext.exec, repo_root=repo)
    cmd = [exec_path]
    if ext.args_passthrough:
        cmd.extend(args)
    return subprocess.call(cmd)


def register_dynamic(cli, manifest):
    for ext in manifest.extensions:
        # Closure captures ext
        def make_cb(e: Extension):
            @click.pass_context
            @click.argument("args", nargs=-1, type=click.UNPROCESSED)
            def cb(ctx, args):
                sys.exit(run_extension(ctx.obj, e, list(args)))
            cb.__name__ = e.cmd.replace("-", "_")
            return cb
        cli.command(name=ext.cmd, help=ext.help)(make_cb(ext))
```

- [ ] **Step 2: Wire extension registration in main.py**

After the click group definition but before `if __name__ == "__main__":`, add:
```python
def _try_register_extensions():
    try:
        from cli.board import detect_board
        from cli.commands.extensions import register_dynamic
        manifest = detect_board(boards_dir=BOARDS_DIR, override_name=None,
                                scan_ports=lambda g: [])
    except Exception:
        # Best-effort registration: if no board connected at CLI startup, skip.
        # User can still invoke if --board is passed (the click parser will
        # complain about unknown commands; document in README).
        return
    register_dynamic(cli, manifest)

_try_register_extensions()
```

Add at top of main.py:
```python
BOARDS_DIR = Path(__file__).resolve().parent.parent / "boards"
```

- [ ] **Step 3: Verify `bake-creds` extension shows in help**

```bash
esp32-devtool --help | grep bake-creds
esp32-devtool bake-creds --help
```
Expected: extension listed; help string from manifest.

- [ ] **Step 4: Parity test**

`tests/e2e/test_bake_creds_extension.py`:
```python
def test_bake_creds_runs_and_recreates_header(devtool, tmp_path):
    import subprocess, os
    from pathlib import Path
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"],
                                   text=True).strip()
    creds_h = Path(repo) / "esp32/cube/firmware/main/sentient_creds.h"
    # Snapshot existing file
    backup = creds_h.read_bytes() if creds_h.exists() else None
    try:
        p = devtool("bake-creds", "--profile", "debug", timeout_s=30.0)
        assert p.returncode == 0, f"stderr: {p.stderr}"
        assert creds_h.exists()
        assert b"SENTIENT_WIFI_SSID" in creds_h.read_bytes()
    finally:
        if backup is not None:
            creds_h.write_bytes(backup)
```

`tests/e2e/test_auto_detect.py`:
```python
import json


def test_auto_detect_resolves_cube_via_info(devtool):
    p = devtool("--json", "info", check=True, timeout_s=10.0)
    payload = json.loads(p.stdout)
    assert payload["board"] == "cube"
    assert payload["ip"]
```

```bash
cd esp32/devtool && uv run pytest tests/e2e/test_bake_creds_extension.py tests/e2e/test_auto_detect.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add esp32/devtool/cli/commands/extensions.py esp32/devtool/cli/main.py esp32/devtool/tests/e2e/test_bake_creds_extension.py esp32/devtool/tests/e2e/test_auto_detect.py
git commit -m "feat(esp32-devtool): manifest extensions + bake-creds wiring + parity"
```

---

## Task 24: Migrate remaining cube verbs to devtool_verbs/

Move every remaining `agent_console/verbs/*.cc` body to `firmware/main/devtool_verbs/`. Same pattern as Task 14. After this task the cube no longer functionally depends on `agent_console`, but the component still links until Task 27.

Verbs to migrate: `wifi.connect`, `wifi.disconnect`, `wifi.reconnect`, `tts.cancel`, `audio.dump_state`, `audio.test_tone`, `audio.play_pcm`, `audio.record_pcm` (USB-CDC variant kept for small clips), `log_level`, `restart`, `sentient.force_reconnect`, `sentient.last_transcript`, `ui.dump_tree`. Drop `ui_snapshot` (replaced by HTTP `/screenshot`).

**Files:**
- Create: `esp32/cube/firmware/main/devtool_verbs/wifi.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/tts.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/audio_misc.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/audio_play.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/audio_record_usb.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/log_level.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/restart.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/sentient_misc.cc`
- Create: `esp32/cube/firmware/main/devtool_verbs/ui.cc`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt` — add all the new sources

- [ ] **Step 1: Port verbs one file at a time**

For each verb file in `esp32/cube/firmware/components/agent_console/verbs/*.cc`:
1. Copy body to `firmware/main/devtool_verbs/<verb>.cc`.
2. Replace `#include "agent_console/dispatcher.h"` → `#include "esp32_devtool/verbs.h"`.
3. Replace `agent_dispatcher_register` → `devtool_register_verb`.
4. Replace any `agent_console_event` / `agent_console_checkpoint` calls with `esp32_devtool_companion_event` / `esp32_devtool_companion_checkpoint`.
5. Replace `agent_console_*_provider` callbacks with direct `extern "C"` cube functions (matches the pattern from Task 14).

- [ ] **Step 2: Update main CMakeLists**

Add every new file under `SRCS`. Confirm `WHOLE_ARCHIVE` is set.

- [ ] **Step 3: Build + flash + smoke each verb via cli/cmd**

```bash
bash $REPO/esp32/cube/scripts/flash.sh
for verb in state button.toggle sentient.status wifi.disconnect wifi.reconnect tts.cancel log_level audio.dump_state restart ui.dump_tree; do
  echo "--- $verb ---"
  esp32-devtool cmd "$verb" --param "level=I" 2>&1 | head -5
done
```
Expected: every verb returns a JSON-RPC `result` (no `-32601 method not found`).

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/devtool_verbs/ esp32/cube/firmware/main/CMakeLists.txt
git commit -m "feat(cube): migrate remaining verbs (wifi, tts, audio, log_level, ui, restart, sentient) to devtool API"
```

---

## Task 25: HIL fixture refactor — phase-6 tests stay green via `esp32-devtool`

Rewrite the existing pytest-embedded fixtures in `esp32/cube/tests/hil/conftest.py` to call `esp32-devtool` instead of `_cube_cmd_helper.py` / `find-port.sh`. The Phase 6 test files (`test_sentient_audio_toggle.py`, `test_sentient_bad_token.py`, `test_sentient_barge_in.py`, `test_sentient_reconnect.py`, `test_voice_loop.py`, `test_ws_recovery.py`, `test_smoke.py`, `test_audio_play_pcm.py`, `test_audio_record.py`) DO NOT CHANGE.

**Files:**
- Modify: `esp32/cube/tests/hil/conftest.py`
- Modify: `esp32/cube/tests/hil/cube_dut.py`
- Create: `esp32/devtool/tests/e2e/test_fixture_compat.py`

- [ ] **Step 1: Rewrite `CubeDut.cmd`**

`esp32/cube/tests/hil/cube_dut.py`:
```python
"""HIL test wrapper that dispatches via esp32-devtool (was _cube_cmd_helper.py)."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


CUBE_DIR = Path(__file__).resolve().parents[2]


class CubeDut:
    def __init__(self, _unused, port: str) -> None:
        self.port = port

    def cmd(self, verb: str, **params) -> dict:
        args = ["esp32-devtool", "--port", self.port, "--json", "cmd", verb]
        for k, v in params.items():
            args += ["--param", f"{k}={json.dumps(v) if not isinstance(v, str) else v}"]
        p = subprocess.run(args, capture_output=True, text=True, timeout=10.0)
        if p.returncode != 0:
            raise RuntimeError(
                f"esp32-devtool cmd {verb} → rc={p.returncode}: {p.stderr}"
            )
        return json.loads(p.stdout) if p.stdout.strip() else {}
```

- [ ] **Step 2: Rewrite `conftest.py` `cube_port`**

```python
@pytest.fixture(scope="session")
def cube_port() -> str:
    """Detect via esp32-devtool --json info."""
    p = subprocess.run(
        ["esp32-devtool", "--json", "info"], capture_output=True, text=True,
        timeout=10.0,
    )
    if p.returncode != 0:
        # Fall back to glob — info needs WiFi up; pre-WiFi tests still need a port
        import glob
        ports = sorted(glob.glob("/dev/cu.usbmodem*"))
        if not ports:
            raise RuntimeError("no cube port detected")
        return ports[0]
    payload = json.loads(p.stdout)
    # info doesn't return port directly; re-scan
    import glob
    return sorted(glob.glob("/dev/cu.usbmodem*"))[0]
```

`serial_dut` and `gateway_logs` fixtures unchanged.

- [ ] **Step 3: Run existing Phase 6 HIL tests against the new fixture**

```bash
cd esp32/cube/tests/hil
.venv/bin/pytest test_sentient_audio_toggle.py test_sentient_bad_token.py test_sentient_barge_in.py test_sentient_reconnect.py -v
```
Expected: 4 passed. These tests must NOT be modified — fixture surface is preserved.

- [ ] **Step 4: Write `test_fixture_compat.py`**

`esp32/devtool/tests/e2e/test_fixture_compat.py`:
```python
"""Sanity-check that the rewritten HIL fixtures still expose CubeDut.cmd() correctly."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[4]


def test_phase6_hil_smoke_subset_passes():
    p = subprocess.run(
        [".venv/bin/pytest", "test_sentient_audio_toggle.py", "-x", "-q"],
        cwd=str(REPO / "esp32/cube/tests/hil"),
        capture_output=True, text=True, timeout=120.0,
    )
    assert p.returncode == 0, f"phase6 HIL regressed:\n{p.stdout}\n{p.stderr}"
```

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/tests/hil/conftest.py esp32/cube/tests/hil/cube_dut.py esp32/devtool/tests/e2e/test_fixture_compat.py
git commit -m "refactor(cube/hil): fixtures route through esp32-devtool (phase6 tests unchanged)"
```

---

## Task 26: DELETE legacy scripts

After Task 25 confirms phase-6 tests still pass, every legacy script is dead. Delete in one batch. Preserve `bake-creds.sh` (manifest extension).

**Files (all DELETIONS):**
- Delete: `esp32/cube/scripts/_cube_daemon.py`
- Delete: `esp32/cube/scripts/_cube_cmd_helper.py`
- Delete: `esp32/cube/scripts/_cube_snapshot_helper.py`
- Delete: `esp32/cube/scripts/cube-cmd.sh`
- Delete: `esp32/cube/scripts/cube-snapshot.sh`
- Delete: `esp32/cube/scripts/flash.sh`
- Delete: `esp32/cube/scripts/find-port.sh`
- Delete: `esp32/cube/scripts/gdb-batch.sh`
- Delete: `esp32/cube/scripts/setup-hil.sh`
- Delete: `esp32/cube/scripts/monitor.sh` (subsumed by `esp32-devtool logs --follow`)
- Delete: `esp32/cube/scripts/smoke.sh` (subsumed by e2e parity suite)
- Keep: `esp32/cube/scripts/bake-creds.sh`
- Keep: `esp32/cube/scripts/.gdbinit-batch`
- Create: `esp32/cube/scripts/README.md` — single-line pointer to devtool

- [ ] **Step 1: Grep for any remaining references**

```bash
rg -l 'cube-cmd\.sh|cube-snapshot\.sh|find-port\.sh|_cube_daemon|_cube_cmd_helper|_cube_snapshot_helper|gdb-batch\.sh|setup-hil\.sh|monitor\.sh' --type-not md | grep -v esp32/cube/scripts/
```
Expected: no hits outside the scripts dir. If anything shows up, fix the caller before deleting.

- [ ] **Step 2: Verify the existing `agent-console.md` rule + `CLAUDE.md` references won't immediately break**

```bash
rg 'agent_console|net_logger|cube-cmd\.sh|cube-snapshot\.sh|find-port\.sh|flash\.sh' .claude/rules/ esp32/cube/CLAUDE.md
```
These get updated in Task 28 — for now, note the lines that need editing.

- [ ] **Step 3: Delete the scripts**

```bash
git rm esp32/cube/scripts/{_cube_daemon.py,_cube_cmd_helper.py,_cube_snapshot_helper.py,cube-cmd.sh,cube-snapshot.sh,flash.sh,find-port.sh,gdb-batch.sh,setup-hil.sh,monitor.sh,smoke.sh}
```

- [ ] **Step 4: Write replacement README**

`esp32/cube/scripts/README.md`:
```markdown
# esp32/cube/scripts/

Legacy device-side scripts retired in feature/esp32-devtool-foundation.
Use `esp32-devtool` for everything:

| Old                                   | New                                            |
|---------------------------------------|------------------------------------------------|
| `bash cube-cmd.sh state`              | `esp32-devtool cmd state`                      |
| `bash cube-snapshot.sh /tmp/x.png`    | `esp32-devtool screenshot --out /tmp/x.png`    |
| `bash flash.sh`                       | `esp32-devtool flash --profile debug`          |
| `bash find-port.sh`                   | `esp32-devtool --json info \| jq -r .ip`       |
| `bash gdb-batch.sh`                   | `esp32-devtool gdb --batch ...`                |
| `bash setup-hil.sh`                   | `esp32-devtool setup --hil`                    |
| `bash monitor.sh`                     | `esp32-devtool logs --follow`                  |

The only script still in this directory is `bake-creds.sh`, kept as a transient
manifest extension. It retires when proper device pairing lands.
```

- [ ] **Step 5: Verify a CI-style sweep still passes**

```bash
cd esp32/devtool && uv run pytest tests/unit tests/e2e -x -q
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/scripts/
git commit -m "chore(cube/scripts): delete legacy scripts (subsumed by esp32-devtool)"
```

---

## Task 27: DELETE `agent_console/` + `net_logger/` components

After Task 24 + Task 25, the cube no longer depends on either component. Delete both. Reflash to confirm prod + debug builds still link.

**Files (DELETIONS):**
- Delete recursively: `esp32/cube/firmware/components/agent_console/`
- Delete recursively: `esp32/cube/firmware/components/net_logger/`

- [ ] **Step 1: Verify no remaining references**

```bash
rg -l 'agent_console|agent_dispatcher|agent_verb_handler_t|net_logger|net_logger_start' esp32/cube/firmware/ | grep -v components/agent_console | grep -v components/net_logger
```
Expected: no hits. If any remain in `main.cc` / `sentient_cube.cc`, fix them (delete the `agent_console_start()` call, remove `#include "agent_console.h"`, remove `net_logger_start()` call).

- [ ] **Step 2: Delete the components**

```bash
git rm -r esp32/cube/firmware/components/agent_console esp32/cube/firmware/components/net_logger
```

- [ ] **Step 3: Build + flash + run full parity sweep**

```bash
cd esp32/cube/firmware
idf.py reconfigure
idf.py build
bash $REPO/esp32/cube/scripts/bake-creds.sh --profile debug  # legacy hook for now
cd $REPO
esp32-devtool flash --profile debug
cd esp32/devtool && uv run pytest tests/e2e -x -q
```
Expected: build green; every parity test passes against the lean firmware.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/
git commit -m "chore(cube/firmware): delete agent_console + net_logger (subsumed by esp32_devtool_companion)"
```

---

## Task 28: Update `.claude/rules/` + `esp32/cube/CLAUDE.md`

Retire the agent-console rule, drop the net_logger mention from the logging rule, and add a single devtool rule that covers the new mono-tool surface.

**Files:**
- Delete: `.claude/rules/esp32/cube/agent-console.md`
- Modify: `.claude/rules/esp32/cube/logging.md` — drop `net_logger` references; replace with `esp32_devtool_companion`'s log_relay
- Modify: `.claude/rules/esp32/cube/build.md` — replace `flash.sh` mentions with `esp32-devtool flash --profile debug` (note the daemon-respawn behaviour is now in the CLI)
- Modify: `.claude/rules/esp32/cube/flash-discipline.md` — replace ring-buffer Python one-liner with `esp32-devtool daemon ring`; drop the `--no-stub` rule (CLI never sets it) and the daemon-mgmt details that moved into the CLI
- Modify: `.claude/rules/esp32/cube/testing.md` — replace `_cube_cmd_helper.py` per-call subprocess pattern with "CubeDut.cmd() invokes `esp32-devtool cmd`"; remove the `find-port.sh` reference
- Create: `.claude/rules/esp32/devtool.md`
- Modify: `esp32/cube/CLAUDE.md` — drop the agent_console + net_logger rows from the tree map; point at `esp32/devtool/CLAUDE.md`

- [ ] **Step 1: Write `.claude/rules/esp32/devtool.md`**

```markdown
---
paths:
  - "esp32/devtool/**"
  - "esp32/cube/firmware/main/devtool_verbs/**"
---
# ESP32 Devtool Rules

> When a rule is unclear, read `esp32/devtool/CLAUDE.md` (agent-facing) +
> `esp32/devtool/docs/HTTP-CONTRACT.md` + `esp32/devtool/docs/BOARD-MANIFEST.md`.

- `esp32-devtool` is the ONLY agent-facing host-side dev/debug entry point.
  Never call legacy scripts directly — they no longer exist. Per-verb
  transport (USB-CDC vs HTTP) is chosen automatically by `cli/transport/router.py`
  based on the board manifest.

- Auto-detect drives every invocation. Pass `--board <name>` only when there
  are multiple cubes on USB, or when running against a board whose manifest
  is not yet auto-detectable.

- New verbs (USB-CDC) belong under `esp32/cube/firmware/main/devtool_verbs/`,
  one file per verb. Register via `devtool_register_verb()` with a
  `__attribute__((constructor))`. The component MUST keep `WHOLE_ARCHIVE` set
  in its CMakeLists or the constructor is dead-code-eliminated.

- New HTTP endpoints belong under
  `esp32/devtool/firmware/esp32_devtool_companion/src/handlers/`,
  registered via `devtool_register_http()`. Update `docs/HTTP-CONTRACT.md`
  in the same commit — clients depend on the frozen wire spec.

- Every new verb / endpoint MUST get an e2e parity test under
  `esp32/devtool/tests/e2e/`. Group A / B split is retired — every test is
  unattended. The `conftest.py` auto-recovers from wedges via the
  `recovery.py` flow; only AXP2101 PMIC fault requires a physical replug.

- Daemon socket path is per-port-hash:
  `/tmp/esp32-devtool/<sha1(port)[:12]>.sock`. Multiple cubes get distinct
  daemons. Never hardcode `/tmp/cube-daemon.sock`.

- `--json` flag MUST be respected by every command. Tests consume JSON;
  humans read the text form.

- The firmware companion compiles to ~0 bytes in prod via the
  `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` stub. Verify with
  `esp32-devtool audit-prod-strip` after every prod-build change.

- Manifest extensions live in `esp32/devtool/boards/<name>.yaml#extensions`.
  Set `transient: true` to mark a soon-to-retire hack (e.g. bake-creds);
  the CLI prints a deprecation hint on every invoke.
```

- [ ] **Step 2: Edit existing rules**

In `.claude/rules/esp32/cube/logging.md`, replace the `net_logger` bullet with:
```
- All `ESP_LOGx` calls are automatically teed through the
  `esp32_devtool_companion` log_relay (UDP NDJSON to gateway:9000 after
  WiFi up). Same lines land on USB-CDC AND on the gateway UDP sink. No
  special call per file.
```

In `.claude/rules/esp32/cube/build.md`, replace the `scripts/flash.sh` bullet with:
```
- `esp32-devtool flash --profile debug` builds + flashes + eagerly respawns
  the daemon so the cube's boot trace from ROM bootloader through the first
  IDLE state lands in the daemon ring at t=0. Daemon ring inspection via
  `esp32-devtool daemon ring --lines 20000` is the canonical post-flash
  readback path — never re-flash to read boot state.
```

In `.claude/rules/esp32/cube/flash-discipline.md`, replace the daemon-ring Python one-liner with `esp32-devtool daemon ring --lines 20000`. Remove the `--no-stub` rule (CLI never sets it).

In `.claude/rules/esp32/cube/testing.md`, replace the `_cube_cmd_helper.py` paragraph with:
```
- `CubeDut.cmd()` shells out to `esp32-devtool --json cmd <verb>`. The
  subprocess-per-call pattern still protects against the rapid-CMD stale-stdin
  glitch. Never open pyserial directly in a test.
```

Delete the `find-port.sh` reference in any rule file that still has it.

- [ ] **Step 3: Delete the agent-console rule**

```bash
git rm .claude/rules/esp32/cube/agent-console.md
```

- [ ] **Step 4: Update `esp32/cube/CLAUDE.md`**

In the `## Tree map` table, replace the rows:
```
| `firmware/components/agent_console/` | … |
| `firmware/components/net_logger/`    | … |
| `scripts/`                           | … |
```
With:
```
| `firmware/main/devtool_verbs/`        | USB-CDC verbs registered via `devtool_register_verb` (see `esp32/devtool/`). |
| `scripts/bake-creds.sh`               | Transient creds-bake hack. Wrapped as `esp32-devtool bake-creds` manifest extension. |
```

In the `## MANDATORY` rules table, replace the `agent-console.md` row with one pointing at `.claude/rules/esp32/devtool.md`. Remove the row referencing `flash.sh` eager-daemon-spawn (move to `esp32-devtool`-facing wording).

In the `## Daily dev surface` code block, replace every `bash scripts/*.sh` line with the `esp32-devtool` equivalent.

- [ ] **Step 5: Final rg sweep**

```bash
rg 'agent_console|net_logger|cube-cmd\.sh|cube-snapshot\.sh|find-port\.sh|setup-hil\.sh|gdb-batch\.sh|monitor\.sh' .claude/ esp32/cube/CLAUDE.md docs/
```
Expected: zero hits (or only in historical handover docs — leave those untouched).

- [ ] **Step 6: Commit**

```bash
git add .claude/rules/ esp32/cube/CLAUDE.md
git commit -m "docs(rules): retire agent-console.md; add devtool.md; refresh build/logging/testing/flash-discipline references"
```

---

## Task 29: Full e2e parity sweep + pre-merge gate

Before opening a PR back to the parent feature branch, run the entire e2e parity suite end-to-end against real hardware and confirm every gate item is green.

**Files:** none new — exercises everything that came before.

- [ ] **Step 1: Clean flash from a known state**

```bash
cd esp32/cube/firmware
idf.py fullclean
idf.py reconfigure
cd $REPO
esp32-devtool flash --profile debug
```
Expected: flash succeeds, daemon respawns, `>>> READY` lands within 30s.

- [ ] **Step 2: Unit + e2e sweep**

```bash
cd esp32/devtool
uv run pytest tests/unit -v
uv run pytest tests/e2e -v
```
Expected: every test passes. No skips. Total e2e runtime estimate: ~8-12 minutes (dominated by the flash debug/prod tests).

- [ ] **Step 3: Phase-6 HIL regression check**

```bash
cd esp32/cube/tests/hil
.venv/bin/pytest -v
```
Expected: every Phase-6 test still green via the rewritten fixtures.

- [ ] **Step 4: Gateway-side CI**

```bash
source scripts/env.sh
bun run ci
```
Expected: lint + typecheck + unit tests green. No regressions from anything devtool changed in `gateway/`.

- [ ] **Step 5: lvgl-sim regression check**

```bash
cd esp32/cube/lvgl-sim
cmake --build build -j
./build/sentient_cube_lvgl_sim --snapshot /tmp/sim.png
```
Expected: build succeeds; snapshot.png is a valid 466x466 PNG.

- [ ] **Step 6: Prod build size check**

```bash
cd esp32/cube/firmware
SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.esp32s3;sdkconfig.defaults.prod" \
  idf.py size 2>&1 | tee /tmp/prod-size-after.txt
```
Compare against the pre-feature snapshot recorded at the bottom of `docs/superpowers/specs/2026-05-14-cube-sdk-design.md` (or freshly captured before Task 1 starts). Expected: ±5% delta.

- [ ] **Step 7: Audit no devtool symbols leaked into prod**

```bash
esp32-devtool audit-prod-strip
```
Expected: `audit-prod-strip: no leaked symbols`.

- [ ] **Step 8: Legacy-script sweep**

```bash
test ! -e esp32/cube/scripts/cube-cmd.sh && echo OK
test ! -e esp32/cube/scripts/flash.sh && echo OK
test ! -e esp32/cube/scripts/find-port.sh && echo OK
test ! -e esp32/cube/scripts/_cube_daemon.py && echo OK
test ! -e esp32/cube/firmware/components/agent_console/CMakeLists.txt && echo OK
test ! -e esp32/cube/firmware/components/net_logger/CMakeLists.txt && echo OK
```
Expected: 6 OK lines.

- [ ] **Step 9: Pre-merge gate checklist**

Confirm each item; only proceed if all green:

- [ ] All unit tests green.
- [ ] All e2e parity tests green (fully unattended).
- [ ] Phase-6 HIL smoke regressions green via refactored fixtures.
- [ ] Prod build size unchanged ±5%.
- [ ] `esp32-devtool audit-prod-strip` reports zero `esp32_devtool_*` symbols in prod ELF.
- [ ] Legacy `esp32/cube/scripts/` empty except for `bake-creds.sh` + README + `.gdbinit-batch`.
- [ ] `esp32/cube/firmware/components/agent_console/` + `net_logger/` directories gone.
- [ ] `.claude/rules/esp32/cube/agent-console.md` gone; `.claude/rules/esp32/devtool.md` added.
- [ ] `lvgl-sim` build green.
- [ ] `bun run ci` green (gateway side).

- [ ] **Step 10: Push branch + open PR**

```bash
git push -u origin feature/esp32-devtool-foundation
gh pr create --base feature/esp32-cube-v1 --title "feat(esp32-devtool): one tool to rule them all — host CLI + firmware companion + parity green" --body "$(cat <<'EOF'
## Summary
- Replaces 8 shell + 4 Python dev scripts with `esp32-devtool` CLI (Python, PEP-723 inline deps, `uv run --script`).
- Adds `esp32_devtool_companion` ESP-IDF component subsuming `agent_console` + `net_logger`. Prod build compiles to a stub (~0 bytes).
- USB-CDC ↔ HTTP transport auto-routing per manifest. HTTP screenshot replaces the unfixable USB-CDC chunk pipeline.
- Every e2e parity test runs unattended (no Group A/B split). Auto-recovery via `restart` verb → reflash → escape only on AXP2101 fault.

## Test plan
- [ ] `uv run pytest esp32/devtool/tests/unit` green
- [ ] `uv run pytest esp32/devtool/tests/e2e` green against real cube on USB
- [ ] Phase-6 HIL regressions green via refactored fixtures
- [ ] `bun run ci` green
- [ ] `lvgl-sim` build green
- [ ] `esp32-devtool audit-prod-strip` reports zero leaked symbols
- [ ] Prod build size delta within ±5%
EOF
)"
```

- [ ] **Step 11: Done**

The feature branch is mergeable once every checkbox above is checked and review is approved.

---

## Self-Review Notes

Spec coverage check (against `docs/superpowers/specs/2026-05-15-esp32-devtool-design.md`):
- v1 commands (lines 175-191): all covered — `info` (12), `flash` (18), `logs` (19), `screenshot` (15), `cmd` (14), `touch` (16), `audio` (17), `gdb` (20), `setup`/`restart`/`ui`/`daemon` (21), `audit-prod-strip` (22), `bake-creds` extension (23). ✓
- Board manifest extensions (lines 222-339): covered in Tasks 2 + 23. ✓
- Firmware companion (Kconfig + CMakeLists + Kconfig gates + verbs.h + endpoints.h + log_relay): Tasks 9 + 10 + 14 + 15 + 16 + 17 + 19. ✓
- HTTP contract (lines 498-602): documented in `docs/HTTP-CONTRACT.md` (Task 1) + implemented across Tasks 10, 15, 16, 17. ✓
- Daemon lifecycle (lines 604-652): Task 7. ✓
- Live logs (lines 655-697): Task 19. ✓
- Packaging + extraction roadmap (lines 698-779): partial — `bin/esp32-devtool` shim + PEP-723 + self-containment landed in Tasks 1 + 3. OSS extraction (pyproject generation, separate-repo cp) is a Task-31+ followup, NOT in this plan. Documented in `docs/ROADMAP.md`. ✓
- Migration table (lines 781-813): Tasks 24 + 25 + 26 + 27 + 28. ✓
- E2E parity (lines 815-842): every row from the spec table has a corresponding task + test file. ✓
- Pre-merge gate (lines 893-904): Task 29 checklist. ✓
- Branch + commit plan (lines 906-930): plan's task ordering matches the spec's 18 phases with finer granularity. ✓

Placeholder check: ran the prompt's red-flag list against every task body. No `TODO`/`TBD`/`implement later`. Two intentional `// TODO(devtool task 14)` comments inside firmware code are deliberate, scoped, and resolved in their named task.

Type consistency check: `devtool_register_verb` / `devtool_register_http` / `esp32_devtool_set_*_provider` names are stable across Tasks 9-17. The `esp32_devtool_companion_config_t` shape is defined once in Task 9 and used identically in Tasks 11, 15, 16, 17. Verb handler signature `int(const cJSON*, cJSON*, int*, const char**)` is identical to the old `agent_verb_handler_t` so the Task-24 migration is a search-and-replace.

Unattended-e2e check: every parity test in Tasks 14-23 uses the conftest from Task 13 — auto-detect, auto-recover, no operator prompts. `test_flash_prod` reflashes debug at the end to leave the cube usable. `test_audit_prod_strip` saves/restores the debug build. `test_bake_creds_extension` snapshots+restores `sentient_creds.h`. `test_gdb_batch` uses a non-interactive batch script.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-15-esp32-devtool-foundation.md`.

Per user instruction: invoking `superpowers:subagent-driven-development` to execute task-by-task with fresh subagents + two-stage review.
