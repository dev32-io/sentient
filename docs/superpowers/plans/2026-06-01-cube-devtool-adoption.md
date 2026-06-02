# Cube Devtool Adoption + Public Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sentient's stale in-tree `esp32/devtool/` snapshot with the public `dev32-io/esp32-devtool` repo consumed as a git submodule, keeping every cube devtool capability green on real hardware, and upstream cube's generic verbs (primitives + provider interfaces) so the public repo reaches production grade and stays board+project agnostic.

**Architecture:** Approach A — submodule swap first to a green baseline (every verb still cube-local on the public dispatcher), then incremental upstream PRs (primitives, then provider interfaces), then audit-gate + prod-strip + docs. Cross-repo: fixes authored on a branch inside the submodule, validated on the real cube, PR'd to dev32-io `main`, then the sentient submodule pointer is bumped. Each stage is gated on the real-cube e2e HIL matrix.

**Tech Stack:** git submodules; Python 3.11 + `uv run --script` (esp32-devtool CLI); ESP-IDF 5.5.2 + C++17 + `__attribute__((constructor))` verb auto-registration (companion); cJSON; pytest-embedded for HIL; Kconfig prod-strip.

**Spec:** `docs/superpowers/specs/2026-06-01-cube-devtool-adoption-design.md`

**Branch (sentient):** `feature/cube-devtool-adoption` (already checked out).
**Public repo working clone:** the submodule checkout at `esp32/devtool/` once Stage 0 lands; URL `https://github.com/dev32-io/esp32-devtool`.

---

## Working notes for the implementer

- **Real hardware, no faking.** Every stage gate runs the e2e HIL matrix on the physical cube over USB, agent-driven through `esp32-devtool`. No mocks. The operator provides the cube on `/dev/cu.usbmodem*`. Source the env first: `source scripts/env.sh`.
- **Flash discipline** (`.claude/rules/esp32/cube/flash-discipline.md`): edit-build-edit-build, ONE flash per stage gate. The daemon must be running before smoke — `bash esp32/cube/scripts/flash.sh` eager-spawns it.
- **AXP2101 PMIC fault** is the one un-automatable failure (boot-loop, `<<< READY` never arrives within 30s after a reflash). On that signature: stop, flag the operator for physical unplug + BOOT-hold replug. Do not retry-storm.
- **Cross-repo commits.** Submodule (public repo) commits land on a `fix/*` branch inside `esp32/devtool/`, get PR'd + merged to `main`, THEN sentient bumps the pointer (`git add esp32/devtool`). Never bump the pointer to an unmerged commit.
- **Verb auto-registration.** Companion verbs register via `__attribute__((constructor))` calling `devtool_register_verb(method, handler)`. The static lib needs `WHOLE_ARCHIVE` or the linker strips the constructors. The cube already sets this for `main/devtool_verbs/`; the companion component sets it for its own built-ins.
- **Provider injection pattern.** Hardware-touching capability = companion ships the verb + a provider setter; the board injects an impl. Existing precedent: `/audio/record` handler returns `audio_record_provider_unset` until the board registers one; cube wires providers + `extern "C" cube_*` shims in `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`.
- **Clean code** (`.claude/rules/esp32/cube/clean-code.md`): header ≤300 lines, impl ≤600 per class, functions ≤40 lines, snake_case, no magic numbers (Kconfig or config struct), RAII.
- **Config rule** (`.claude/rules/config.md`): tunables in YAML/Kconfig with inline comments, never hardcoded.

---

## File structure overview

### Sentient side

**Created:**
- `esp32/cube/devtool/boards/cube.yaml` — sentient-owned board manifest (moved out of the submodule)
- `esp32/cube/devtool/boards/README.md` — one-liner: why this dir exists, `ESP32_DEVTOOL_BOARDS_DIR` points here

**Modified:**
- `.gitmodules` — new (created by `git submodule add`)
- `scripts/env.sh` — add `ESP32_DEVTOOL_BOARDS_DIR` export
- `esp32/cube/firmware/main/idf_component.yml` — companion dep path unchanged; verb-list comment updated as buckets move
- `esp32/cube/firmware/main/CMakeLists.txt` — drop Bucket-1/2 verb `.cc` from `SOURCES` as they upstream
- `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` — register Bucket-2 providers via the new companion setters
- `esp32/cube/firmware/main/devtool_verbs/` — Bucket-1/2 files deleted; Bucket-3 + provider glue remain

**Deleted:**
- `esp32/devtool/` (the stale snapshot — replaced by the submodule at the same path)
- `esp32/cube/firmware/main/devtool_verbs/{log_level,mark,restart}.cc` (Stage 1)
- `esp32/cube/firmware/main/devtool_verbs/{wifi,ui,audio_misc,audio_play,audio_record_usb}.cc` (Stage 2; `audio_common.cc` folds into the provider glue)

### Public repo side (`esp32/devtool/` submodule)

**Created:**
- `firmware/esp32_devtool_companion/src/verbs/log_level.cc`, `mark.cc`, `restart.cc` (Bucket 1 built-ins)
- `firmware/esp32_devtool_companion/include/esp32_devtool/providers.h` (Bucket 2 provider setters)
- `firmware/esp32_devtool_companion/src/verbs/wifi.cc`, `ui.cc`, `audio_verbs.cc` (Bucket 2 verb dispatch)
- `scripts/audit_no_leakage.sh` (Stage 3 audit gate, wired into CI)

**Modified:**
- `firmware/esp32_devtool_companion/CMakeLists.txt` — add new verb sources
- `firmware/esp32_devtool_companion/Kconfig` — sub-options for new built-in verb groups (default y)
- `docs/BOARD-MANIFEST.md`, `docs/AGENTIC-WORKFLOW.md`, `firmware/esp32_devtool_companion/README.md` (Stage 4)

---

# Stage 0 — Submodule swap + config re-home → green baseline

