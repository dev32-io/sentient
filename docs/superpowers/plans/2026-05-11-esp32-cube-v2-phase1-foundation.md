# ESP32 Cube v2 — Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `esp32/cube/firmware/` — a flat, owned firmware tree replacing the v1 xiaozhi-submodule + overlay + numbered-patches pattern. End with a boot-clean cube that responds to `cube-cmd state` and ships UDP logs. No hardware features yet beyond boot.

**Architecture:** Branch is off `develop` — there is no cube tree here yet. We do two imports: (a) cube infrastructure (scripts / tests / docs / rules) from the `esp32-cube-v1-overlay-archive` tag we create, (b) xiaozhi sources from a fresh /tmp clone of `78/xiaozhi-esp32` at SHA `b72945a`. We then trim ~80K LOC of unwanted xiaozhi (32 boards, OTA, MCP, MQTT, wake words, demuxer) and inline the v1 overlay code (agent_console, net_logger, sentient board class) as native components. Patches 0001 + 0002 become unnecessary (no derivation = no vtable problem); patches 0003 + 0004 land as direct edits.

**Tech Stack:** ESP-IDF 5.5.2 · Xtensa GCC · LVGL 9.5 · FreeRTOS · pytest-embedded · pyserial · bun (repo-wide tooling) · cube-daemon (Unix-socket serial holder).

**Spec:** `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md`

**Branch:** `feature/esp32-cube-v2-rescope` (this worktree, branched off develop)

**Flash discipline:** `.claude/rules/esp32/cube/flash-discipline.md` — target ≤ 3 flashes this phase, ≤ 5 stretch limit. AXP2101 fault triggers physical recovery; do not paper over.

---

## Prerequisites

