# Cube Build Reproducibility + Migration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cube firmware build reproducibly from a fresh clone — no patches on third-party components, no absolute-path deps, documented lock policy — by deleting the redundant esp-ml307 cert patch + dead modem code and moving TLS to a uniform `esp_crt_bundle` path.

**Architecture:** Replace the embedded-dev-cert + redundant `EspSsl::SetCacert` apparatus with `esp_crt_bundle` (prod verifies Let's Encrypt; debug skips verification via a new Kconfig). Then drop the now-unused `78/esp-ml307` dependency, its dead modem-board files, and the fragile `.gitignore`-tracked patch. Keep `dependencies.lock` gitignored (IDF official for local-path-dep projects); tighten manifest pins; audit for sibling migration gaps.

**Tech Stack:** ESP-IDF 5.5.2, C++17, `esp_websocket_client`, `esp_crt_bundle` (mbedTLS certificate bundle), Kconfig build profiles, ESP-IDF Component Manager.

**Spec:** `docs/superpowers/specs/2026-06-01-cube-build-reproducibility-design.md`

**Branch:** `feature/cube-build-reproducibility` off `develop` — a prerequisite that lands before the paused devtool-adoption work.

---

## Working notes for the implementer

- **Build-safe ordering (differs from spec's W-numbering).** `sentient_cube.cc` (SetCacert) AND `ml307_board.cc`/`dual_network_board.cc` both consume `78/esp-ml307`. The dependency can only be dropped once ALL three stop using it. So: rewrite TLS (W1) → delete dead modem files (W2 code) → drop the dependency + gitignore + tracked files (W2 deps). The firmware build at the end of the range is the gate.
- **Firmware build is slow + hardware-gated.** Edit-edit-edit then build ONCE per smoke-bar unit (`.claude/rules/esp32/cube/flash-discipline.md`). The "test" for firmware tasks is a clean `idf.py build`; the final gate is a flash + real-hardware TLS check.
- **ESP-IDF env:** `cd ~/esp/esp-idf && source export.sh` then return to `esp32/cube/firmware` before `idf.py`. Also `source scripts/env.sh` from repo root for `esp32-devtool`.
- **Clean-code (`.claude/rules/esp32/cube/clean-code.md`):** snake_case, `constexpr` over `#define`, functions ≤40 lines, no magic numbers.
- **This worktree starts in a broken build state** (wiped `managed_components`, a foreign-path `dependencies.lock` copied in during investigation). Task 1 cleans it.

---

## File structure overview

**Modified:**
- `esp32/cube/firmware/sdkconfig.defaults` — add `CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y`
- `esp32/cube/firmware/sdkconfig.defaults.debug` — add `CONFIG_CUBE_DEV_TLS_INSECURE=y`
- `esp32/cube/firmware/main/Kconfig.projbuild` — add `config CUBE_DEV_TLS_INSECURE`
- `esp32/cube/firmware/main/protocols/sentient_ws_protocol.h` — replace `cert_pem`/`skip_tls_cn_check` with `use_crt_bundle` + `insecure_skip_verify`
- `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc` — wire `crt_bundle_attach` / insecure path
- `esp32/cube/firmware/main/application.cc` — replace the `SENTIENT_DEV_TLS_PIN` cert wiring with the bundle/insecure config
- `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` — delete the `esp/esp_ssl.h` include, the cert externs, the `SetCacert` block
- `esp32/cube/firmware/main/CMakeLists.txt` — drop ml307 SOURCES, the `78__esp-ml307` PRIV_REQUIRES + `ML307_DIR` include coupling, the EMBED_TXTFILES dev-cert block
- `esp32/cube/firmware/main/idf_component.yml` — remove `78/esp-ml307`; tighten any wildcard pins
- `esp32/cube/.gitignore` — remove the esp-ml307 negation block
- `esp32/cube/scripts/bake-creds.sh` — remove the openssl cert-extraction block + TLS_PIN emission
- `.claude/rules/esp32/cube/build.md` — document the lock policy

**Deleted:**
- `esp32/cube/firmware/main/boards/common/ml307_board.cc`, `ml307_board.h`
- `esp32/cube/firmware/main/boards/common/dual_network_board.cc`, `dual_network_board.h`
- `esp32/cube/firmware/main/managed_components/78__esp-ml307/src/esp/esp_ssl.{h,cc}` (git rm --cached; the tree dies with the gitignore change)

---

### Task 1: Clean the broken build state + branch

**Files:** none (git + build hygiene).

- [ ] **Step 1: Create the branch off develop**

The build-repro work is a prerequisite; it should not carry the adoption commits. From the worktree:
```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk
git stash --include-untracked   # park the in-flight reconnect-fix edits + any junk
git checkout develop
git checkout -b feature/cube-build-reproducibility
git stash pop                    # restore the reconnect-fix edits onto the new branch
```
Expected: on `feature/cube-build-reproducibility`. (The reconnect-fix edits in `application.cc`/`application.h` ride along; they belong to the separate green-baseline work and stay uncommitted here — do not commit them in this plan.)

> If `git stash pop` conflicts, resolve in favor of the stashed (reconnect-fix) edits — they are the only intentional uncommitted changes.

- [ ] **Step 2: Remove the foreign-path lock + wiped managed_components residue**

```bash
cd esp32/cube/firmware
rm -f dependencies.lock
rm -rf managed_components build
```
Expected: clean firmware tree, no stale lock/components.

- [ ] **Step 3: Restore the tracked esp_ssl files so the tree matches HEAD (they're deleted in Task 6)**

```bash
git checkout -- managed_components/78__esp-ml307/src/esp/esp_ssl.h managed_components/78__esp-ml307/src/esp/esp_ssl.cc 2>/dev/null || true
git status --short esp32/cube/firmware/managed_components 2>/dev/null | head
```
Expected: the two tracked files restored (or already gone if not in this branch's HEAD). This keeps the tree consistent before the deliberate removal in Task 6.

- [ ] **Step 4: Commit the branch point marker (empty, documents the starting state)**

No file change — skip the commit; proceed to Task 2. (The branch is created; first real commit is Task 2.)

---

### Task 2: Add the TLS Kconfig + certificate-bundle sdkconfig

**Files:**
- Modify: `esp32/cube/firmware/main/Kconfig.projbuild`
- Modify: `esp32/cube/firmware/sdkconfig.defaults`
- Modify: `esp32/cube/firmware/sdkconfig.defaults.debug`

- [ ] **Step 1: Find the existing CUBE_DEV Kconfig block**

Run:
```bash
grep -rn "CUBE_DEV_AGGRESSIVE_POWER_SAVE\|CUBE_DEV_LOW_BRIGHTNESS" esp32/cube/firmware/main/Kconfig.projbuild
```
Expected: the `config CUBE_DEV_AGGRESSIVE_POWER_SAVE` / `CUBE_DEV_LOW_BRIGHTNESS_PERCENT` entries. Add the new TLS config beside them. If they live in a different Kconfig file, add there instead (match the location).

- [ ] **Step 2: Add `config CUBE_DEV_TLS_INSECURE`**

Beside the existing `CUBE_DEV_*` entries in `esp32/cube/firmware/main/Kconfig.projbuild`:
```kconfig
config CUBE_DEV_TLS_INSECURE
    bool "Skip TLS server-cert verification (debug only)"
    default n
    help
        Debug builds dial the local macOS gateway over WSS with a
        self-signed localhost cert that is not in any public CA bundle.
        Enabling this skips server-certificate verification entirely.
        MUST stay off in prod — prod verifies the gateway's Let's Encrypt
        cert via the esp_crt_bundle (CONFIG_MBEDTLS_CERTIFICATE_BUNDLE).
```

- [ ] **Step 3: Enable the certificate bundle in the base sdkconfig (both profiles)**

Append to `esp32/cube/firmware/sdkconfig.defaults`:
```
# TLS: verify the gateway cert against the Mozilla root bundle (includes
# Let's Encrypt ISRG Root X1). Prod uses this; debug skips verification
# via CONFIG_CUBE_DEV_TLS_INSECURE. Uniform across profiles for simpler logic.
CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y
CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL=y
```

- [ ] **Step 4: Turn on insecure-skip in the debug profile**

Append to `esp32/cube/firmware/sdkconfig.defaults.debug`:
```
# Debug dials the local macOS gateway (self-signed localhost cert).
CONFIG_CUBE_DEV_TLS_INSECURE=y
```

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/Kconfig.projbuild esp32/cube/firmware/sdkconfig.defaults esp32/cube/firmware/sdkconfig.defaults.debug
git commit -m "feat(cube/tls): add esp_crt_bundle + CUBE_DEV_TLS_INSECURE Kconfig"
```

---

### Task 3: Rewire SentientWsProtocol TLS config to bundle / insecure

**Files:**
- Modify: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.h`
- Modify: `esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc`

- [ ] **Step 1: Replace the TLS fields in the config struct**

In `sentient_ws_protocol.h`, replace the existing block:
```cpp
    // TLS: when wss:// is used, pin the gateway cert by passing a null-
    // terminated PEM string here (debug profile embeds the dev cert via
    // EMBED_TXTFILES). Leave null to fall back to esp_websocket_client's
    // global CA bundle.
    const char* cert_pem = nullptr;
    // When true, mbedtls skips Subject/SAN matching against the dial host.
    // Use only with a pinned cert in debug profile — the dev cert's SAN is
    // localhost+127.0.0.1 but cube dials the Mac's LAN IP.
    bool skip_tls_cn_check = false;
```
with:
```cpp
    // TLS verification strategy. Prod: verify the gateway's (Let's Encrypt)
    // cert against the embedded mbedTLS certificate bundle. Debug: skip
    // verification (local gateway serves a self-signed localhost cert).
    // Exactly one of these is active per build profile.
    bool use_crt_bundle = true;
    bool insecure_skip_verify = false;
```

- [ ] **Step 2: Add the esp_crt_bundle include to the impl**

In `sentient_ws_protocol.cc`, add near the existing includes:
```cpp
#include <esp_crt_bundle.h>
```

- [ ] **Step 3: Replace the cert application block**

In `sentient_ws_protocol.cc`, replace:
```cpp
    if (cfg_.cert_pem != nullptr) {
        ws_cfg.cert_pem = cfg_.cert_pem;
    }
    if (cfg_.skip_tls_cn_check) {
        ws_cfg.skip_cert_common_name_check = true;
    }
```
with:
```cpp
    if (cfg_.insecure_skip_verify) {
        // Debug: no CA attached → esp-tls performs no server-cert
        // verification. LAN-dev only; never reaches a prod build.
        ESP_LOGW(TAG, "tls: INSECURE — server cert verification disabled (debug)");
    } else if (cfg_.use_crt_bundle) {
        ws_cfg.crt_bundle_attach = esp_crt_bundle_attach;
        ESP_LOGI(TAG, "tls: verifying via esp_crt_bundle");
    }
```

> Plan-time verification (W1 risk in the spec): confirm on a real debug build that leaving `crt_bundle_attach`/`cert_pem` unset yields a successful insecure WSS handshake against the macOS gateway. If this esp_websocket_client / IDF 5.5.2 build instead REQUIRES an explicit insecure flag, set the documented one here (e.g. an esp-tls `skip_common_name` is NOT sufficient — it must skip chain verification). Capture the working mechanism in the commit message. Do not proceed to flash-gate until the handshake succeeds.

- [ ] **Step 4: Build the component in isolation is not possible; defer build to Task 7. Commit.**

```bash
git add esp32/cube/firmware/main/protocols/sentient_ws_protocol.h esp32/cube/firmware/main/protocols/sentient_ws_protocol.cc
git commit -m "refactor(cube/ws): TLS via crt_bundle / insecure-skip, drop cert_pem pinning"
```

---

### Task 4: Replace the application.cc cert wiring

**Files:**
- Modify: `esp32/cube/firmware/main/application.cc`

- [ ] **Step 1: Remove the top-of-file SENTIENT_DEV_TLS_PIN block**

In `application.cc`, delete the block at ~line 43:
```cpp
#if SENTIENT_DEV_TLS_PIN
...
#endif
```
(Read lines 40-50 first to capture the exact span; it is a short conditional around dev-cert-related declarations. If the only thing inside is dev-cert plumbing, remove the whole `#if/#endif`.)

- [ ] **Step 2: Replace the InitializeSentientWs cert wiring**

Replace:
```cpp
#if SENTIENT_DEV_TLS_PIN
    extern const char dev_cert_pem_start[] asm("_binary_sentient_dev_gateway_crt_start");
    cfg.cert_pem = dev_cert_pem_start;
    // Dev cert SAN is localhost+127.0.0.1; cube dials the Mac's LAN IP, so
    // SAN match will fail. Cert is still pinned — just skip the name check.
    cfg.skip_tls_cn_check = true;
#endif
```
with:
```cpp
#if CONFIG_CUBE_DEV_TLS_INSECURE
    cfg.use_crt_bundle = false;
    cfg.insecure_skip_verify = true;
#else
    cfg.use_crt_bundle = true;
    cfg.insecure_skip_verify = false;
#endif
```

- [ ] **Step 3: Commit**

```bash
git add esp32/cube/firmware/main/application.cc
git commit -m "refactor(cube/app): drive TLS config from CUBE_DEV_TLS_INSECURE"
```

---

### Task 5: Delete the SetCacert apparatus from sentient_cube.cc

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`

- [ ] **Step 1: Remove the esp_ssl include**

Delete from `sentient_cube.cc`:
```cpp
#include "esp/esp_ssl.h"
```

- [ ] **Step 2: Remove the cert extern symbols block (~lines 65-75)**

Delete:
```cpp
#if SENTIENT_DEV_TLS_PIN
// Symbols exposed by EMBED_TXTFILES on sentient_dev_gateway.crt
...
extern const char _binary_sentient_dev_gateway_crt_start[] asm("_binary_sentient_dev_gateway_crt_start");
extern const char _binary_sentient_dev_gateway_crt_end[]   asm("_binary_sentient_dev_gateway_crt_end");
#endif
```

- [ ] **Step 3: Remove the SetCacert call in the ctor (~lines 1114-1128)**

Delete the whole block:
```cpp
#if SENTIENT_DEV_TLS_PIN
        {
            // mbedtls_x509_crt_parse requires PEM length INCLUDING the null
            ...
            if (cert_len > 0) {
                ESP_LOGI(TAG, "Pinning dev gateway TLS cert (%u bytes, incl null)", (unsigned)cert_len);
                EspSsl::SetCacert(_binary_sentient_dev_gateway_crt_start, cert_len);
            }
        }
#endif
```

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
git commit -m "refactor(cube/board): remove redundant EspSsl::SetCacert dev-cert pin"
```

---

### Task 6: Drop esp-ml307 dependency, dead modem code, CMake coupling, gitignore patch

**Files:**
- Delete: `esp32/cube/firmware/main/boards/common/ml307_board.{cc,h}`, `dual_network_board.{cc,h}`
- Modify: `esp32/cube/firmware/main/CMakeLists.txt`, `main/idf_component.yml`, `esp32/cube/.gitignore`

- [ ] **Step 1: Confirm no remaining references to the modem boards / esp_ssl**

Run:
```bash
grep -rn "Ml307Board\|DualNetworkBoard\|ml307_board\|dual_network_board\|EspSsl\|esp/esp_ssl\|esp-ml307\|ML307_DIR" esp32/cube/firmware/main --include="*.cc" --include="*.h" | grep -v "boards/common/ml307_board\|boards/common/dual_network_board"
```
Expected: only matches inside `CMakeLists.txt` (handled below). If any `.cc`/`.h` outside the files being deleted still references these, STOP and resolve — the board base or a sibling board may depend on `DualNetworkBoard`.

- [ ] **Step 2: Delete the modem-board files**

```bash
git rm esp32/cube/firmware/main/boards/common/ml307_board.cc \
       esp32/cube/firmware/main/boards/common/ml307_board.h \
       esp32/cube/firmware/main/boards/common/dual_network_board.cc \
       esp32/cube/firmware/main/boards/common/dual_network_board.h
```

- [ ] **Step 3: Remove their entries from main/CMakeLists.txt SOURCES**

Delete both occurrences (lines ~84-86 and ~987-988) of:
```cmake
    "boards/common/ml307_board.cc"
    "boards/common/dual_network_board.cc"
```

- [ ] **Step 4: Remove the esp-ml307 PRIV_REQUIRES + ML307_DIR include coupling**

In `main/CMakeLists.txt`, delete the `78__esp-ml307` entry from PRIV_REQUIRES (with its comment block) and delete:
```cmake
idf_component_get_property(ML307_DIR 78__esp-ml307 COMPONENT_DIR)
target_include_directories(${COMPONENT_LIB} PRIVATE "${ML307_DIR}/src")
```
(plus the comment above it referencing `esp/esp_ssl.h`).

- [ ] **Step 5: Remove the EMBED_TXTFILES dev-cert block**

In `main/CMakeLists.txt` (~lines 1011-1028), delete the `SENTIENT_EMBED_TXTFILES` logic and the `EMBED_TXTFILES ${SENTIENT_EMBED_TXTFILES}` argument from `idf_component_register`. The dev cert is no longer embedded.

- [ ] **Step 6: Remove esp-ml307 from idf_component.yml**

Delete the `78/esp-ml307: ~3.6.5` line (and only that line) from `esp32/cube/firmware/main/idf_component.yml`.

- [ ] **Step 7: Remove the .gitignore negation block + untrack the patch files**

In `esp32/cube/.gitignore`, delete lines 7-24 (the `Ignore all managed_components contents except…` comment through the two `!…esp_ssl.{h,cc}` exceptions), leaving a simple `firmware/managed_components/` ignore. Then:
```bash
git rm --cached esp32/cube/firmware/managed_components/78__esp-ml307/src/esp/esp_ssl.h \
                esp32/cube/firmware/managed_components/78__esp-ml307/src/esp/esp_ssl.cc 2>/dev/null || true
```
Confirm `esp32/cube/.gitignore` still ignores `firmware/managed_components/` wholesale (add `firmware/managed_components/` if the negation removal left it uncovered).

- [ ] **Step 8: Commit**

```bash
git add -A esp32/cube/firmware/main/CMakeLists.txt esp32/cube/firmware/main/idf_component.yml esp32/cube/.gitignore
git commit -m "refactor(cube): drop esp-ml307 dep + dead modem boards + tracked patch"
```

---

### Task 7: Remove the cert-extraction from bake-creds + build the firmware (W1+W2 gate)

**Files:**
- Modify: `esp32/cube/scripts/bake-creds.sh`

- [ ] **Step 1: Strip the openssl cert-extraction + TLS_PIN emission from bake-creds**

In `esp32/cube/scripts/bake-creds.sh`, remove the debug-profile block that runs `openssl s_client … > sentient_dev_gateway.crt` and sets `PIN_VALUE`. Replace the `SENTIENT_DEV_TLS_PIN` template substitution: drop the `@SENTIENT_DEV_TLS_PIN@` line from the inlined `sentient_creds.h` template and the corresponding `sed` substitution. Remove the `CERT_OUT` handling. The header no longer needs a TLS-pin macro (TLS is Kconfig-driven now).

- [ ] **Step 2: Re-bake creds (no cert extraction this time)**

```bash
source scripts/env.sh
esp32-devtool bake-creds --profile debug 2>&1 | tail -6
test -f esp32/cube/firmware/main/sentient_creds.h && echo "creds ok"
test -f esp32/cube/firmware/main/sentient_dev_gateway.crt && echo "WARN: stale cert still emitted" || echo "no dev cert (correct)"
```
Expected: `creds ok`; no `sentient_dev_gateway.crt`. Remove any stale `sentient_dev_gateway.crt` left from prior bakes: `rm -f esp32/cube/firmware/main/sentient_dev_gateway.crt`.

- [ ] **Step 3: Clean build — the W1+W2 gate**

```bash
cd ~/esp/esp-idf && source export.sh >/dev/null 2>&1
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk/esp32/cube/firmware
idf.py build 2>&1 | tail -25
```
Expected: clean build. The processed-dependencies list does NOT include `78/esp-ml307`. No `EspSsl` / `esp_ssl.h` / EMBED cert errors. If esp-ml307 still appears, a transitive dep still pulls it — find it with `idf.py reconfigure` output and decide whether it's genuinely needed (it should not be).

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/scripts/bake-creds.sh
git commit -m "refactor(cube/bake-creds): drop dev-cert extraction (TLS is Kconfig-driven)"
```

---

### Task 8: Flash + real-hardware TLS validation (debug insecure path)

**Files:** none (hardware smoke).

- [ ] **Step 1: Confirm cube present + not wedged**

```bash
source scripts/env.sh
esp32-devtool cmd state 2>&1 | head -2
```
Expected: a state JSON within 3s. If wedged, recover before flashing (`.claude/rules/esp32/cube/flash-discipline.md`).

- [ ] **Step 2: One flash**

```bash
bash esp32/cube/scripts/flash.sh 2>&1 | tail -10
```
Expected: flash succeeds; `<<< READY`; no AXP2101 fault.

- [ ] **Step 3: Verify the debug insecure WSS handshake works on real hardware**

```bash
for i in 1 2 3 4 5 6 7 8; do sleep 3; esp32-devtool cmd state 2>/dev/null; done
```
Expected: cube reaches `{"state":"IDLE", … "ws_connected":true …}` — proves the insecure-skip-verify WSS path connects to the macOS gateway. Then confirm the TLS log:
```bash
PORT=$(ls /dev/cu.usbmodem* | head -1)
esp32-devtool daemon ring --port "$PORT" --lines 2000 2>/dev/null | grep -iE "tls:|crt_bundle|INSECURE|handshake" | tail -5
```
Expected: `tls: INSECURE — server cert verification disabled (debug)` and a successful WS connect afterward. If the handshake fails, return to Task 3 Step 3 and apply the correct insecure mechanism.

- [ ] **Step 4: Commit the gate marker**

```bash
git commit --allow-empty -m "test(cube): W1+W2 green — clean build + insecure-WSS handshake on hardware"
```

---

### Task 9: Migration-gap audit (W4)

**Files:** findings only; fixes inline if small.

- [ ] **Step 1: Hunt gitignore negation exceptions repo-wide**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk
grep -rn "^!" --include=".gitignore" . 2>/dev/null | grep -v node_modules
```
Expected: the cube esp-ml307 exceptions are GONE (removed in Task 6). Any remaining `!` negation that force-tracks files inside an otherwise-ignored dir is a migration-fragility candidate — inspect each. Document findings.

- [ ] **Step 2: Diff gitlab cube tracked files vs the new repo**

```bash
GL=/Users/kevinye/Development/sentient-gitlab/sentient
diff <(git -C "$GL" ls-files "esp32/cube/**" | sort) <(git ls-files "esp32/cube/**" | sort) | grep '^<' | head -40
```
Expected: lines present in gitlab but absent in the new repo. Triage each: needed-but-missed (restore) vs intentionally-dropped (ignore). Known-OK: `managed_components/78__esp-ml307/**` (intentionally dropped), `dependencies.lock` (gitignored by policy), `sentient/creds/sentient_creds.h.in` (inlined into bake-creds).

- [ ] **Step 3: Absolute-path scan in tracked files**

```bash
grep -rn "/Users/kevinye" $(git ls-files "esp32/cube/**") 2>/dev/null | head
```
Expected: no hardcoded user paths in tracked files. Any hit gets fixed (relative path) or documented.

- [ ] **Step 4: Write the findings into the handover (Task 11) + fix small gaps inline**

For each surfaced gap: if it's a one-line fix (a missed config file, a stray abs path), fix + commit now. If larger, log it for the handover. Commit any inline fixes:
```bash
git add -A && git commit -m "fix(cube): migration-gap audit — <describe each fix>" || echo "no inline fixes needed"
```

---

### Task 10: Tighten manifest pins + document the lock policy (W3)

**Files:**
- Modify: `esp32/cube/firmware/main/idf_component.yml`
- Modify: `.claude/rules/esp32/cube/build.md`

- [ ] **Step 1: Find wildcard / major-float pins that affect the esp32-s3 build**

```bash
grep -nE "version: *'?\*'?|\^[0-9]" esp32/cube/firmware/main/idf_component.yml
```
For each hit, check its `rules: if: target in [...]` — if it is gated to `esp32p4`/other non-s3 targets, leave it (does not affect the cube). If it affects `esp32s3` (or is ungated), tighten `*` / `^major` to `~minor` matching the version currently resolved (read it from `dependencies.lock` after a build). Apply only to s3-affecting deps.

- [ ] **Step 2: Confirm the lock is gitignored**

```bash
git check-ignore esp32/cube/firmware/dependencies.lock && echo "gitignored ✓"
```
Expected: `gitignored ✓`. Leave it gitignored (IDF official for local-path-dep projects).

- [ ] **Step 3: Document the lock policy in the cube build rule**

Append to `.claude/rules/esp32/cube/build.md`:
```markdown
- `dependencies.lock` is gitignored by design. The cube has a local-path
  dependency (`esp32_devtool_companion` via `path:`), and ESP-IDF guidance is
  to NOT commit the lock for such projects — it embeds environment-specific
  local paths. Reproducibility comes from version pins in
  `main/idf_component.yml` + the immutable component registry. Regenerate with
  `idf.py reconfigure`. Never commit the lock or force-track files inside
  `managed_components/`.
```

- [ ] **Step 4: Rebuild to confirm pins still resolve**

```bash
cd ~/esp/esp-idf && source export.sh >/dev/null 2>&1
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk/esp32/cube/firmware
idf.py reconfigure 2>&1 | tail -10
```
Expected: dependency resolution succeeds with the tightened pins.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/main/idf_component.yml .claude/rules/esp32/cube/build.md
git commit -m "chore(cube): tighten s3 manifest pins + document gitignored-lock policy"
```

---

### Task 11: Fresh-clone reproducibility proof + handover

**Files:**
- Create: `docs/superpowers/handovers/2026-06-01-cube-build-reproducibility.md`

- [ ] **Step 1: Prove a from-scratch build with zero manual fetch/patch**

Simulate a fresh checkout by wiping all generated state, then build:
```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk/esp32/cube/firmware
rm -rf build managed_components dependencies.lock
rm -f main/sentient_dev_gateway.crt
source ../../../scripts/env.sh
esp32-devtool bake-creds --profile debug 2>&1 | tail -4
cd ~/esp/esp-idf && source export.sh >/dev/null 2>&1
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk/esp32/cube/firmware
idf.py build 2>&1 | tail -15
```
Expected: clean build with NO manual `git checkout` of managed_components, NO patch re-application, NO foreign-path errors. This is the definition-of-done proof.

- [ ] **Step 2: Confirm no anti-patterns remain**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/polymorphic-growing-dusk
grep -rn "^!" esp32/cube/.gitignore && echo "FAIL: negation exception remains" || echo "no negation exceptions ✓"
git ls-files "esp32/cube/firmware/managed_components/**" | head -1 && echo "FAIL: tracked managed_components" || echo "no tracked managed_components ✓"
```
Expected: both `✓`.

- [ ] **Step 3: Write the handover**

Create `docs/superpowers/handovers/2026-06-01-cube-build-reproducibility.md` recording: what changed (TLS→bundle, esp-ml307 dropped, lock policy), the W4 audit findings table, the verified insecure-WSS mechanism (from Task 3/8), flash count + AXP2101 events, and the open prod-cert prerequisite (gateway must serve Let's Encrypt for the prod bundle path to verify).

- [ ] **Step 4: Commit + finish the branch**

```bash
git add docs/superpowers/handovers/2026-06-01-cube-build-reproducibility.md
git commit -m "docs(cube): build-reproducibility handover"
```
Then invoke `superpowers:finishing-a-development-branch` to merge `feature/cube-build-reproducibility` into `develop` (it lands before the resumed devtool-adoption work).

---

## Self-review notes

- **Spec coverage:** W1 → Tasks 2-5,7 (Kconfig+bundle, WS config, app wiring, board SetCacert removal, bake-creds). W2 → Task 6. W3 → Task 10. W4 → Task 9. Done-gate (fresh-clone build + hardware TLS) → Tasks 7,8,11. All spec sections mapped.
- **Build-safe ordering** documented in working notes (W1 code before W2 dep-drop) — the apparent reorder vs the spec's W2→W1 is intentional and explained.
- **No-placeholder check:** all code blocks are concrete from the current tree. The single deliberately-open item — the exact esp-tls insecure mechanism (Task 3 Step 3) — is flagged by the spec as plan-time/hardware-verified, with an explicit stop-condition, not a silent TODO.
- **Type consistency:** `use_crt_bundle` + `insecure_skip_verify` are defined in Task 3 (the `.h`) and consumed identically in Task 3 (the `.cc`) and Task 4 (`application.cc`). `CONFIG_CUBE_DEV_TLS_INSECURE` defined in Task 2, consumed in Task 4.