Goal: cube boots + the full HIL matrix passes on the public component, every verb still cube-local. No verb moves yet.

---

### Task 1: Capture the pre-swap HIL baseline

**Files:** none (read-only smoke).

- [ ] **Step 1: Source env + confirm cube present**

Run:
```bash
source scripts/env.sh
esp32-devtool info
```
Expected: JSON with the cube's `device_id`, `ip`, `firmware`. If "no board detected", stop — operator must plug in the cube.

- [ ] **Step 2: Flash current firmware + run the full HIL suite (records the "known green" baseline)**

Run:
```bash
cd esp32/cube/tests/hil && python -m pytest -v 2>&1 | tee /tmp/hil-baseline.log; cd -
```
Expected: all current HIL tests pass (`test_sentient_audio_toggle`, `test_sentient_reconnect`, `test_sentient_bad_token`, `test_audio_record`, `test_audio_play_pcm`, `test_ws_recovery`, `test_smoke`, `test_voice_loop`). Save `/tmp/hil-baseline.log` — Stage 0 must reproduce this exact green set after the swap.

- [ ] **Step 3: Record current devtool snapshot commit for rollback**

Run:
```bash
git -C esp32/devtool rev-parse HEAD 2>/dev/null || echo "not a repo (plain snapshot)"
git rev-parse HEAD
```
Expected: notes the sentient HEAD (`feature/cube-devtool-adoption`) so the swap can be reverted in one `git checkout` if the baseline regresses.

---

### Task 2: Replace the stale snapshot with the submodule

**Files:**
- Delete: `esp32/devtool/` (snapshot)
- Create: `.gitmodules`

- [ ] **Step 1: Remove the stale snapshot from git**

Run:
```bash
git rm -r esp32/devtool
```
Expected: stages the deletion of the whole snapshot tree.

- [ ] **Step 2: Add the public repo as a submodule at the same path**

Run:
```bash
git submodule add https://github.com/dev32-io/esp32-devtool esp32/devtool
git -C esp32/devtool checkout main
```
Expected: `.gitmodules` created; `esp32/devtool/` now a submodule checkout of public `main`. The path is identical, so `scripts/env.sh` PATH prepend, `cube_dut.py` `DEVTOOL_BIN`, and `main/idf_component.yml`'s `path: ../../../devtool/firmware/esp32_devtool_companion` all still resolve.

- [ ] **Step 3: Verify the companion component path resolves**

Run:
```bash
test -f esp32/devtool/firmware/esp32_devtool_companion/CMakeLists.txt && echo "companion present" || echo "MISSING"
```
Expected: `companion present`.

- [ ] **Step 4: Verify the CLI shim runs from the submodule**

Run:
```bash
source scripts/env.sh
esp32-devtool --help 2>&1 | head -5
```
Expected: click help output (CLI runs via `uv run --script` from the submodule checkout). If `uv` errors on deps, that's an environment issue — surface it, do not vendor deps.

- [ ] **Step 5: Commit the swap (pointer + .gitmodules)**

```bash
git add .gitmodules esp32/devtool
git commit -m "chore(cube): adopt public esp32-devtool as submodule at esp32/devtool"
```

---

### Task 3: Re-home the cube board manifest outside the submodule

**Files:**
- Create: `esp32/cube/devtool/boards/cube.yaml`
- Create: `esp32/cube/devtool/boards/README.md`
- Modify: `scripts/env.sh`

- [ ] **Step 1: Create the sentient-owned board manifest**

Create `esp32/cube/devtool/boards/cube.yaml` (copied from the old snapshot, plus `build_artifact`):

```yaml
name: cube
display_name: "Sentient Cube (Waveshare ESP32-S3 AMOLED 2.16)"
chip: esp32-s3
firmware_path: esp32/cube/firmware
build_artifact: sentient_cube.elf      # ELF name in <firmware_path>/build/ — was hardcoded in gdb.py/audit pre-swap
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
  # Must match CONFIG_ESP32_DEVTOOL_LOG_RELAY_PORT in the companion Kconfig (default 9000).
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

> Note: the `verbs:` list stays as-is in Stage 0 (verbs are still cube-local). It is trimmed in Stages 1–2 only for verbs that fully move to companion built-ins; provider-backed verbs keep their entry because the verb name still exists.

- [ ] **Step 2: Create the dir README**

Create `esp32/cube/devtool/boards/README.md`:

```markdown
# Sentient cube board manifests

Board manifests for the public `esp32-devtool` CLI (consumed as a submodule at
`esp32/devtool/`). They live HERE, not in the submodule, so the public repo
stays board+project agnostic.

`scripts/env.sh` exports `ESP32_DEVTOOL_BOARDS_DIR` pointing at this dir; the
CLI's `active_boards_dir()` honors it over its bundled `boards/`.
```

- [ ] **Step 3: Export `ESP32_DEVTOOL_BOARDS_DIR` in env.sh**

In `scripts/env.sh`, the current devtool block is:
```bash
# esp32-devtool: unified ESP32 dev CLI
_DEVTOOL_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$_DEVTOOL_REPO_ROOT" ]; then
  export PATH="$_DEVTOOL_REPO_ROOT/esp32/devtool/bin:$PATH"
fi
unset _DEVTOOL_REPO_ROOT
```
Replace it with (export the boards dir BEFORE the `unset`):
```bash
# esp32-devtool: unified ESP32 dev CLI (consumed as a submodule)
_DEVTOOL_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$_DEVTOOL_REPO_ROOT" ]; then
  export PATH="$_DEVTOOL_REPO_ROOT/esp32/devtool/bin:$PATH"
  # Sentient-owned board manifests live outside the submodule so the public
  # repo stays board-agnostic. The CLI's active_boards_dir() honors this.
  export ESP32_DEVTOOL_BOARDS_DIR="$_DEVTOOL_REPO_ROOT/esp32/cube/devtool/boards"