Run once before Task 1:

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
source scripts/env.sh
```

Verify cube hardware accessible:

```bash
ls /dev/cu.usbmodem101  # cube CDC port should exist
```

If cube is wedged (boot-loop, AXP2101 fault, or unresponsive), recover before starting Task 23:

1. Unplug USB
2. Hold BOOT button on cube
3. Plug USB while holding BOOT
4. Release BOOT after ~2s — cube is in download mode, ready for flash.

---

## Starting State

The worktree at `feature/esp32-cube-v2-rescope` is branched off `develop`. The branch contains the v2 spec + flash-discipline rule cherry-picked from v1, but **no cube source files**:

- `esp32/cube/` does not exist yet.
- `.claude/rules/esp32/cube/flash-discipline.md` exists; the other v1 cube rules (build.md, agent-console.md, logging.md, testing.md) do not.
- v1's overlay code (agent_console, net_logger, sentient board files) lives on `feature/esp32-cube-v1` at commit `8db3a9c` — accessed via the archive tag we create in Task 1.

---

## Final File Structure (after Phase 1 completes)

```
esp32/cube/
├── .e2e-testing                  # wifi + sentient creds (gitignored, user provides)
├── .gitignore                    # imported from v1
├── .venv/                        # pytest-embedded virtualenv (user re-creates)
├── scripts/                      # imported from v1: cube-cmd.sh, daemon, bake-creds
├── tests/                        # imported from v1: pytest-embedded harness, retargeted
├── docs/                         # imported from v1
├── firmware/                     # NEW (created in this phase)
│   ├── CMakeLists.txt
│   ├── sdkconfig.defaults
│   ├── partitions.csv
│   ├── main/
│   │   ├── CMakeLists.txt
│   │   ├── Kconfig.projbuild     # trimmed
│   │   ├── application.{cc,h}    # OTA/MCP/MQTT/wake-word stripped
│   │   ├── main.cc
│   │   ├── device_state_machine.{cc,h}
│   │   ├── settings.{cc,h}
│   │   ├── sentient_creds.h      # gitignored, baked
│   │   ├── system_info.{cc,h}
│   │   ├── assets.{cc,h}
│   │   ├── audio/
│   │   │   ├── audio_service.{cc,h}  # power-save USB monitor + inject hook inlined
│   │   │   ├── codecs/               # Opus encode/decode
│   │   │   └── processors/           # AEC
│   │   ├── display/                  # LVGL panel setup
│   │   ├── assets/                   # asset binaries
│   │   ├── protocols/
│   │   │   └── websocket_protocol.{cc,h}
│   │   └── boards/
│   │       ├── common/               # AXP2101, backlight, codec base
│   │       └── sentient-cube/
│   │           ├── CMakeLists.txt
│   │           ├── config.h
│   │           ├── config.json
│   │           ├── sentient_cube.cc           # waveshare AMOLED 2.16 + sentient overlay, merged
│   │           ├── sentient_ui_controller.cc
│   │           └── toggle_button_screen.cc
│   └── components/
│       ├── agent_console/            # ported from v1 sentient/components/
│       │   ├── CMakeLists.txt
│       │   ├── agent_console.{cc,h}
│       │   ├── dispatcher.{cc,h}
│       │   └── verbs/
│       │       ├── audio.cc          # inject_pcm + tts.cancel
│       │       ├── button.cc
│       │       ├── log_level.cc
│       │       ├── mark.cc
│       │       ├── restart.cc
│       │       ├── state.cc
│       │       ├── ui.cc
│       │       ├── ui_snapshot.cc
│       │       ├── wifi.cc
│       │       └── ws.cc
│       └── net_logger/               # ported from v1 sentient/components/
│           ├── CMakeLists.txt
│           └── net_logger.{cc,h}
```

Imported from v1 archive but never present in the worktree by default:
- `.claude/rules/esp32/cube/{build,agent-console,logging,testing}.md`
- `agents/docs/esp32/cube/{build,agent-console,logging,testing}-details.md`

(`flash-discipline.md` and `flash-discipline-details.md` already exist on this branch.)

---

## Task 1: Create v1 archive tag

**Why:** Marks v1's HEAD so we can checkout files from it. Tag is the stable handle we use throughout Tasks 2 + 11.

**Files:** none (annotated tag only)

- [ ] **Step 1: Verify v1 branch exists with expected HEAD**

```bash
git rev-parse feature/esp32-cube-v1
```

Expected: `8db3a9c<...>` (the v1 HEAD with PSRAM rx buffer commit).

- [ ] **Step 2: Create annotated tag**

```bash
git tag -a esp32-cube-v1-overlay-archive feature/esp32-cube-v1 -m "Archive: v1 overlay + submodule + numbered patches before v2 rescope"
```

- [ ] **Step 3: Verify tag**

```bash
git show esp32-cube-v1-overlay-archive --stat | head -5
```

Expected: shows commit `fix(esp32-cube/agent_console): PSRAM-backed 64KB rx buffer + daemon big-payload recv`.

- [ ] **Step 4: Push tag**

```bash
git push origin esp32-cube-v1-overlay-archive
```

Expected: `* [new tag] esp32-cube-v1-overlay-archive -> esp32-cube-v1-overlay-archive`.

(No commit — tags don't appear in branch history.)

---

## Task 2: Import v1 cube infrastructure (scripts + tests + docs + rules)

**Why:** The worktree has no cube tree at all. Before we start the rescope, we bring forward the things that are not changing — scripts (cube-cmd, daemon, bake-creds), tests (pytest-embedded harness), docs, and the four legacy cube rules (build, agent-console, logging, testing). The overlay code itself (sentient/) gets imported later, in Task 11.

**Files:**
- Create: `esp32/cube/scripts/` (all v1 scripts)
- Create: `esp32/cube/tests/` (pytest-embedded harness, will be retargeted in Task 22)
- Create: `esp32/cube/docs/` (READMEs, JTAG script)
- Create: `esp32/cube/.gitignore`
- Create: `esp32/cube/.e2e-testing.example` (if present in v1; user owns the real `.e2e-testing`)
- Create: `.claude/rules/esp32/cube/{build,agent-console,logging,testing}.md`
- Create: `agents/docs/esp32/cube/{build,agent-console,logging,testing}-details.md`

- [ ] **Step 1: Restore esp32/cube/scripts/ from archive**

```bash
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/scripts
git status -sb | head -20
```

Expected: lots of `A esp32/cube/scripts/<file>` lines.

- [ ] **Step 2: Restore esp32/cube/tests/**

```bash
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/tests
```

- [ ] **Step 3: Restore esp32/cube/docs/**

```bash
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/docs
```

- [ ] **Step 4: Restore esp32/cube/.gitignore**

```bash
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/.gitignore
```

- [ ] **Step 5: Restore the legacy cube rules + details**

```bash
git checkout esp32-cube-v1-overlay-archive -- .claude/rules/esp32/cube/build.md
git checkout esp32-cube-v1-overlay-archive -- .claude/rules/esp32/cube/agent-console.md
git checkout esp32-cube-v1-overlay-archive -- .claude/rules/esp32/cube/logging.md
git checkout esp32-cube-v1-overlay-archive -- .claude/rules/esp32/cube/testing.md
git checkout esp32-cube-v1-overlay-archive -- agents/docs/esp32/cube/build-details.md
git checkout esp32-cube-v1-overlay-archive -- agents/docs/esp32/cube/agent-console-details.md
git checkout esp32-cube-v1-overlay-archive -- agents/docs/esp32/cube/logging-details.md
git checkout esp32-cube-v1-overlay-archive -- agents/docs/esp32/cube/testing-details.md
```

- [ ] **Step 6: Update `.claude/rules/esp32/cube/build.md` for v2 reality**

The v1 build.md describes `build.sh` + submodule + patches. v2 has none of those. Edit the file to remove every line that references:
- the upstream submodule
- patches/ directory
- `build.sh` script (will be deleted in Task 4)
- symlinking
- `MINIMAL_BUILD` or patch-application flow

Keep the lines that still apply (e.g. WHOLE_ARCHIVE for verb registration, sdkconfig.defaults guidance). Frontmatter `paths:` block should be updated from `esp32/cube/sentient/**` + `esp32/cube/scripts/**` to:

```yaml
---
paths:
  - "esp32/cube/firmware/**"
  - "esp32/cube/scripts/**"
---
```

Rewrite the body to describe the flat tree. Keep it under 100 lines per `.claude/rules/feedback_rules_style.md`.

- [ ] **Step 7: Update `agent-console.md` + `logging.md` + `testing.md` rule paths**

Each of these has a `paths:` frontmatter block. Update from `esp32/cube/sentient/**` to `esp32/cube/firmware/**` (or whichever sub-path the rule covers).

If a rule body specifically references `esp32/cube/sentient/components/agent_console/`, replace with `esp32/cube/firmware/components/agent_console/`. Otherwise leave content untouched.

- [ ] **Step 8: Delete v1's `build.sh` if it landed under scripts/**

```bash
[ -f esp32/cube/scripts/build.sh ] && git rm esp32/cube/scripts/build.sh
```

`build.sh` was the patch-application driver — useless in v2. We use `idf.py` directly from `firmware/`.

- [ ] **Step 9: Confirm `.e2e-testing` is gitignored**

```bash
grep -E "(^|/)\.e2e-testing(/|$)" esp32/cube/.gitignore
```

Expected: matches a line like `.e2e-testing` or `/.e2e-testing`.

If not present, append:

```bash
echo ".e2e-testing" >> esp32/cube/.gitignore
```

User is responsible for the actual `esp32/cube/.e2e-testing` file (WiFi creds + sentient backend URL). Copy the user's existing one back into place after this commit; the file is not in the worktree.

- [ ] **Step 10: Commit infrastructure import**

```bash
git add esp32/cube/scripts esp32/cube/tests esp32/cube/docs esp32/cube/.gitignore .claude/rules/esp32/cube agents/docs/esp32/cube
git commit -m "$(cat <<'EOF'
chore(esp32-cube): import v1 cube infrastructure (rescope step 1/N)

Pulls forward from esp32-cube-v1-overlay-archive tag:
- scripts/   (cube-cmd.sh, _cube_daemon.py, _cube_cmd_helper.py, bake-creds.sh, JTAG helpers)
- tests/     (pytest-embedded harness — retargeted at firmware/build/ in later step)
- docs/      (READMEs)
- .gitignore (.e2e-testing pattern, build artifacts)
- .claude/rules/esp32/cube/{build,agent-console,logging,testing}.md
- agents/docs/esp32/cube/{build,agent-console,logging,testing}-details.md

build.md frontmatter + body updated to remove submodule/patches references
and point at firmware/. build.sh removed — idf.py is invoked from firmware/
directly in v2.

The overlay code itself (sentient/components/, sentient/boards/) is
imported separately in a later commit, after xiaozhi sources are in place.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Fetch fresh xiaozhi source to /tmp

**Why:** v2 copies xiaozhi sources from a clean checkout. Pinning to SHA `b72945a` (matches the prior submodule pin).

**Files:** none in repo (/tmp/ only)

- [ ] **Step 1: Clone fresh**

```bash
rm -rf /tmp/xz-rescope
git clone https://github.com/78/xiaozhi-esp32 /tmp/xz-rescope
```

Expected: clone succeeds.

- [ ] **Step 2: Check out pinned SHA**

```bash
cd /tmp/xz-rescope && git checkout b72945a
```

Expected: `HEAD is now at b72945a content：fix-ESP32-S3-Touch-AMOLED-2.16-readme.md`.

- [ ] **Step 3: Sanity-check target board file present**

```bash
ls /tmp/xz-rescope/main/boards/waveshare/esp32-s3-touch-amoled-2.16/
```

Expected: `README.md  config.h  config.json  esp32-s3-touch-amoled-2.16.cc`.

(No commit — /tmp is not under git.)

---

## Task 4: Create firmware/ skeleton

**Files:**
- Create: `esp32/cube/firmware/CMakeLists.txt`
- Create: `esp32/cube/firmware/components/.gitkeep`

- [ ] **Step 1: Create directory layout**

```bash
mkdir -p esp32/cube/firmware/main
mkdir -p esp32/cube/firmware/components
touch esp32/cube/firmware/components/.gitkeep
```

- [ ] **Step 2: Write top-level CMakeLists.txt**

Create `esp32/cube/firmware/CMakeLists.txt`:

```cmake
# Sentient ESP32 Cube — top-level CMakeLists (v2 rescope).
# Owned, flat firmware tree. No submodule, no patches.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/components")
project(sentient_cube)
```

- [ ] **Step 3: Verify skeleton**

```bash
ls -la esp32/cube/firmware/
```

Expected: `CMakeLists.txt  components/  main/`.

- [ ] **Step 4: Commit skeleton**

```bash
git add esp32/cube/firmware/CMakeLists.txt esp32/cube/firmware/components/.gitkeep
git commit -m "$(cat <<'EOF'
chore(esp32-cube): create firmware/ skeleton (rescope step 2/N)

Empty firmware/ root with top-level CMakeLists.txt. Subsequent commits
populate main/ from xiaozhi sources and components/ from v1 overlay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Copy xiaozhi keep-list into firmware/main/

**Files:** copy from `/tmp/xz-rescope/main/<paths>` to `esp32/cube/firmware/main/<same paths>`. Keep-list and exclusion list per spec section 3.2 + 3.3.

Keep (everything below is copied; everything else is omitted):
- `main/CMakeLists.txt`
- `main/Kconfig.projbuild`
- `main/application.{cc,h}`
- `main/main.cc`
- `main/device_state_machine.{cc,h}`
- `main/settings.{cc,h}`
- `main/sentient_creds.h`
- `main/system_info.{cc,h}`
- `main/assets.{cc,h}`
- `main/audio/audio_service.{cc,h}`
- `main/audio/codecs/`
- `main/audio/processors/`
- `main/display/` (whole directory — LVGL setup + helpers)
- `main/assets/`
- `main/protocols/websocket_protocol.{cc,h}` (plus any shared protocol base header)
- `main/boards/common/`
- `main/boards/waveshare/esp32-s3-touch-amoled-2.16/` (copied under target name `sentient-cube/`)

NOT copied:
- `main/ota.{cc,h}` — xiaozhi.me cloud OTA
- `main/mcp_server.{cc,h}` — xiaozhi device-side MCP
- `main/audio/wake_words/`
- `main/audio/demuxer/`
- `main/protocols/mqtt_protocol*`
- `main/boards/<every dir except common/ and the target board>`

Also copy the project-root files we'll need adjacent to firmware/main:
- `partitions.csv`
- `sdkconfig.defaults`

- [ ] **Step 1: Copy small top-level files**

```bash
SRC=/tmp/xz-rescope
DST=esp32/cube/firmware
cp "$SRC/main/CMakeLists.txt"           "$DST/main/"
cp "$SRC/main/Kconfig.projbuild"        "$DST/main/"
cp "$SRC/main/application.cc"           "$DST/main/"
cp "$SRC/main/application.h"            "$DST/main/"
cp "$SRC/main/main.cc"                  "$DST/main/"
cp "$SRC/main/device_state_machine.cc"  "$DST/main/"
cp "$SRC/main/device_state_machine.h"   "$DST/main/"
cp "$SRC/main/settings.cc"              "$DST/main/"
cp "$SRC/main/settings.h"               "$DST/main/"
cp "$SRC/main/sentient_creds.h"         "$DST/main/"
cp "$SRC/main/system_info.cc"           "$DST/main/"
cp "$SRC/main/system_info.h"            "$DST/main/"
cp "$SRC/main/assets.cc"                "$DST/main/"
cp "$SRC/main/assets.h"                 "$DST/main/"
```

- [ ] **Step 2: Copy audio subtree (without wake_words + demuxer)**

```bash
mkdir -p "$DST/main/audio"
cp "$SRC/main/audio/audio_service.cc" "$DST/main/audio/"
cp "$SRC/main/audio/audio_service.h"  "$DST/main/audio/"
cp -r "$SRC/main/audio/codecs"        "$DST/main/audio/"
cp -r "$SRC/main/audio/processors"    "$DST/main/audio/"
```

- [ ] **Step 3: Copy display + assets subtrees**

```bash
cp -r "$SRC/main/display" "$DST/main/display"
cp -r "$SRC/main/assets"  "$DST/main/assets"
```

- [ ] **Step 4: Copy WS protocol only**

```bash
mkdir -p "$DST/main/protocols"
cp "$SRC/main/protocols/websocket_protocol.cc" "$DST/main/protocols/"
cp "$SRC/main/protocols/websocket_protocol.h"  "$DST/main/protocols/"
# Also copy any shared protocol base header xiaozhi uses (protocol.h, etc.)
for f in "$SRC"/main/protocols/*.h; do
  base=$(basename "$f")
  if [ "$base" != "mqtt_protocol.h" ] && [ ! -e "$DST/main/protocols/$base" ]; then
    cp "$f" "$DST/main/protocols/"
  fi
done
```

- [ ] **Step 5: Copy board common + target board (under sentient-cube name)**

```bash
mkdir -p "$DST/main/boards"
cp -r "$SRC/main/boards/common"                                  "$DST/main/boards/common"
cp -r "$SRC/main/boards/waveshare/esp32-s3-touch-amoled-2.16"    "$DST/main/boards/sentient-cube"
```

- [ ] **Step 6: Copy partitions.csv + sdkconfig.defaults to firmware/**

```bash
cp "$SRC/partitions.csv" "$DST/" 2>/dev/null
cp "$SRC/main/partitions.csv" "$DST/" 2>/dev/null  # xiaozhi varies on location
[ ! -f "$DST/partitions.csv" ] && { echo "partitions.csv not found in xiaozhi tree — investigate"; exit 1; }

cp "$SRC/sdkconfig.defaults" "$DST/"
# Also append the ESP32-S3 specific defaults if xiaozhi shipped them
[ -f "$SRC/sdkconfig.defaults.esp32s3" ] && cat "$SRC/sdkconfig.defaults.esp32s3" >> "$DST/sdkconfig.defaults"
```

- [ ] **Step 7: Verify copy footprint**

```bash
find esp32/cube/firmware/main -type f | wc -l
du -sh esp32/cube/firmware/main
```

Expected: ~60-100 files, ~5-10 MB (asset blobs dominate).

- [ ] **Step 8: Verify exclusions**

```bash
find esp32/cube/firmware -name "ota.*" -o -name "mcp_server*" -o -name "mqtt_protocol*" -o -type d -name "wake_words" -o -type d -name "demuxer"
```

Expected: empty output. If anything is listed, copy was too greedy — remove it.

- [ ] **Step 9: Verify only target board present**

```bash
ls esp32/cube/firmware/main/boards/
```

Expected: `common/  sentient-cube/`. If other dirs listed, copy slipped — delete them.

- [ ] **Step 10: Commit copy**

```bash
git add esp32/cube/firmware/
git commit -m "$(cat <<'EOF'
chore(esp32-cube): copy xiaozhi keep-list into firmware/ (rescope 3/N)

Sources from xiaozhi-esp32 b72945a (v2.2.6-era). Keep-list:
- audio/{audio_service,codecs,processors}
- display/, assets/
- protocols/websocket_protocol* (+ shared base headers)
- boards/common/, boards/sentient-cube/ (was waveshare AMOLED 2.16)
- main top-level: application, main, device_state_machine, settings,
  sentient_creds, system_info, assets, Kconfig.projbuild, CMakeLists
- project root: partitions.csv, sdkconfig.defaults (+ S3 defaults appended)

Excluded entirely: OTA, MCP server, MQTT protocol, wake words, audio
demuxer, 32 non-target boards.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Strip OTA references from application.cc

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/application.h`

**Why:** application.cc was copied with OTA references intact. Since `ota.{cc,h}` weren't copied, every reference is a future build error.

- [ ] **Step 1: Find OTA touchpoints**

```bash
grep -n -E "(Ota|ota_|#include[[:space:]]+\"ota\.h\")" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

Note every line number.

- [ ] **Step 2: Remove the include**

In `esp32/cube/firmware/main/application.cc`, delete the line:
```cpp
#include "ota.h"
```

- [ ] **Step 3: Remove the OTA member from application.h**

In `esp32/cube/firmware/main/application.h`, find and delete any line containing `Ota ota_;` (or equivalent). Also delete any `class Ota;` forward declaration.

- [ ] **Step 4: Remove OTA calls in application.cc**

For every line in application.cc containing `ota_.` (e.g. `ota_.SetCheckVersionUrl(...)`, `ota_.CheckVersion()`, `ota_.Reboot()`), DELETE the line.

Exception: if `ota_.Reboot()` is the only thing inside `Application::Reboot()`, replace it with `esp_restart();` so the method still works.

- [ ] **Step 5: Verify no OTA refs remain**

```bash
grep -n -E "(Ota|ota_|\"ota\.h\")" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

Expected: empty output.

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): strip OTA from application.cc (rescope 4/N)

Removes ota_ member + ota.h include + every ota_.X() call.
Application::Reboot() now calls esp_restart() directly.

OTA was xiaozhi.me cloud feature; we do not OTA.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Strip MCP server references from application.cc

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/application.h`

- [ ] **Step 1: Find MCP touchpoints**

```bash
grep -n -E "(McpServer|mcp_server_|\"mcp_server\.h\")" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

- [ ] **Step 2: Remove include**

Delete the `#include "mcp_server.h"` line from `application.cc`.

- [ ] **Step 3: Remove MCP member from header**

In `application.h`, delete any line containing `McpServer mcp_server_;` (or similar).

- [ ] **Step 4: Remove MCP method calls**

For every `mcp_server_.X()` call in `application.cc` (e.g. `mcp_server_.Initialize()`, `mcp_server_.Start()`, `mcp_server_.RegisterTool(...)`), DELETE the line. Full feature removal.

- [ ] **Step 5: Verify clean**

```bash
grep -n -E "(McpServer|mcp_server_|\"mcp_server\.h\")" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): strip MCP server from application.cc (rescope 5/N)

xiaozhi's device-side MCP server is not used; the sentient gateway
owns MCP. Removes mcp_server_ member + initialization + every
RegisterTool call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Strip MQTT protocol from application.cc

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`

- [ ] **Step 1: Find MQTT touchpoints**

```bash
grep -n -E "(MqttProtocol|mqtt_protocol|\"mqtt_protocol\.h\")" esp32/cube/firmware/main/application.cc
```

- [ ] **Step 2: Remove the MQTT include**

Delete `#include "mqtt_protocol.h"` from `application.cc`.

- [ ] **Step 3: Force WebSocket-only protocol selection**

xiaozhi v2.2.6's `application.cc` typically has a runtime switch:

```cpp
Settings settings("protocol");
auto protocol_type = settings.GetString("type", "websocket");
if (protocol_type == "mqtt") {
    protocol_ = std::make_unique<MqttProtocol>();
} else {
    protocol_ = std::make_unique<WebsocketProtocol>();
}
```

Replace the whole if/else with:

```cpp
// Sentient cube speaks WebSocket only — v2 rescope removed MQTT path.
protocol_ = std::make_unique<WebsocketProtocol>();
```

- [ ] **Step 4: Verify clean**

```bash
grep -n -E "(MqttProtocol|mqtt_protocol)" esp32/cube/firmware/main/application.cc
```

Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/application.cc
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): force WS-only protocol in application.cc (6/N)

Removes mqtt_protocol.h include + the protocol_type=='mqtt' branch.
Sentient cube speaks WebSocket; gateway terminates the connection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Strip wake-word activation from application.cc

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`
- Modify: `esp32/cube/firmware/main/application.h`

- [ ] **Step 1: Find wake-word touchpoints**

```bash
grep -n -E "(WakeWord|wake_word_|wake_words)" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

- [ ] **Step 2: Remove wake-word header includes**

Delete every line in `application.cc` matching:
- `#include "wake_words/...h"`
- `#include "audio/wake_words/...h"`

- [ ] **Step 3: Remove the wake-word member**

In `application.h`, delete any line containing `WakeWord wake_word_;` (or similar).

- [ ] **Step 4: Remove wake-word activation calls**

In `application.cc`, find calls like `wake_word_.Initialize(...)`, `wake_word_.Start()`, `wake_word_.OnWakeWordDetected(...)`. Delete each. If a surrounding block becomes empty (e.g. the wake-word init function contained only these calls), keep the function definition with an empty body for now — we'll prune unused methods later.

- [ ] **Step 5: Verify clean**

```bash
grep -n -E "(WakeWord|wake_word_|wake_words)" esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
```

Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/firmware/main/application.cc esp32/cube/firmware/main/application.h
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): strip wake-word from application.cc (7/N)

Removes WakeWord member + initialization + detection callbacks.
Push-to-talk only; the toggle button drives Listening state directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Verify build green (first compile of xiaozhi-trimmed core)

**Why:** Before importing the overlay code, confirm the trimmed xiaozhi core compiles standalone. Surfaces any orphan references missed in Tasks 6-9.

**Files:** none (build only). The board file at `firmware/main/boards/sentient-cube/esp32-s3-touch-amoled-2.16.cc` (copied as-is from xiaozhi) provides the active board; merge into `sentient_cube.cc` happens in Task 14.

- [ ] **Step 1: Stage a temporary `sentient_creds.h` so the build doesn't fail on the bake step**

The build needs a `sentient_creds.h`. The user's `.e2e-testing` may not be set up yet. Stage a placeholder by editing the copied `sentient_creds.h`:

```bash
cat > esp32/cube/firmware/main/sentient_creds.h <<'EOF'
// Placeholder for Task 10 build check. Real values get baked from
// .e2e-testing during full smoke (Task 23+). Do NOT commit non-placeholder
// content here — file is gitignored.
#pragma once
#define SENTIENT_DEVICE_ID "placeholder-device-id"
#define SENTIENT_PASETO_TOKEN "placeholder-token"
#define SENTIENT_WS_URL "ws://placeholder:8080/ws"
#define SENTIENT_WIFI_SSID "placeholder"
#define SENTIENT_WIFI_PASSWORD "placeholder"
EOF
```

(File is in .gitignore, so this stays local to the worker.)

- [ ] **Step 2: Run idf.py reconfigure to make sure CMake recomputes**

```bash
source scripts/env.sh
cd esp32/cube/firmware
idf.py reconfigure 2>&1 | tail -20
```

Expected: no fatal errors. May warn about unfamiliar board name (`sentient-cube`) — we fix in Task 14.

- [ ] **Step 3: Run idf.py build**

```bash
idf.py build 2>&1 | tee /tmp/cube-build-task10.log | tail -30
```

Expected outcome: ONE of:
- (a) Build succeeds and produces `firmware/build/sentient_cube.bin` → great, move on.
- (b) Build fails with linker errors referring to OTA / MCP / MQTT / wake_word symbols → tasks 6-9 missed something. Re-grep, remove the orphan, re-run.
- (c) Build fails because xiaozhi tree's board selection mechanism (Kconfig) requires a specific board to be picked → expected. Document the symptom in commit body; full fix lands in Task 14 when we wire `sentient-cube` board properly.

If (c), proceed to Task 11 — the board wiring happens later. Otherwise (a) or (b), iterate until (a).

- [ ] **Step 4: Commit any orphan-removal fixups**

If Step 3 surfaced orphan refs missed in Tasks 6-9:

```bash
git add -p   # interactively pick fixups
git commit -m "$(cat <<'EOF'
fix(esp32-cube): remove orphan refs missed in initial strip (8/N)

Task 10 build check found: <list specific orphans found>.
Re-grep guard added in Tasks 6-9 review.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no fixups needed, no commit.

---

## Task 11: Import v1 overlay sources from archive

**Why:** Now we bring forward the v1 overlay code we plan to inline. Sources land under `esp32/cube/sentient/` temporarily (matches their v1 location); subsequent tasks move them to their final destinations.

**Files:**
- Create: `esp32/cube/sentient/components/agent_console/`
- Create: `esp32/cube/sentient/components/net_logger/`
- Create: `esp32/cube/sentient/boards/sentient-cube/sentient_cube.cc`
- Create: `esp32/cube/sentient/boards/sentient-cube/sentient_ui_controller.cc` (+ `.h`)
- Create: `esp32/cube/sentient/boards/sentient-cube/toggle_button_screen.cc` (+ `.h`)
- Create: `esp32/cube/sentient/patches/0003-disable-power-save-for-sentient-cube.patch`
- Create: `esp32/cube/sentient/patches/0004-audio-inject-hook.patch`

- [ ] **Step 1: Restore overlay sources from archive**

```bash
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/sentient/components/agent_console
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/sentient/components/net_logger
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/sentient/boards/sentient-cube
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/sentient/patches/0003-disable-power-save-for-sentient-cube.patch
git checkout esp32-cube-v1-overlay-archive -- esp32/cube/sentient/patches/0004-audio-inject-hook.patch
```

Patches 0001 + 0002 are intentionally NOT imported — they become unnecessary after the board merge in Task 14.

- [ ] **Step 2: Verify import**

```bash
ls esp32/cube/sentient/components/
ls esp32/cube/sentient/boards/sentient-cube/
ls esp32/cube/sentient/patches/
```

Expected:
- `components/`: `agent_console/  net_logger/`
- `boards/sentient-cube/`: `sentient_cube.cc  sentient_ui_controller.cc  toggle_button_screen.cc` (+ optional `.h`)
- `patches/`: `0003-disable-power-save-for-sentient-cube.patch  0004-audio-inject-hook.patch`

- [ ] **Step 3: Commit overlay import**

```bash
git add esp32/cube/sentient/
git commit -m "$(cat <<'EOF'
chore(esp32-cube): import v1 overlay sources from archive (rescope 9/N)

Pulls forward from esp32-cube-v1-overlay-archive:
- sentient/components/agent_console/
- sentient/components/net_logger/
- sentient/boards/sentient-cube/ (sentient_cube.cc, sentient_ui_controller.cc,
  toggle_button_screen.cc, headers if any)
- sentient/patches/0003-disable-power-save-for-sentient-cube.patch
- sentient/patches/0004-audio-inject-hook.patch

Patches 0001 + 0002 are intentionally not imported — board merge in
later task makes them unnecessary.

Subsequent commits move these files to their final destinations under
firmware/ and apply patches 0003+0004 as direct edits, then delete the
sentient/ tree.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Port agent_console as native component

**Files:**
- Move: `esp32/cube/sentient/components/agent_console/` → `esp32/cube/firmware/components/agent_console/`

- [ ] **Step 1: Move the directory**

```bash
git mv esp32/cube/sentient/components/agent_console esp32/cube/firmware/components/agent_console
```

Expected: all files staged as renames.

- [ ] **Step 2: Verify CMakeLists.txt is intact**

```bash
ls esp32/cube/firmware/components/agent_console/CMakeLists.txt
cat esp32/cube/firmware/components/agent_console/CMakeLists.txt
```

Expected: file exists. Should register the component with `idf_component_register()` including `verbs/` directory in `SRCS`. The `WHOLE_ARCHIVE` flag should be present (per project rule `agent-console.md` — verb constructors require it).

- [ ] **Step 3: Audit for stale upstream/sentient references in source**

```bash
grep -rn -E "(upstream|sentient/components)" esp32/cube/firmware/components/agent_console/
```

Expected: empty. If present, fix the references.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): port agent_console to firmware/components (10/N)

Move sentient/components/agent_console → firmware/components/agent_console.
No content change; CMakeLists already uses native ESP-IDF component form.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Port net_logger as native component

**Files:**
- Move: `esp32/cube/sentient/components/net_logger/` → `esp32/cube/firmware/components/net_logger/`

- [ ] **Step 1: Move the directory**

```bash
git mv esp32/cube/sentient/components/net_logger esp32/cube/firmware/components/net_logger
```

- [ ] **Step 2: Verify**

```bash
ls esp32/cube/firmware/components/net_logger/
cat esp32/cube/firmware/components/net_logger/CMakeLists.txt
```

Expected: `CMakeLists.txt  net_logger.cc  net_logger.h` (or similar).

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(esp32-cube): port net_logger to firmware/components (11/N)

Move sentient/components/net_logger → firmware/components/net_logger.
No content change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Merge sentient-cube board into a single file

**Why:** Today there are two board class files:
- `esp32/cube/firmware/main/boards/sentient-cube/esp32-s3-touch-amoled-2.16.cc` (from xiaozhi, defines `WaveshareEsp32s3TouchAMOLED2inch16`)
- `esp32/cube/sentient/boards/sentient-cube/sentient_cube.cc` (from v1 overlay, defines `SentientCubeBoard` deriving from the above)

In v2 the derivation goes away — one merged class. Patches 0001 (board registration) + 0002 (vtable defer / DeferLateInit) are obsoleted by the merge.

**Files:**
- Read: `esp32/cube/firmware/main/boards/sentient-cube/esp32-s3-touch-amoled-2.16.cc` (waveshare, ~428 LOC)
- Read: `esp32/cube/sentient/boards/sentient-cube/sentient_cube.cc` (overlay, ~270 LOC)
- Create: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` (merged)
- Delete: the two source files above (after merge)

This is the most surgical task in Phase 1. Implementer should re-iterate if first attempt doesn't compile.

- [ ] **Step 1: Read both source files completely**

```bash
wc -l esp32/cube/firmware/main/boards/sentient-cube/esp32-s3-touch-amoled-2.16.cc
wc -l esp32/cube/sentient/boards/sentient-cube/sentient_cube.cc
```

Read both files with the Read tool to map every method + every field of the waveshare class, plus every override + addition in the sentient overlay.

- [ ] **Step 2: Identify what the overlay adds**

The v1 `SentientCubeBoard` did the following beyond the waveshare base:
- `DeferLateInit` tag-struct constructor variant — used to defer waveshare's display/touch/button init until the derived vtable is set up. **Drop**: no derivation in v2, virtual dispatch from the merged class's own ctor works fine.
- `LateInit()` method called from derived ctor body — **drop**: same reason. Inline the contents into the constructor.
- Overrode `SetupUI()` to re-acquire `DisplayLockGuard` after calling base's `SetupUI()`, then create `sentient_cube_create_toggle_button_screen()`. **Keep**: lock re-acquisition is a real bug fix.
- `sentient_tts_cancel_provider()` static helper — registers via `agent_console_set_tts_cancel_provider()`. **Keep**.
- Initialization of agent_console, net_logger, sentient_ui_controller at the end of construction. **Keep** — call directly from merged ctor.

- [ ] **Step 3: Write the merged file**

Create `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` as a single class named `SentientCubeBoard`:

Structural template (the implementer fills in the method bodies verbatim from the waveshare source file, plus the sentient additions where indicated):

```cpp
// esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
// Merged board class: waveshare AMOLED 2.16 + sentient overlay (v2 rescope).
// Patches 0001 + 0002 are obsoleted by this merge; 0003 + 0004 land as
// direct edits in later tasks.

// Includes: combine the two source files' #includes, dedupe.
#include "wifi_board.h"
#include "system_reset.h"
#include "application.h"
// ... (every include from the waveshare file)
#include "axp2101.h"
#include "backlight.h"
// ... (sentient additions)
#include "agent_console.h"
#include "net_logger.h"
#include "toggle_button_screen.h"
#include "sentient_ui_controller.h"
#include "sentient_creds.h"

#include <driver/usb_serial_jtag.h>  // for Task 15 power-save monitor

#define TAG "sentient_cube"

namespace {

// From v1 overlay — Application::AbortSpeaking dispatch for tts.cancel verb.
void sentient_tts_cancel_provider() {
    Application::GetInstance().AbortSpeaking(kAbortReasonNone);
}

}  // namespace

class SentientCubeBoard : public WifiBoard {
private:
    // Fields verbatim from waveshare:
    //   I2cMaster i2c_master_;
    //   Axp2101* power_manager_;
    //   LvglDisplay* display_;
    //   Backlight* backlight_;
    //   AudioCodec* codec_;
    //   Touch* touch_;
    //   ... etc.
    // NO DeferLateInit member — dropped in v2.

public:
    SentientCubeBoard() : WifiBoard() {
        ESP_LOGI(TAG, "ctor begin device_id=" SENTIENT_DEVICE_ID);

        // Body order: keep waveshare's init order, then sentient overlays.
        InitializeI2c();
        InitializeAxp2101();
        InitializeDisplay();
        InitializeBacklight();
        InitializeTouch();
        InitializeButtons();
        InitializeCodec();
        InitializeIot();

        // Sentient additions (formerly LateInit() in v1 overlay):
        agent_console_set_tts_cancel_provider(sentient_tts_cancel_provider);
        net_logger_start();
        agent_console_start();
        sentient_ui_controller_start();

        ESP_LOGI(TAG, "ctor end");
    }

    // ===== Methods verbatim from waveshare source =====
    // InitializeI2c, InitializeAxp2101, InitializeDisplay, InitializeBacklight,
    // InitializeTouch, InitializeButtons, InitializeCodec, InitializeIot
    // — keep bodies as-is.

    // ===== Overrides =====

    virtual void SetupUI() override {
        ESP_LOGI(TAG, "setup_ui device_id=" SENTIENT_DEVICE_ID);
        // Run base WifiBoard's default UI setup first (xiaozhi default panel etc.)
        WifiBoard::SetupUI();
        // Critical: re-acquire the LVGL lock — WifiBoard::SetupUI() releases
        // it on return, and toggle_button_screen creates LVGL widgets.
        DisplayLockGuard lock(this);
        sentient_cube_create_toggle_button_screen();
    }

    virtual AudioCodec* GetAudioCodec() override {
        return codec_;
    }

    virtual Backlight* GetBacklight() override {
        return backlight_;
    }

    // ... rest of accessors verbatim from waveshare (GetDisplay, GetLed, etc.)
};

DECLARE_BOARD(SentientCubeBoard);
```

The implementer writes the FULL merged file (~500-700 lines combining both sources). The skeleton above is the structural map — every `// from waveshare` placeholder is replaced by the verbatim method body from the waveshare source file.

- [ ] **Step 4: Delete the two old source files**

```bash
git rm esp32/cube/firmware/main/boards/sentient-cube/esp32-s3-touch-amoled-2.16.cc
git rm esp32/cube/sentient/boards/sentient-cube/sentient_cube.cc
```

- [ ] **Step 5: Update the board's CMakeLists.txt**

Edit `esp32/cube/firmware/main/boards/sentient-cube/CMakeLists.txt` so it lists the merged source file. xiaozhi's board CMakeLists pattern uses a `BOARD_SOURCES` variable that gets included by `main/CMakeLists.txt`. Read the existing CMakeLists and adapt:

If it currently says something like:

```cmake
list(APPEND BOARD_SOURCES "boards/waveshare/esp32-s3-touch-amoled-2.16/esp32-s3-touch-amoled-2.16.cc")
```

Replace with:

```cmake
list(APPEND BOARD_SOURCES
    "boards/sentient-cube/sentient_cube.cc"
    "boards/sentient-cube/sentient_ui_controller.cc"
    "boards/sentient-cube/toggle_button_screen.cc"
)
```

(Sentient_ui_controller + toggle_button_screen move into this directory in Task 15; CMakeLists wiring is forward-compatible.)

- [ ] **Step 6: Update main/Kconfig.projbuild board selection**

`main/Kconfig.projbuild` defines which boards are selectable. Find the existing `BOARD_TYPE_*` block (likely `BOARD_TYPE_WAVESHARE_AMOLED_216` or similar) and rename to `BOARD_TYPE_SENTIENT_CUBE`. Update the `default` to the new symbol.

```bash
grep -n -E "BOARD_TYPE_(WAVE|AMOLED|SENTIENT)" esp32/cube/firmware/main/Kconfig.projbuild
```

Edit the file: rename the chosen-board symbol and any references downstream (e.g. in `main/CMakeLists.txt` where it picks the board subdirectory).

- [ ] **Step 7: Update main/CMakeLists.txt board selector**

```bash
grep -n "BOARD_TYPE_\|boards/waveshare" esp32/cube/firmware/main/CMakeLists.txt
```

Edit to dispatch to `boards/sentient-cube/` when `BOARD_TYPE_SENTIENT_CUBE` is selected. Drop any non-target board dispatch arms.

- [ ] **Step 8: Update sdkconfig.defaults to select the new board**

```bash
grep -n "BOARD_TYPE" esp32/cube/firmware/sdkconfig.defaults
```

Update the `CONFIG_BOARD_TYPE_*=y` line to `CONFIG_BOARD_TYPE_SENTIENT_CUBE=y` (or whatever Kconfig naming you settled on in Step 6).

- [ ] **Step 9: Commit**

```bash
git add esp32/cube/firmware/main/
git commit -m "$(cat <<'EOF'
refactor(esp32-cube/board): merge waveshare AMOLED 2.16 + sentient overlay (12/N)

Combines the two-class derivation into a single SentientCubeBoard class.
Removes DeferLateInit tag struct + LateInit() pattern — virtual dispatch
works from the merged class's own constructor since there is no
derivation. Patches 0001 + 0002 are obsoleted by this merge.

Re-acquires DisplayLockGuard in SetupUI() after WifiBoard::SetupUI()
returns, preserving the v1 fix for toggle_button_screen creation.

Kconfig.projbuild, main/CMakeLists.txt, and sdkconfig.defaults updated
to select BOARD_TYPE_SENTIENT_CUBE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Move toggle_button_screen + sentient_ui_controller into board dir

**Files:**
- Move: `esp32/cube/sentient/boards/sentient-cube/toggle_button_screen.cc` (+ `.h`) → `esp32/cube/firmware/main/boards/sentient-cube/`
- Move: `esp32/cube/sentient/boards/sentient-cube/sentient_ui_controller.cc` (+ `.h`) → `esp32/cube/firmware/main/boards/sentient-cube/`

- [ ] **Step 1: Move files**

```bash
git mv esp32/cube/sentient/boards/sentient-cube/toggle_button_screen.cc esp32/cube/firmware/main/boards/sentient-cube/
[ -f esp32/cube/sentient/boards/sentient-cube/toggle_button_screen.h ] && git mv esp32/cube/sentient/boards/sentient-cube/toggle_button_screen.h esp32/cube/firmware/main/boards/sentient-cube/
git mv esp32/cube/sentient/boards/sentient-cube/sentient_ui_controller.cc esp32/cube/firmware/main/boards/sentient-cube/
[ -f esp32/cube/sentient/boards/sentient-cube/sentient_ui_controller.h ] && git mv esp32/cube/sentient/boards/sentient-cube/sentient_ui_controller.h esp32/cube/firmware/main/boards/sentient-cube/
```

- [ ] **Step 2: Verify**

```bash
ls esp32/cube/firmware/main/boards/sentient-cube/
```

Expected: `CMakeLists.txt  config.h  config.json  sentient_cube.cc  sentient_ui_controller.cc  toggle_button_screen.cc` (+ optional `.h` files).

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(esp32-cube/board): move toggle_button + ui_controller to board dir (13/N)

These were already board-specific; now they live alongside the merged
SentientCubeBoard class. CMakeLists.txt (updated in Task 14) already
references the new paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Apply patch 0003 (USB-aware power save) as direct edit

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`
- Delete: `esp32/cube/sentient/patches/0003-disable-power-save-for-sentient-cube.patch`

**Why:** v1 patch 0003 wrapped power-save timer toggling behind `usb_serial_jtag_is_connected()`. Inline that logic into the merged board class.

- [ ] **Step 1: Read the patch for reference**

```bash
cat esp32/cube/sentient/patches/0003-disable-power-save-for-sentient-cube.patch
```

Note the exact FreeRTOS task body that polls `usb_serial_jtag_is_connected()` every 5s.

- [ ] **Step 2: Add InitializePowerSaveMonitor() method to SentientCubeBoard**

In `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`, add a private method:

```cpp
private:
    void InitializePowerSaveMonitor() {
        // USB tether → disable power save (keep awake for cube-cmd traffic).
        // Untethered → normal idle power save.
        // Polls usb_serial_jtag_is_connected() every 5s.
        // v1 patch 0003 inlined here in v2 rescope.
        xTaskCreate([](void* /*arg*/) {
            // PowerSaveTimer is owned by the base xiaozhi Board class.
            // Access via the standard xiaozhi API — check wifi_board.h /
            // board.h for the actual accessor (static method, friend, or
            // singleton). Implementer adjusts the call below to match.
            extern PowerSaveTimer* GetPowerSaveTimer();  // adjust to actual API
            auto* timer = GetPowerSaveTimer();
            bool last_tethered = true;
            if (timer) timer->SetEnabled(false);
            for (;;) {
                bool tethered = usb_serial_jtag_is_connected();
                if (tethered != last_tethered) {
                    if (timer) timer->SetEnabled(!tethered);
                    last_tethered = tethered;
                }
                vTaskDelay(pdMS_TO_TICKS(5000));
            }
        }, "psave-usb", 2560, nullptr, tskIDLE_PRIORITY + 1, nullptr);
    }