fi
unset _DEVTOOL_REPO_ROOT
```

- [ ] **Step 4: Verify the CLI picks up the re-homed manifest**

Run:
```bash
source scripts/env.sh
esp32-devtool --help >/dev/null && echo "boards_dir=$ESP32_DEVTOOL_BOARDS_DIR"
esp32-devtool info
```
Expected: `ESP32_DEVTOOL_BOARDS_DIR` set to the new path; `info` still detects the cube (manifest resolved from the sentient tree, not the submodule). If `info` reports "manifest 'cube' not found", the boards-dir override isn't being read — check `active_boards_dir()` precedence.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/devtool/boards/cube.yaml esp32/cube/devtool/boards/README.md scripts/env.sh
git commit -m "feat(cube): re-home cube board manifest outside the devtool submodule"
```

---

### Task 4: Reconcile stale-snapshot CLI deltas against cube flows

**Files:** none (verification + targeted fixes only if a flow breaks).

The snapshot predates `cli/elf.py`, `active_boards_dir()`, the `board.py` refactor, and dropped `cli/commands/setup.py`. Verify each cube-exercised CLI flow still works on the public CLI.

- [ ] **Step 1: Exercise each capability flow**

Run (cube plugged in, daemon up):
```bash
source scripts/env.sh
esp32-devtool info
esp32-devtool cmd state
esp32-devtool screenshot --out /tmp/cube-shot.png && echo "screenshot ok"
esp32-devtool logs --since 5s 2>&1 | head -5
```
Expected: each returns without a CLI error. `cmd state` returns the device state JSON; `screenshot` writes a PNG.

- [ ] **Step 2: Confirm `build_artifact` resolves for gdb/audit paths**

Run:
```bash
esp32-devtool audit-prod-strip --dry-run 2>&1 | tail -10 || true
```
Expected: resolves `sentient_cube.elf` from the manifest's `build_artifact` (no hardcoded-elf error). If it errors that the ELF isn't built yet, that's fine for a dry run — the point is the NAME resolved from the manifest, not a `FileNotFound` on a hardcoded `sentient_cube.elf` literal.

- [ ] **Step 3: If any flow broke, author the fix upstream**

If a flow fails due to a snapshot↔public delta, fix it on a branch inside the submodule:
```bash
cd esp32/devtool && git checkout -b fix/cube-flow-reconcile
# edit cli/... ; cd back, rebuild/retest the flow
```
Push, PR to dev32-io `main`, merge, then bump the pointer (`git add esp32/devtool`). Record what broke in the commit body. If nothing broke, skip this step.

- [ ] **Step 4: Commit (only if a pointer bump or sentient-side change happened)**

```bash
git add esp32/devtool
git commit -m "fix(cube): reconcile devtool CLI deltas surfaced by submodule swap"
```

---

### Task 5: Stage 0 gate — full HIL matrix on the real cube

**Files:** none.

- [ ] **Step 1: Build + one flash**

Run:
```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -15; cd -
bash esp32/cube/scripts/flash.sh 2>&1 | tail -10
```
Expected: clean build (companion resolved from the submodule path); one successful flash; `<<< READY` appears. No AXP2101 fault.

- [ ] **Step 2: Run the full HIL matrix**

Run:
```bash
cd esp32/cube/tests/hil && python -m pytest -v 2>&1 | tee /tmp/hil-stage0.log; cd -
```
Expected: the SAME green set as `/tmp/hil-baseline.log` (Task 1). Diff the two pass lists:
```bash
diff <(grep -E "PASSED|FAILED" /tmp/hil-baseline.log) <(grep -E "PASSED|FAILED" /tmp/hil-stage0.log)
```
Expected: no diff. Any new red row is a swap regression — fix before proceeding.

- [ ] **Step 3: Commit the green-baseline marker**

```bash
git add esp32/devtool
git commit -m "test(cube): Stage 0 green — HIL matrix passes on public devtool submodule" --allow-empty
```

---

# Stage 1 — Upstream Bucket 1 primitives (`log_level`, `mark`, `restart`)

Goal: move three pure-primitive verbs into the companion as self-registering built-ins; cube stops registering them; matrix still green.

---

### Task 6: Move `log_level` + `mark` + `restart` into the companion (upstream PR)

**Files (in the `esp32/devtool/` submodule):**
- Create: `firmware/esp32_devtool_companion/src/verbs/log_level.cc`, `mark.cc`, `restart.cc`
- Modify: `firmware/esp32_devtool_companion/CMakeLists.txt`
- Modify: `firmware/esp32_devtool_companion/Kconfig`

- [ ] **Step 1: Branch the submodule**

Run:
```bash
cd esp32/devtool && git checkout -b feat/builtin-primitive-verbs && cd -
```

- [ ] **Step 2: Read the cube originals to port verbatim**

Run:
```bash
sed -n '1,60p' esp32/cube/firmware/main/devtool_verbs/log_level.cc
sed -n '1,60p' esp32/cube/firmware/main/devtool_verbs/mark.cc
sed -n '1,60p' esp32/cube/firmware/main/devtool_verbs/restart.cc
```
Expected: each is a small handler + a `__attribute__((constructor))` calling `devtool_register_verb("<name>", handler)`. These have zero board dependency (ESP log API, `esp_restart()`). Port the handler bodies unchanged into the new companion files; keep the same verb names and JSON shapes.

- [ ] **Step 3: Create the three companion verb files**

Create `firmware/esp32_devtool_companion/src/verbs/restart.cc` (template — port `log_level.cc` and `mark.cc` the same way, preserving their original handler bodies and JSON results):