```

NOTE for implementer: the `GetPowerSaveTimer()` accessor name above is illustrative. Read `firmware/main/boards/common/` headers and `firmware/main/application.h` to find the actual API. The v1 patch held a raw pointer (`power_save_timer_`) directly accessible from a friend class. Match the v1 pattern as closely as possible.

- [ ] **Step 3: Call InitializePowerSaveMonitor() from the constructor**

Edit the `SentientCubeBoard()` constructor (from Task 14) to call `InitializePowerSaveMonitor()` as the FIRST statement of the body, before `InitializeI2c()`:

```cpp
SentientCubeBoard() : WifiBoard() {
    InitializePowerSaveMonitor();   // ← add this line
    ESP_LOGI(TAG, "ctor begin ...");
    InitializeI2c();
    // ... rest unchanged
}
```

- [ ] **Step 4: Verify include for usb_serial_jtag header**

```bash
grep "usb_serial_jtag" esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
```

Expected: at least one match (the include + the API call).

If the include is missing, add to the top of the file:

```cpp
#include <driver/usb_serial_jtag.h>
```

- [ ] **Step 5: Delete patch 0003 file**

```bash
git rm esp32/cube/sentient/patches/0003-disable-power-save-for-sentient-cube.patch
```

- [ ] **Step 6: Commit**

```bash
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
git commit -m "$(cat <<'EOF'
refactor(esp32-cube/board): inline patch 0003 — USB-aware power save (14/N)