```cpp
#include "esp32_devtool/verbs.h"

#include <cJSON.h>
#include <esp_log.h>
#include <esp_system.h>

namespace {
constexpr const char* TAG = "esp32_devtool.verb.restart";

int handle_restart(const cJSON* /*params*/, cJSON* out_result,
                   int* /*out_error_code*/, const char** /*out_error_msg*/) {
    ESP_LOGI(TAG, "restart requested via devtool verb");
    cJSON_AddStringToObject(out_result, "status", "restarting");
    // Flush response, then restart shortly after so the RSP line is emitted.
    esp_restart();
    return 0;
}

__attribute__((constructor)) void register_restart() {
    devtool_register_verb("restart", handle_restart);
}
}  // namespace
```

> Port `log_level.cc` (sets `esp_log_level_set` from `params.tag` + `params.level`) and `mark.cc` (emits a boundary log line from `params.label`) identically from the cube originals — same handler logic, same verb name, same result JSON.

- [ ] **Step 4: Register the new sources + WHOLE_ARCHIVE**

In `firmware/esp32_devtool_companion/CMakeLists.txt`, add the three files to the component's `SRCS`. Confirm the component already links with `WHOLE_ARCHIVE` (the constructors must survive). If it does not, add it:
```cmake
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--whole-archive" ${COMPONENT_LIB} "-Wl,--no-whole-archive")
```
Read the existing CMakeLists first; only add WHOLE_ARCHIVE if it's absent.

- [ ] **Step 5: Add Kconfig sub-option (gated, default y)**

In `firmware/esp32_devtool_companion/Kconfig`, inside the `if ESP32_DEVTOOL_COMPANION_ENABLE` block, add:
```kconfig
config ESP32_DEVTOOL_BUILTIN_PRIMITIVE_VERBS
    bool "Built-in primitive verbs (log_level, mark, restart)"
    default y
    help
        Self-registering board-agnostic verbs. Disable only if the host
        project provides its own implementations of these verb names.
```
Wrap the three new files' registration in `#if CONFIG_ESP32_DEVTOOL_BUILTIN_PRIMITIVE_VERBS` (or guard at the CMake source-list level).

- [ ] **Step 6: Build the companion standalone (catch port errors before cube)**

Run:
```bash
cd esp32/devtool && git add -A && git commit -m "feat(companion): built-in log_level/mark/restart verbs" && cd -
```
(The companion has no standalone build target separate from a host app; the real build check is the cube build in Task 7. Commit here so the PR is clean.)

---

### Task 7: Drop the cube-local primitives + wire to the companion built-ins

**Files (sentient):**
- Delete: `esp32/cube/firmware/main/devtool_verbs/log_level.cc`, `mark.cc`, `restart.cc`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt`

- [ ] **Step 1: Delete the cube copies**

Run:
```bash
git rm esp32/cube/firmware/main/devtool_verbs/log_level.cc \
       esp32/cube/firmware/main/devtool_verbs/mark.cc \
       esp32/cube/firmware/main/devtool_verbs/restart.cc
```

- [ ] **Step 2: Remove them from main/CMakeLists.txt SOURCES**

In `esp32/cube/firmware/main/CMakeLists.txt`, delete these three lines from the `list(APPEND SOURCES ...)` devtool_verbs block:
```cmake
    "devtool_verbs/log_level.cc"
    "devtool_verbs/restart.cc"
```
and (from the earlier block)
```cmake
    "devtool_verbs/mark.cc"
```

- [ ] **Step 3: Build — verify no duplicate-symbol + verbs still present**

Run:
```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -15; cd -
```
Expected: clean build. The companion now provides `log_level`/`mark`/`restart`; the cube no longer double-registers them (a duplicate registration would have logged `register_verb` warnings, not a link error, since names are strings — so verify at runtime in Task 8, not just here).

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "refactor(cube): drop local primitive verbs, use companion built-ins"
```

---

### Task 8: Stage 1 gate — merge upstream, bump pointer, HIL matrix

**Files (sentient):** submodule pointer.

- [ ] **Step 1: Push + PR + merge the companion branch**

Run:
```bash
cd esp32/devtool && git push -u origin feat/builtin-primitive-verbs && cd -
```
Open the PR on dev32-io/esp32-devtool, review for agnosticism (no sentient/cube strings in the new files), merge to `main`. Then:
```bash
cd esp32/devtool && git checkout main && git pull && cd -
```

- [ ] **Step 2: Bump the sentient submodule pointer to merged main**

Run:
```bash
git add esp32/devtool
git commit -m "chore(cube): bump devtool pointer — built-in primitive verbs"
```

- [ ] **Step 3: One flash + HIL matrix + per-verb probe (H8)**

Run:
```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10; cd -
bash esp32/cube/scripts/flash.sh 2>&1 | tail -8
esp32-devtool cmd restart   # H8: built-in verb answers
esp32-devtool cmd log_level --params '{"tag":"*","level":"info"}'
esp32-devtool cmd mark --params '{"label":"stage1-probe"}'
cd esp32/cube/tests/hil && python -m pytest -v 2>&1 | tee /tmp/hil-stage1.log; cd -
```
Expected: the three moved verbs answer identically through the companion; full matrix green (`diff` against `/tmp/hil-baseline.log` pass list shows no regression). `restart` reboots the cube — run it last among the probes or expect the reconnect.

- [ ] **Step 4: Commit the gate marker**

```bash
git commit --allow-empty -m "test(cube): Stage 1 green — primitives upstreamed, matrix passes"
```

---

# Stage 2 — Upstream Bucket 2 provider interfaces (wifi → ui → audio)

Goal: the verb + JSON contract move into the companion; the board injects a provider impl via a setter. Three independent sub-slices, each gated.

---

### Task 9: Define the companion provider-injection header

**Files (submodule):**
- Create: `firmware/esp32_devtool_companion/include/esp32_devtool/providers.h`

- [ ] **Step 1: Branch the submodule**

```bash
cd esp32/devtool && git checkout -b feat/provider-injected-verbs && cd -
```

- [ ] **Step 2: Read the existing provider precedent**