Replaces patches/0003 with a direct edit to SentientCubeBoard::
InitializePowerSaveMonitor(). FreeRTOS task polls
usb_serial_jtag_is_connected() every 5s and toggles the xiaozhi
PowerSaveTimer accordingly. Cube stays awake while tethered, sleeps
on battery.

patches/0003 deleted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Apply patch 0004 (audio inject hook) as direct edit

**Files:**
- Modify: `esp32/cube/firmware/main/audio/audio_service.cc`
- Delete: `esp32/cube/sentient/patches/0004-audio-inject-hook.patch`

**Why:** v1 patch 0004 added a weak-symbol hook in `AudioService::ReadAudioData` so the `audio.inject_pcm` verb (in `firmware/components/agent_console/verbs/audio.cc`) can override mic input with canned PCM. Inline directly.

- [ ] **Step 1: Read the patch for reference**

```bash
cat esp32/cube/sentient/patches/0004-audio-inject-hook.patch
```

Note exact: the weak-symbol declaration form, where in `ReadAudioData` the hook gets called, the return-value semantics (samples-injected vs. 0 for "fall through").

- [ ] **Step 2: Find ReadAudioData in audio_service.cc**

```bash
grep -n "ReadAudioData" esp32/cube/firmware/main/audio/audio_service.cc
```