Run:
```bash
grep -rn "provider" esp32/devtool/firmware/esp32_devtool_companion/src/handlers/*.cc | head
sed -n '1,40p' esp32/devtool/firmware/esp32_devtool_companion/src/handlers/audio_record.cc
```
Expected: confirm the existing pattern — a handler calls an injected provider, returns `*_provider_unset` when none is set. Mirror it for verbs.

- [ ] **Step 3: Create `providers.h` with the three provider structs + setters**

Create `firmware/esp32_devtool_companion/include/esp32_devtool/providers.h`:

```cpp
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// --- wifi provider: backs the wifi.connect/disconnect/reconnect verbs ---
typedef struct {
    bool (*connect)(const char* ssid, const char* password);  // ssid/pw may be null → use stored creds
    bool (*disconnect)(void);
    bool (*reconnect)(void);
} devtool_wifi_provider_t;
void devtool_set_wifi_provider(const devtool_wifi_provider_t* p);

// --- ui provider: backs ui.dump_tree ---
// Writes a JSON-serializable UI tree as a string into dst (≤dst_cap). Returns
// bytes written, or 0 if unavailable. Implementation owns the LVGL lock.
typedef struct {
    size_t (*dump_tree)(char* dst, size_t dst_cap);
} devtool_ui_provider_t;
void devtool_set_ui_provider(const devtool_ui_provider_t* p);

// --- audio provider: backs audio.dump_state/play_pcm/test_tone ---
// (record_rms/record_pcm already route through the HTTP /audio/record provider.)
typedef struct {
    size_t (*dump_state)(char* dst, size_t dst_cap);                 // JSON string of codec/queue state
    bool   (*play_pcm)(const int16_t* samples, size_t count, int sample_rate);
    bool   (*test_tone)(int freq_hz, int duration_ms);
} devtool_audio_verb_provider_t;
void devtool_set_audio_verb_provider(const devtool_audio_verb_provider_t* p);

#ifdef __cplusplus
}
#endif
```

- [ ] **Step 4: Create the provider-storage TU**

Create `firmware/esp32_devtool_companion/src/providers.cc`:

```cpp
#include "esp32_devtool/providers.h"
#include <cstddef>

const devtool_wifi_provider_t*       g_wifi_provider  = nullptr;
const devtool_ui_provider_t*         g_ui_provider    = nullptr;
const devtool_audio_verb_provider_t* g_audio_provider = nullptr;

extern "C" void devtool_set_wifi_provider(const devtool_wifi_provider_t* p)  { g_wifi_provider = p; }
extern "C" void devtool_set_ui_provider(const devtool_ui_provider_t* p)      { g_ui_provider = p; }
extern "C" void devtool_set_audio_verb_provider(const devtool_audio_verb_provider_t* p) { g_audio_provider = p; }
```

Add a `src/providers_internal.h` exposing the three `extern` globals for the verb TUs:
```cpp
#pragma once
#include "esp32_devtool/providers.h"
extern const devtool_wifi_provider_t*       g_wifi_provider;
extern const devtool_ui_provider_t*         g_ui_provider;
extern const devtool_audio_verb_provider_t* g_audio_provider;
```

- [ ] **Step 5: Commit the header (verbs added in Tasks 10–12)**

```bash
cd esp32/devtool && git add -A && git commit -m "feat(companion): provider-injection header for wifi/ui/audio verbs" && cd -
```

---

### Task 10: Sub-slice A — wifi verbs upstream + cube provider

**Files (submodule):** Create `firmware/esp32_devtool_companion/src/verbs/wifi.cc`, modify `CMakeLists.txt`.
**Files (sentient):** Delete `devtool_verbs/wifi.cc`; modify `sentient_cube.cc` + `main/CMakeLists.txt`.

- [ ] **Step 1: Read the cube wifi verb original**

Run:
```bash
cat esp32/cube/firmware/main/devtool_verbs/wifi.cc
```
Expected: three handlers (`wifi.connect/disconnect/reconnect`) + constructor registrations. Note the exact body of each (which board API they call) — that body becomes the cube provider impl.

- [ ] **Step 2: Create the companion wifi verb dispatch**

Create `firmware/esp32_devtool_companion/src/verbs/wifi.cc`:

```cpp
#include "esp32_devtool/verbs.h"
#include "../providers_internal.h"

#include <cJSON.h>
#include <esp_log.h>

namespace {
constexpr const char* TAG = "esp32_devtool.verb.wifi";

int do_connect(const cJSON* params, cJSON* out, int* ec, const char** em) {
    if (g_wifi_provider == nullptr || g_wifi_provider->connect == nullptr) {
        *ec = -32010; *em = "wifi_provider_unset"; return -1;
    }
    const cJSON* ssid = cJSON_GetObjectItem(params, "ssid");
    const cJSON* pw   = cJSON_GetObjectItem(params, "password");
    bool ok = g_wifi_provider->connect(
        cJSON_IsString(ssid) ? ssid->valuestring : nullptr,
        cJSON_IsString(pw)   ? pw->valuestring   : nullptr);
    cJSON_AddBoolToObject(out, "ok", ok);
    return ok ? 0 : -1;
}
int do_disconnect(const cJSON*, cJSON* out, int* ec, const char** em) {
    if (g_wifi_provider == nullptr || g_wifi_provider->disconnect == nullptr) {
        *ec = -32010; *em = "wifi_provider_unset"; return -1;
    }
    cJSON_AddBoolToObject(out, "ok", g_wifi_provider->disconnect());
    return 0;
}
int do_reconnect(const cJSON*, cJSON* out, int* ec, const char** em) {
    if (g_wifi_provider == nullptr || g_wifi_provider->reconnect == nullptr) {
        *ec = -32010; *em = "wifi_provider_unset"; return -1;
    }
    cJSON_AddBoolToObject(out, "ok", g_wifi_provider->reconnect());
    return 0;
}

__attribute__((constructor)) void register_wifi() {
    devtool_register_verb("wifi.connect", do_connect);
    devtool_register_verb("wifi.disconnect", do_disconnect);
    devtool_register_verb("wifi.reconnect", do_reconnect);
}
}  // namespace
```