- [ ] **Step 3: Add the inject hook near the top of audio_service.cc**

After the existing includes, add:

```cpp
// Sentient audio.inject_pcm hook (v1 patch 0004 inlined for v2 rescope).
// Strong override lives in firmware/components/agent_console/verbs/audio.cc.
// Default (weak) returns 0 → falls through to normal codec path.
extern "C" {
    __attribute__((weak)) int sentient_audio_inject_read(int16_t* out, size_t max_samples) {
        (void)out;
        (void)max_samples;
        return 0;
    }
}
```

- [ ] **Step 4: Call the hook from ReadAudioData**

Inside `AudioService::ReadAudioData(int16_t* buffer, size_t samples)` (or whatever the exact method signature is — read it first), at the very top of the method body, add:

```cpp
int injected = sentient_audio_inject_read(buffer, samples);
if (injected > 0) {
    return injected;
}
// fall through to normal codec read
```

- [ ] **Step 5: Verify agent_console/verbs/audio.cc still exposes the strong override**

```bash
grep -n "sentient_audio_inject_read" esp32/cube/firmware/components/agent_console/verbs/audio.cc
```

Expected: at least one definition (without `__attribute__((weak))`) overrides the weak default at link time.

- [ ] **Step 6: Delete patch 0004 file**

```bash
git rm esp32/cube/sentient/patches/0004-audio-inject-hook.patch
```

- [ ] **Step 7: Commit**

```bash
git add esp32/cube/firmware/main/audio/audio_service.cc
git commit -m "$(cat <<'EOF'
refactor(esp32-cube/audio): inline patch 0004 — audio inject hook (15/N)

Replaces patches/0004 with a direct edit to audio_service.cc. Weak
symbol sentient_audio_inject_read() returns 0 by default; strong
override in agent_console/verbs/audio.cc injects canned samples when
the audio.inject_pcm verb is active.

patches/0004 deleted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Delete the now-empty sentient/ tree

**Files:**
- Delete: `esp32/cube/sentient/` (entirely)

- [ ] **Step 1: Audit what remains**

```bash
find esp32/cube/sentient -type f
```

Expected: empty output (everything moved or deleted in Tasks 11-17). If anything is listed, inspect — it's either a missed move or a stray file.

- [ ] **Step 2: Delete the tree**

```bash
git rm -rf esp32/cube/sentient
```

- [ ] **Step 3: Verify gone**

```bash
ls esp32/cube/sentient 2>&1 | grep "No such"
```

Expected: matches "No such file or directory".

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(esp32-cube): delete sentient/ overlay tree (16/N)

Removes esp32/cube/sentient/ entirely. All overlay code was moved into
firmware/ in prior tasks; patches 0003 + 0004 became direct edits;
patches 0001 + 0002 obsoleted by the board merge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Update cube scripts for firmware/ paths

**Files:**
- Modify: `esp32/cube/scripts/_cube_daemon.py` (if it references build dir)
- Modify: `esp32/cube/scripts/_cube_cmd_helper.py`
- Modify: `esp32/cube/scripts/cube-cmd.sh`
- Modify: `esp32/cube/scripts/bake-creds.sh`

- [ ] **Step 1: Audit scripts**

```bash
grep -rn -E "upstream/|sentient/(components|boards|creds)" esp32/cube/scripts/
```

Note every match.

- [ ] **Step 2: Replace upstream/build → firmware/build**

For any script that references the build directory or compiled binary:
- `esp32/cube/upstream/build/` → `esp32/cube/firmware/build/`

- [ ] **Step 3: Replace sentient/ paths in bake-creds.sh**

`bake-creds.sh` reads `esp32/cube/.e2e-testing` and writes a `sentient_creds.h` somewhere. v1 wrote to `esp32/cube/sentient/creds/sentient_creds.h`. v2 writes to `esp32/cube/firmware/main/sentient_creds.h`.

Edit `bake-creds.sh`:
```bash
# v1 path (old):
# OUT="$ROOT/esp32/cube/sentient/creds/sentient_creds.h"
# v2 path (new):
OUT="$ROOT/esp32/cube/firmware/main/sentient_creds.h"
```

- [ ] **Step 4: Test scripts spawn**

```bash
# Kill any stale daemon
[ -f /tmp/cube-daemon.pid ] && kill $(cat /tmp/cube-daemon.pid) 2>/dev/null
rm -f /tmp/cube-daemon.pid /tmp/cube-daemon.sock