Add `src/verbs/wifi.cc` + `src/providers.cc` to the companion `CMakeLists.txt` SRCS. Commit in the submodule branch.

- [ ] **Step 3: Wire the cube wifi provider in sentient_cube.cc**

In `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`, add a provider struct whose members are the bodies from the old `devtool_verbs/wifi.cc` handlers, and register it after `esp32_devtool_companion_start(...)`:

```cpp
#include "esp32_devtool/providers.h"

static bool cube_wifi_connect(const char* ssid, const char* password) {
    // body ported from the old devtool_verbs/wifi.cc wifi.connect handler
    // (calls the cube WiFi stack; null ssid/pw → stored creds)
    return /* ...ported... */ false;
}
static bool cube_wifi_disconnect(void) { /* ...ported... */ return false; }
static bool cube_wifi_reconnect(void)  { /* ...ported... */ return false; }

static const devtool_wifi_provider_t kCubeWifiProvider = {
    .connect = cube_wifi_connect,
    .disconnect = cube_wifi_disconnect,
    .reconnect = cube_wifi_reconnect,
};
// In the companion-start path:
devtool_set_wifi_provider(&kCubeWifiProvider);
```
Port the real handler bodies verbatim from the deleted file — do not stub.

- [ ] **Step 4: Delete the cube wifi verb file + drop from CMake**

```bash
git rm esp32/cube/firmware/main/devtool_verbs/wifi.cc
```
Remove `"devtool_verbs/wifi.cc"` from `main/CMakeLists.txt`.

- [ ] **Step 5: Build**

```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -15; cd -
```
Expected: clean build; `devtool_set_wifi_provider` resolves from the companion header.

- [ ] **Step 6: Commit (sentient side; submodule branch already committed)**

```bash
git add -u esp32/cube/firmware
git commit -m "refactor(cube): wifi verbs via companion provider injection"
```

---

### Task 11: Sub-slice B — ui.dump_tree upstream + cube provider

**Files:** mirror Task 10 for `ui.dump_tree` using `devtool_ui_provider_t`.

- [ ] **Step 1: Read the cube original**

```bash
cat esp32/cube/firmware/main/devtool_verbs/ui.cc
```
Note the `ui.dump_tree` handler body (LVGL tree walk → JSON string; takes the LVGL lock).

- [ ] **Step 2: Create the companion ui verb**

Create `firmware/esp32_devtool_companion/src/verbs/ui.cc` (in the submodule branch):

```cpp
#include "esp32_devtool/verbs.h"
#include "../providers_internal.h"

#include <cJSON.h>

namespace {
constexpr size_t kUiDumpCap = 8192;

int do_dump_tree(const cJSON*, cJSON* out, int* ec, const char** em) {
    if (g_ui_provider == nullptr || g_ui_provider->dump_tree == nullptr) {
        *ec = -32011; *em = "ui_provider_unset"; return -1;
    }
    static char buf[kUiDumpCap];
    size_t n = g_ui_provider->dump_tree(buf, sizeof(buf));
    if (n == 0) { *ec = -32011; *em = "ui_dump_failed"; return -1; }
    cJSON* tree = cJSON_Parse(buf);
    if (tree == nullptr) { cJSON_AddStringToObject(out, "raw", buf); }
    else { cJSON_AddItemToObject(out, "tree", tree); }
    return 0;
}

__attribute__((constructor)) void register_ui() {
    devtool_register_verb("ui.dump_tree", do_dump_tree);
}
}  // namespace
```
Add to companion CMake SRCS. Commit the submodule branch.

- [ ] **Step 3: Wire the cube ui provider**

In `sentient_cube.cc`, add `cube_ui_dump_tree(char* dst, size_t cap)` (body ported from the old `ui.cc`), register `devtool_ui_provider_t{ .dump_tree = cube_ui_dump_tree }` via `devtool_set_ui_provider(...)`.

- [ ] **Step 4: Delete cube ui.cc + drop from CMake**

```bash
git rm esp32/cube/firmware/main/devtool_verbs/ui.cc
```
Remove `"devtool_verbs/ui.cc"` from `main/CMakeLists.txt`.

- [ ] **Step 5: Build + commit**

```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -15; cd -
git add -u esp32/cube/firmware
git commit -m "refactor(cube): ui.dump_tree via companion provider injection"
```

---

### Task 12: Sub-slice C — audio verbs upstream + cube provider

**Files:** mirror Task 10 for `audio.dump_state/play_pcm/test_tone` using `devtool_audio_verb_provider_t`.

- [ ] **Step 1: Read the cube originals**

```bash
cat esp32/cube/firmware/main/devtool_verbs/audio_misc.cc
cat esp32/cube/firmware/main/devtool_verbs/audio_play.cc
sed -n '1,60p' esp32/cube/firmware/main/devtool_verbs/audio_common.cc
```
Note: `audio.dump_state` + `audio.test_tone` live in `audio_misc.cc`; `audio.play_pcm` in `audio_play.cc`; `audio_common.cc` is shared helpers (no constructors). `audio.record_rms/record_pcm` in `audio_record_usb.cc` — these already have an HTTP `/audio/record` path; decide per Step 4 whether the USB-CDC verb variants also move or stay.

- [ ] **Step 2: Create the companion audio verb dispatch**

Create `firmware/esp32_devtool_companion/src/verbs/audio_verbs.cc` (submodule branch) with `audio.dump_state`, `audio.play_pcm`, `audio.test_tone` handlers calling `g_audio_provider` (return `audio_verb_provider_unset` when null), registered via constructor. Add to CMake SRCS. Commit the branch.

- [ ] **Step 3: Wire the cube audio verb provider**

In `sentient_cube.cc`, the cube already has `sentient_play_pcm_provider` / `sentient_record_pcm_provider` (lines ~132–143). Add `cube_audio_dump_state` + `cube_audio_test_tone` (ported from `audio_misc.cc`), then register:
```cpp
static const devtool_audio_verb_provider_t kCubeAudioVerbProvider = {
    .dump_state = cube_audio_dump_state,
    .play_pcm   = /* wrap existing sentient_play_pcm_provider */,
    .test_tone  = cube_audio_test_tone,
};
devtool_set_audio_verb_provider(&kCubeAudioVerbProvider);
```

- [ ] **Step 4: Decide record_rms/record_pcm + delete moved cube files**

`audio.record_rms/record_pcm` (USB-CDC verbs) overlap the HTTP `/audio/record` provider. For this phase, KEEP them cube-local (they're a USB-transport convenience, not in the agnostic-primitive set) unless the upstream review wants them — log the decision. Delete only the fully-moved files:
```bash
git rm esp32/cube/firmware/main/devtool_verbs/audio_misc.cc \
       esp32/cube/firmware/main/devtool_verbs/audio_play.cc
```
Keep `audio_record_usb.cc` + `audio_common.cc` (record path stays). Remove the two deleted entries from `main/CMakeLists.txt`.

- [ ] **Step 5: Build + commit**

```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -15; cd -
git add -u esp32/cube/firmware
git commit -m "refactor(cube): audio dump_state/play_pcm/test_tone via companion provider"
```

---

### Task 13: Merge Bucket-2 upstream + bump pointer

**Files (sentient):** submodule pointer.

- [ ] **Step 1: Push + PR + agnostic review + merge**

```bash
cd esp32/devtool && git push -u origin feat/provider-injected-verbs && cd -
```
PR review focus: do `providers.h` interfaces read board-agnostic? Run the second-consumer thought-test — could a non-cube ESP32 board implement `devtool_wifi_provider_t` / `devtool_ui_provider_t` / `devtool_audio_verb_provider_t` without cube assumptions? If any field smells cube-shaped, revise before merge. Then merge to `main`.

- [ ] **Step 2: Bump the pointer**

```bash
cd esp32/devtool && git checkout main && git pull && cd -
git add esp32/devtool
git commit -m "chore(cube): bump devtool pointer — provider-injected wifi/ui/audio verbs"
```

---

### Task 14: Stage 2 gate — flash + HIL matrix + per-verb H8 probe

**Files:** none.

- [ ] **Step 1: One flash**

```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py build 2>&1 | tail -10; cd -
bash esp32/cube/scripts/flash.sh 2>&1 | tail -8
```

- [ ] **Step 2: Probe every moved verb (H8) + run matrix**

```bash
esp32-devtool cmd wifi.reconnect
esp32-devtool cmd ui.dump_tree 2>&1 | head -5
esp32-devtool cmd audio.dump_state 2>&1 | head -5
esp32-devtool cmd audio.test_tone --params '{"freq_hz":440,"duration_ms":200}'
cd esp32/cube/tests/hil && python -m pytest -v 2>&1 | tee /tmp/hil-stage2.log; cd -
```
Expected: each provider-backed verb answers identically to pre-move; no `*_provider_unset` errors (providers registered at boot); full matrix green vs baseline pass list.

- [ ] **Step 3: Commit the gate marker**

```bash
git commit --allow-empty -m "test(cube): Stage 2 green — provider verbs upstreamed, matrix passes"
```

---

# Stage 3 — Audit gate + prod-strip

---

### Task 15: Add the leakage audit gate to the public repo

**Files (submodule):**
- Create: `scripts/audit_no_leakage.sh`
- Modify: `.github/workflows/*.yml` (CI)

- [ ] **Step 1: Branch + write the audit script**

```bash
cd esp32/devtool && git checkout -b chore/leakage-audit-gate && cd -
```
Create `esp32/devtool/scripts/audit_no_leakage.sh`:

```bash
#!/usr/bin/env bash
# Fails if any board/project-specific string leaks outside examples/.
# Asserts the repo stays board+project agnostic (sentient cube adoption gate).
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERNS='sentient|sentient_cube|hacore|\.sentient|hermes'
# examples/ is the sanctioned home for consumer-specific reference manifests.
HITS=$(grep -rniE "$PATTERNS" \
        --exclude-dir=examples \
        --exclude-dir=.git \
        --exclude-dir=.venv \
        --exclude-dir=__pycache__ \
        --exclude-dir=.pytest_cache \
        --exclude-dir=.ruff_cache \
        . || true)

if [ -n "$HITS" ]; then
  echo "LEAKAGE AUDIT FAILED — board/project strings outside examples/:"
  echo "$HITS"
  exit 1
fi
echo "leakage audit clean"
```

- [ ] **Step 2: Run it — fix any real leaks**

```bash
chmod +x esp32/devtool/scripts/audit_no_leakage.sh
bash esp32/devtool/scripts/audit_no_leakage.sh
```
Expected: `leakage audit clean`. If it flags something (e.g. a stray `sentient` in a comment from the extraction), fix it in this branch — that's exactly the leak the gate exists to catch.

- [ ] **Step 3: Wire into CI**

Add a step to the public repo's CI workflow that runs `bash scripts/audit_no_leakage.sh`. Read the existing `.github/workflows/` first and match its job structure.

- [ ] **Step 4: Commit the submodule branch**

```bash
cd esp32/devtool && git add -A && git commit -m "chore: leakage audit gate (board/project agnostic guard)" && cd -
```

---

### Task 16: Verify prod-strip → zero companion footprint

**Files:** none (verification; fix only if the strip leaks).

- [ ] **Step 1: Build the cube prod profile**

Run:
```bash
source scripts/env.sh
cd esp32/cube/firmware && idf.py -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.prod" build 2>&1 | tail -15; cd -
```
Expected: clean build with `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` (set in `sdkconfig.defaults.prod`). The companion compiles to its stub (`companion_stub.cc`).

- [ ] **Step 2: Run the prod-strip audit**

Run:
```bash
esp32-devtool audit-prod-strip 2>&1 | tail -20
```
Expected: passes — confirms the `CONFIG_ESP32_DEVTOOL_COMPANION_ENABLE=n` branch strips companion symbols (HTTP server, verb dispatcher, handlers) to zero footprint via `sentient_cube.elf`. If symbols survive (gating bug), the audit names them — fix the `#if`/stub gating in the companion (upstream branch) before declaring Stage 3 done.

- [ ] **Step 3: Merge audit branch + bump pointer**

```bash
cd esp32/devtool && git push -u origin chore/leakage-audit-gate && cd -
# PR → CI green (audit runs) → merge main
cd esp32/devtool && git checkout main && git pull && cd -
git add esp32/devtool
git commit -m "chore(cube): bump devtool pointer — leakage audit gate + prod-strip verified"
```

---

# Stage 4 — Upstream docs

---

### Task 17: Update public repo docs with adoption learnings

**Files (submodule):**
- Modify: `docs/BOARD-MANIFEST.md`, `docs/AGENTIC-WORKFLOW.md`, `firmware/esp32_devtool_companion/README.md`

- [ ] **Step 1: Branch + document the external-boards-dir adoption recipe**

```bash
cd esp32/devtool && git checkout -b docs/adoption-recipe && cd -
```
In `docs/AGENTIC-WORKFLOW.md` (or `docs/BOARD-MANIFEST.md`), add a section "Adopting as a submodule" capturing the sentient pattern: submodule at a fixed path, sentient-owned boards dir via `ESP32_DEVTOOL_BOARDS_DIR`, `build_artifact` in the manifest. Use the real sentient layout as the worked example (genericized — no `sentient` strings, so it passes the audit gate).

- [ ] **Step 2: Document the provider-injection extension pattern**

In `firmware/esp32_devtool_companion/README.md`, add a "Provider-injected verbs" section: how a host board implements `devtool_wifi_provider_t` / `devtool_ui_provider_t` / `devtool_audio_verb_provider_t` and registers via the setters, mirroring the existing HTTP provider docs. Include a minimal code example.

- [ ] **Step 3: Run the audit gate over the new docs**

```bash
bash esp32/devtool/scripts/audit_no_leakage.sh
```
Expected: `leakage audit clean` (docs use generic board names, not `sentient`).

- [ ] **Step 4: Merge + bump pointer**

```bash
cd esp32/devtool && git add -A && git commit -m "docs: submodule-adoption recipe + provider-injection guide" && git push -u origin docs/adoption-recipe && cd -
# PR → merge main
cd esp32/devtool && git checkout main && git pull && cd -
git add esp32/devtool
git commit -m "chore(cube): bump devtool pointer — adoption + provider docs"
```

---

### Task 18: Final gate + handover

**Files:**
- Create: `docs/superpowers/handovers/2026-06-01-cube-devtool-adoption.md`

- [ ] **Step 1: Full done-gate verification**

Run:
```bash
source scripts/env.sh
# 1. fresh-clone submodule integrity
git submodule update --init --recursive
# 2. cube builds clean (debug)
cd esp32/cube/firmware && idf.py build 2>&1 | tail -8; cd -
# 3. final flash + full HIL matrix
bash esp32/cube/scripts/flash.sh 2>&1 | tail -8
cd esp32/cube/tests/hil && python -m pytest -v 2>&1 | tee /tmp/hil-final.log; cd -
# 4. leakage audit
bash esp32/devtool/scripts/audit_no_leakage.sh
# 5. prod-strip
esp32-devtool audit-prod-strip 2>&1 | tail -5
# 6. sentient CI
bun run ci 2>&1 | tail -15
```
Expected: all green — matrix passes (H1–H9), audit clean, prod-strip passes, `bun run ci` green. Submodule pinned to a merged `main` commit.

- [ ] **Step 2: Write the handover**

Create `docs/superpowers/handovers/2026-06-01-cube-devtool-adoption.md` recording: final submodule commit pinned, verbs moved (Bucket 1 + 2) vs kept cube-local (Bucket 3 + record verbs), flash count, any AXP2101 events, open follow-ups (e.g. PyPI publish to enable `uvx`, record_rms/record_pcm upstream decision).

- [ ] **Step 3: Commit handover**

```bash
git add docs/superpowers/handovers/2026-06-01-cube-devtool-adoption.md
git commit -m "docs(cube): devtool adoption handover"
```

- [ ] **Step 4: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` to decide merge/PR for `feature/cube-devtool-adoption` into `develop`.

---

## Self-review notes

- **Spec coverage:** Stage 0 (swap + re-home + reconcile) → Tasks 2–5; agnostic audit gate → Task 15; verb buckets (primitives/providers/cube-side) → Tasks 6–14; cross-repo edit-in-submodule→PR→bump → every upstream task; HIL matrix gate per stage → Tasks 5, 8, 14, 18; prod-strip → Task 16; upstream docs → Task 17; done gate → Task 18. All spec sections mapped.
- **Real-device discipline:** every gate flashes once and runs the matrix on the physical cube; flash-discipline + AXP2101 escape hatch carried in working notes.
- **Known soft spots (resolve at execution):** ported handler bodies in `sentient_cube.cc` providers (Tasks 10–12) must be copied verbatim from the deleted verb files — the plan marks them `/* ...ported... */` because the exact bodies live in files to be read at execution time, not invented here. The `record_rms/record_pcm` upstream-vs-keep decision is deferred to Task 12 Step 4 with a logged default (keep cube-local).