# Test cube-cmd help / ping (won't connect to a wedged cube; just verify script paths resolve)
bash esp32/cube/scripts/cube-cmd.sh state 2>&1 | head -3
```

Expected: script runs; if cube not plugged in, the daemon eventually times out — that's fine for path verification.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/scripts/
git commit -m "$(cat <<'EOF'
build(esp32-cube/scripts): retarget at firmware/ (17/N)

Updates _cube_daemon.py, _cube_cmd_helper.py, cube-cmd.sh, bake-creds.sh
to reference esp32/cube/firmware/ paths. v1's upstream/ and
sentient/creds/ are gone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Retarget pytest-embedded HIL harness at firmware/

**Files:**
- Modify: `esp32/cube/tests/conftest.py` (or wherever build path lives)
- Modify: `esp32/cube/tests/cube_dut.py` (if separate)

- [ ] **Step 1: Find build-path references**

```bash
grep -rn -E "upstream/build|sentient/" esp32/cube/tests/
```

- [ ] **Step 2: Update conftest + dut helpers**

Replace `esp32/cube/upstream/build/` → `esp32/cube/firmware/build/`.

If conftest looks for a binary at e.g. `xiaozhi-esp32.bin`, the new binary is `sentient_cube.bin` (per Task 4's `project(sentient_cube)`). Update the filename pattern.

- [ ] **Step 3: Collect-only check**

```bash
source scripts/env.sh
cd esp32/cube
.venv/bin/python -m pytest tests/ --collect-only 2>&1 | tail -15
```

Expected: tests collect successfully; no path errors, no import errors. Actual execution depends on cube hardware (Task 24+).

If the .venv doesn't exist, recreate it (this is the worker's first time using HIL harness in v2 worktree):

```bash
cd esp32/cube
python3 -m venv .venv
.venv/bin/pip install -r tests/requirements.txt
```

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/tests/
git commit -m "$(cat <<'EOF'
test(esp32-cube/hil): retarget pytest-embedded at firmware/build (18/N)

Updates conftest.py + DUT helpers to point at firmware/build/sentient_cube.bin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: User-owned creds restore (manual prerequisite for Task 23)

**Files:**
- User-provided: `esp32/cube/.e2e-testing` (gitignored)

**Why:** v2 worktree has no `.e2e-testing` file. The user owns this file and must restore it before bake-creds can run.

- [ ] **Step 1: Check if `.e2e-testing` exists**

```bash
ls -la esp32/cube/.e2e-testing 2>&1
```

If missing, halt and prompt the user:

> "esp32/cube/.e2e-testing is missing. Please copy it forward from your v1 working tree (or recreate with WiFi SSID, password, sentient WS URL, PASETO token). File is gitignored. Once in place, resume from Task 21 Step 2."

- [ ] **Step 2: Verify required keys**

The file should contain these key=value lines (per `bake-creds.sh`):

```
SENTIENT_DEVICE_ID=...
SENTIENT_PASETO_TOKEN=...
SENTIENT_WS_URL=...
SENTIENT_WIFI_SSID=...
SENTIENT_WIFI_PASSWORD=...
```

```bash
grep -E "^(SENTIENT_DEVICE_ID|SENTIENT_PASETO_TOKEN|SENTIENT_WS_URL|SENTIENT_WIFI_SSID|SENTIENT_WIFI_PASSWORD)=" esp32/cube/.e2e-testing
```

Expected: 5 lines. If any are missing, prompt user to add.

- [ ] **Step 3: Run bake-creds.sh**

```bash
bash esp32/cube/scripts/bake-creds.sh
```

Expected: writes `esp32/cube/firmware/main/sentient_creds.h` with real values. Overwrites the placeholder we wrote in Task 10.

- [ ] **Step 4: Verify the baked file is gitignored**

```bash
git check-ignore esp32/cube/firmware/main/sentient_creds.h
```

Expected: prints the file path (meaning it IS ignored).

If NOT ignored, append to `esp32/cube/.gitignore`:
```
firmware/main/sentient_creds.h
```

(No commit — `.e2e-testing` and baked `sentient_creds.h` are gitignored.)

---

## Task 22: First build of merged + ported firmware/ tree

**Files:** none (build only)

**Why:** Validates that Tasks 11-21 didn't break the build. This is the build that has the merged board + ported components + inlined patches.

- [ ] **Step 1: Source env, run idf.py build**

```bash
source scripts/env.sh
cd esp32/cube/firmware
idf.py reconfigure 2>&1 | tail -10
idf.py build 2>&1 | tee /tmp/cube-build-task22.log | tail -30
```

Expected: ends with `Project build complete. To flash, run:`.

Common failure modes specific to this task:
- The merged board class missing methods xiaozhi expects (`GetDisplay()`, `GetLed()`, etc.) — re-add from waveshare source.
- Linker error `undefined reference to sentient_cube_create_toggle_button_screen` — toggle_button_screen.cc not in BOARD_SOURCES. Re-check Task 14 step 5.
- Linker error on net_logger or agent_console symbols — CMakeLists in those components mismatched. Re-check Tasks 12, 13.
- ESP-IDF complaining about unknown component — `set(EXTRA_COMPONENT_DIRS ...)` in firmware/CMakeLists.txt missing or wrong.

For each: read the error, identify the root cause, fix the source.

- [ ] **Step 2: Confirm binary artifact**

```bash
ls -la esp32/cube/firmware/build/sentient_cube.bin
```

Expected: ~1-2 MB file.

- [ ] **Step 3: Commit any fixups**

If Step 1 surfaced issues, the fixes get their own commit:

```bash
git add -p
git commit -m "$(cat <<'EOF'
fix(esp32-cube): wire firmware/ build green (19/N)

Final wiring needed for the trimmed tree to link cleanly.
<one-line per fix applied>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no fixups, no commit.

---

## Task 23: First flash + state verb smoke

**Files:** none (hardware verification)

**Flash budget:** flash #1 of phase. Target ≤ 3 total.

- [ ] **Step 1: Verify cube health pre-flash**

```bash
[ -e /tmp/cube-daemon.sock ] && bash esp32/cube/scripts/cube-cmd.sh state 2>&1 || echo "daemon not running yet"
```

If a daemon is up and the cube responds with a state, the cube is alive. If silent or wedged → physical recovery per Prerequisites BEFORE flashing.

- [ ] **Step 2: Stop any stale daemon**

```bash
[ -f /tmp/cube-daemon.pid ] && kill $(cat /tmp/cube-daemon.pid) 2>/dev/null
rm -f /tmp/cube-daemon.pid /tmp/cube-daemon.sock
```

- [ ] **Step 3: Flash**

```bash
cd esp32/cube/firmware
idf.py -p /dev/cu.usbmodem101 flash 2>&1 | tail -10
```

Expected: ends with `Hard resetting via RTS pin...`. Flash count = 1.

- [ ] **Step 4: Run state verb (daemon auto-spawns)**

```bash
bash esp32/cube/scripts/cube-cmd.sh state 2>&1
```

Expected: JSON RPC result with `state` field, e.g.:
```json
{"state": "IDLE", "ws_connected": false}
```

(Exact field names match the v1 verb implementation.)

If `daemon timeout`: cube is wedged. Check `/tmp/cube-daemon.log` for AXP2101 fault. Recover physically.

- [ ] **Step 5: Smoke 1 = ✅**

Record:
- Flash count: 1
- AXP2101 faults: 0 (target)
- Daemon restarts: 1 (initial spawn)

(No commit — verification only)

---

## Task 24: mark verb smoke

**Files:** none

- [ ] **Step 1: Emit checkpoint**

```bash
bash esp32/cube/scripts/cube-cmd.sh mark hello-phase1
```

Expected: RSP returns success (a `{"ok": true}` or similar shape).

- [ ] **Step 2: Verify checkpoint event**

```bash
bash esp32/cube/scripts/cube-cmd.sh events --tail 10 2>&1 | grep CHECKPOINT
```

Expected: at least one line matching `>>> CHECKPOINT hello-phase1 <microsecond timestamp>`. The timestamp must be an integer, not literal "ld" (a Task 27 handover regression check).

- [ ] **Step 3: Smoke 2 = ✅**

(No commit)

---

## Task 25: UDP log shipping smoke

**Files:** none

- [ ] **Step 1: Start a UDP listener**

```bash
nc -ul 9000 > /tmp/cube-udp-log.txt &
NC_PID=$!
sleep 1
```

- [ ] **Step 2: Trigger log emission**

```bash
bash esp32/cube/scripts/cube-cmd.sh mark udp-test
```

(net_logger also ships boot lines independently of mark, so we'd see some traffic even without this.)

- [ ] **Step 3: Wait + check**

```bash
sleep 3
kill $NC_PID 2>/dev/null
wc -l /tmp/cube-udp-log.txt
head -10 /tmp/cube-udp-log.txt
```

Expected: ≥ 1 line. Lines look like `>>> LOG sentient.cube.<tag> ...` per net_logger format.

If 0 lines:
- Confirm net_logger linked: `grep -r "net_logger_start" esp32/cube/firmware/build/ 2>&1 | head -5`
- Confirm `.e2e-testing` has the host IP as net_logger destination
- Confirm cube is on the same WiFi network: `cube-cmd events --tail 20 | grep wifi`

- [ ] **Step 4: Smoke 3 = ✅**

Record final flash + smoke metrics. Target state:
- Flashes: 1
- AXP2101 faults: 0
- Daemon restarts: 1
- Cold recoveries: 0
- Total dev time on smoke: ~30 min

(No commit)

---

## Task 26: Update MEMORY.md if any non-obvious learnings emerged

**Files:**
- Modify (maybe): `~/.claude/projects/-Users-kevinye-Development-sentient/memory/MEMORY.md`
- Create (maybe): a new memory file at the same dir

**Why:** Per `using-superpowers` auto-memory guidance: anything earned during Phase 1 that the user would benefit from in future conversations gets stored as memory. Specifically: cube-specific gotchas, build-flow surprises, AXP2101 recovery details that aren't already in the rule files.

- [ ] **Step 1: Audit findings against existing memory**

```bash
cat ~/.claude/projects/-Users-kevinye-Development-sentient/memory/MEMORY.md | head -50
```

Note which existing memory entries are still accurate. Phase 1 may have invalidated some entries (e.g. any project memory referring to v1 overlay paths).

- [ ] **Step 2: Update or add memory entries**

Examples of things worth saving:
- Any v1 → v2 path remap users may bump into when reading old logs (e.g. "agent_console moved from sentient/components/ to firmware/components/").
- The fact that `bake-creds.sh` now writes to `firmware/main/sentient_creds.h`.
- Any non-trivial decision the user co-authored during this phase.

DO NOT save:
- The fact that v2 exists (will be obvious from spec / commits).
- Code structure (derivable from reading the tree).
- "What was done" — that's the handover (Task 27), not memory.

If nothing memory-worthy emerged, skip this task. Memory is not a journal; only save things future-you needs to know.

- [ ] **Step 3: Commit memory changes if any**

Memory files live outside the repo, so no `git add` — just save the files and move on. The auto-memory directory is `~/.claude/projects/-Users-kevinye-Development-sentient/memory/`.

---

## Task 27: Write Phase 1 handover document

**Files:**
- Create: `docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md`

**Why:** Per spec section 5 — mandatory plan-scoped deliverable. Last step before user review.

- [ ] **Step 1: Create handover file**

Write a fresh `docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md`. Required sections in this order:

```markdown
# ESP32 Cube Phase 1 — Foundation Handover

**Date:** 2026-05-11
**Branch:** feature/esp32-cube-v2-rescope
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md

## What's done

- (one bullet per merged commit, plain language, no SHAs)

## What's used (stack you now own)

| Path | Responsibility |
|---|---|
| ... | ... |

Verbs callable today:
- `cube-cmd state`
- `cube-cmd mark <label>`
- `cube-cmd events --tail N`
- (any other verb verified working in this phase)

GPIO/HW used at boot: (list what the cube touched on first boot)

## What's smoked

- **boot**: `idf.py flash` → cube boots, no panic → ✅
- **state**: `cube-cmd state` returns valid JSON → ✅
- **mark**: `cube-cmd mark hello-phase1` → `>>> CHECKPOINT hello-phase1 <ts>` visible → ✅
- **udp log**: `nc -ul 9000` receives net_logger output → ✅

Evidence:
- `/tmp/cube-build-task22.log` (last 30 lines pasted in commit body)
- `/tmp/cube-udp-log.txt` (first 10 lines pasted in commit body)

## What you need to know

(Real findings — the implementer fills these from things discovered during Tasks 6-22. 2-5 bullets. NEVER leave as placeholders.)

## Hardware glossary

- **AMOLED**: Active-matrix OLED display. Self-emissive per pixel — no backlight LED. Our 2.16" panel is 466×466 resolution, driven over QSPI.
- **AXP2101**: Power management IC (PMIC). Manages battery charge, voltage rails, GPIO. Speaks I²C bus 1. Reset/init state is fragile after many rapid USB-Serial-JTAG resets — source of our boot fault.
- **USB-Serial-JTAG**: ESP32-S3's USB peripheral exposing CDC serial + JTAG. Hardware translates host DTR/RTS toggles into ESP32-S3 strap pin moves, which is why pyserial `open()` resets the cube.
- **QSPI**: Quad SPI. Four data lines vs. plain SPI's one. Used for AMOLED panel data path.
- **PowerSaveTimer**: xiaozhi component that puts the chip in light-sleep after N idle seconds. Disabled by us when USB-tethered.
- **I²C**: Two-wire serial bus (SDA + SCL). The cube uses one bus for AXP2101 + CST816 touch.

## Open questions / risks

- (real risks discovered during phase, OR "no known risks; agent confidence high" + one-line justification)

## Flash + smoke metrics

- Flashes this phase: <n>
- AXP2101 faults hit: <n>
- Daemon restarts: <n>
- Cold physical recoveries: <n>
- Total dev time on smoke runs: <approx hours>
```

- [ ] **Step 2: Fill in real values + findings**

Replace every parenthesized placeholder with actual findings from this phase. The "What you need to know" section MUST contain genuine learnings — if truly nothing new was learned, that itself is the bullet ("no novel HW behavior in this phase; all expected").

- [ ] **Step 3: Verify all 7 sections present**

```bash
grep -c "^## " docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md
```

Expected: 7.

- [ ] **Step 4: Commit handover**

```bash
git add docs/superpowers/handovers/2026-05-11-esp32-cube-phase1-foundation.md
git commit -m "$(cat <<'EOF'
docs(esp32-cube): Phase 1 foundation handover

Phase 1 complete:
- v1 archive tagged at esp32-cube-v1-overlay-archive
- Cube infrastructure imported from v1 (scripts, tests, docs, rules)
- xiaozhi source copied + trimmed (~80K LOC dropped)
- Overlay code ported as native components
- Board merged — patches 0001+0002 obsoleted, 0003+0004 inlined
- Boot smoke green: state + mark + UDP logs verified

Flash count: <n> / AXP2101 faults: <n> / Cold recoveries: <n>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 28: Post handover to chat, await user review

**Files:** none (chat message)

- [ ] **Step 1: Paste full handover content to chat**

The user reads the handover. Either:
- Approves → Phase 2 plan gets written next (separate `superpowers:writing-plans` invocation against the same spec).
- Reopens → return to the relevant Phase 1 task, fix, re-run smoke, re-write handover.

- [ ] **Step 2: Do NOT merge feature branch to develop yet**

The branch keeps going through Phase 5 per spec. Wait for explicit user approval before considering Phase 1 closed.

---

## Self-review checklist

Run this after Task 27 commits, before Task 28 chat post.

### Spec coverage

- [ ] **§3.1 Tree layout** → Tasks 4, 5, 11, 12, 13, 14, 15 (build the structure)
- [ ] **§3.2 Keep-list** → Task 5 explicit list
- [ ] **§3.3 Deletion list** → Task 5 exclusions + Task 5 step 8 verification
- [ ] **§3.4 Overlay → native** → Tasks 11-17
- [ ] **§3.5 Architectural payoff** → Task 14 (merge), Task 16 (power-save inline), Task 17 (audio hook inline)
- [ ] **§4 Phase 1 scope** → entire plan
- [ ] **§5 Handover format** → Task 27
- [ ] **§6 Debug tooling locked** → Tasks 12, 13, 19, 20
- [ ] **§9 Test strategy** → Task 20 (retarget HIL, no new units)
- [ ] **§10 Migration steps 1-12** → Tasks 1-28 covering all 12 steps
- [ ] **§11 AXP2101 risk** → flash-discipline rule + Prerequisites section + Task 23 step 1

### Placeholder scan

- [ ] No "TBD" / "TODO" in any task body.
- [ ] No "implement later" / "fill in details" prose outside the handover template (which IS expected to have filled-in findings).
- [ ] No "similar to Task N" — every task has its own complete steps.
- [ ] Every code block is real, runnable. Skeletons (Tasks 14, 16, 17) explicitly call out "implementer fills from source" with the actual procedure attached.

### Type / path consistency

- [ ] `SentientCubeBoard` class name same in Tasks 14, 16.
- [ ] `firmware/main/boards/sentient-cube/sentient_cube.cc` path same in Tasks 14, 15, 16.
- [ ] `firmware/components/agent_console/` path same in Tasks 12, 19.
- [ ] `firmware/build/` path same in Tasks 22, 23.
- [ ] `sentient_audio_inject_read` symbol same in Task 17 hook + agent_console/verbs/audio.cc.
- [ ] `BOARD_TYPE_SENTIENT_CUBE` Kconfig symbol same in Task 14 steps 6, 7, 8.

### Implementer batching (for subagent-driven-development)

Each batch = one fresh implementer subagent dispatch:

| Batch | Tasks | Character |
|---|---|---|
| 1 | 1-2 | Tag + infrastructure import — mechanical |
| 2 | 3-5 | xiaozhi /tmp clone + skeleton + copy — mechanical |
| 3 | 6-10 | Strip OTA/MCP/MQTT/wake-word + first build check — surgical, needs careful reading |
| 4 | 11-13 | Import overlay + port two components — mechanical moves |
| 5 | 14-15 | Board merge + final files in place — MOST surgical; expect re-iteration |
| 6 | 16-17 | Inline patches 0003 + 0004 — surgical, depends on Task 14 |
| 7 | 18-21 | Delete sentient/, retarget scripts + HIL, restore creds — mechanical |
| 8 | 22 | Build green — feedback loop until binary lands |
| 9 | 23-25 | Smoke — hardware-bound, flash budget tightest here |
| 10 | 26-28 | Memory + handover + chat post — documentation |
