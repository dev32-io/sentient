# ESP32 Cube v2 Rescope — Design

**Date:** 2026-05-11
**Status:** Approved for implementation planning
**Replaces (in spirit):** `docs/superpowers/specs/2026-05-09-esp32-cube-v1-design.md`
**Branch:** continue on `feature/esp32-cube-v1` (no rename)

---

## 1. Goal

Replace the xiaozhi-submodule + overlay + numbered-patches structure with a flat, owned firmware tree. Bring up the cube hardware bottom-up across five small phases. Keep the agent_console + net_logger + cube-daemon debug stack we already built. End with a working sentient voice loop on real hardware.

## 2. Why rescope

The current v1 plan assumed a non-destructive overlay over xiaozhi-esp32. In practice that pattern cost us:

- **Patch friction** — 4 numbered patches against an ~90KLOC submodule. Patches drift on whitespace, on context, on every xiaozhi bump.
- **Vtable timing hacks** — `DeferLateInit` tag struct + `LateInit()` from derived ctor body, because base-class ctor cannot call derived virtuals. Pure consequence of "subclass the upstream board" instead of "edit the upstream board."
- **LVGL lock release surprises** — base class releases the lock before derived `SetupUI` overrides can finish their work, forcing re-acquire patterns.
- **Symlink + build.sh complexity** — `build.sh` resets upstream, applies patches, symlinks our overlay, bakes creds, then runs `idf.py build`. Every step is a place to fail.

Meanwhile, xiaozhi's actual reusable surface is small: codecs, AEC, AudioService, state machine, asset framework, plus one board file. The rest (32 other boards, OTA, MCP, MQTT, wake words) is dead weight we never wanted.

Trading overlay-friction for "owned files, plain edits, no submodule" is a clear win once you accept that we will not be pulling xiaozhi updates regularly.

## 3. Architecture

### 3.1 Final tree layout

```
esp32/cube/
├── .e2e-testing                  # wifi + sentient creds, gitignored
├── .venv/                        # pytest-embedded
├── CMakeLists.txt                # ESP-IDF top-level, points at firmware/
├── sdkconfig.defaults
├── partitions.csv
├── firmware/                     # NEW: trimmed + owned source tree
│   ├── main/
│   │   ├── application.{cc,h}    # copied from xiaozhi, OTA/MCP/MQTT/wake-word stripped
│   │   ├── main.cc
│   │   ├── device_state_machine.{cc,h}
│   │   ├── audio/                # codecs (Opus), AEC, AudioService
│   │   ├── display/              # LVGL + lcd_display.{cc,h}
│   │   ├── assets/               # animation/emoji asset framework
│   │   ├── protocols/            # WS only (MQTT deleted)
│   │   ├── boards/
│   │   │   ├── common/           # AXP2101, backlight, codecs, button base
│   │   │   └── sentient-cube/    # merged: waveshare AMOLED 2.16 + our overlay
│   │   ├── settings.{cc,h}
│   │   ├── sentient_creds.h      # baked, gitignored
│   │   └── system_info.{cc,h}
│   └── components/
│       ├── agent_console/        # from sentient/components/agent_console/
│       └── net_logger/           # from sentient/components/net_logger/
├── lvgl-sim/                     # NEW Phase 2: LVGL PC simulator for UI iteration
│   ├── README.md                 # version pin, update instructions
│   ├── CMakeLists.txt
│   └── main/                     # host-build entry
├── scripts/                      # kept: cube-cmd.sh, _cube_daemon.py, _cube_cmd_helper.py
├── tests/                        # kept: pytest-embedded HIL suite
└── docs/                         # kept

REMOVED:
- esp32/cube/upstream/  (submodule git rm)
- esp32/cube/sentient/  (contents merged into firmware/)
```

### 3.2 What stays from xiaozhi (copied into `firmware/main/`)

- `audio/codecs/` — Opus encode/decode
- `audio/processors/` — AEC (echo cancellation, defense-in-depth alongside gateway WebRTC AEC)
- `audio/audio_service.{cc,h}` — single audio task lifecycle
- `application.{cc,h}` — IDLE→Connecting→Listening→Speaking state machine
- `device_state_machine.{cc,h}`
- `display/lcd_display.{cc,h}` — LVGL panel setup
- `assets/` + `assets.cc` — animation asset framework (kept for future, not exercised in v1)
- `protocols/websocket_protocol.{cc,h}` — server connection
- `boards/common/` — shared HW glue (AXP2101, backlight, codec base)
- `boards/waveshare/esp32-s3-touch-amoled-2.16/` — merged with our overlay, becomes `boards/sentient-cube/`
- `settings.{cc,h}` — NVS-backed settings (kept for future provisioning, no UI in v1)
- `system_info.{cc,h}`
- `main.cc`

### 3.3 What gets deleted (in same Phase 1 PR)

- `boards/` — every dir except `common/` and our `sentient-cube/`. ~32 directories.
- `ota.{cc,h}` — xiaozhi.me cloud OTA. Useless.
- `mcp_server.{cc,h}` — xiaozhi device-side MCP. Our gateway owns MCP.
- `audio/wake_words/` — push-to-talk only in v1.
- `protocols/mqtt_protocol*` — WS only.
- `audio/demuxer/` — xiaozhi audio-stream demuxer; gateway sends raw opus.

### 3.4 What our overlay contributes (moves to native)

From `esp32/cube/sentient/`:

- `components/agent_console/` → `firmware/components/agent_console/`
- `components/net_logger/` → `firmware/components/net_logger/`
- `boards/sentient-cube/sentient_cube.cc` — merges into `firmware/main/boards/sentient-cube/sentient_cube.cc` (the renamed waveshare board file, edited directly)
- `boards/sentient-cube/sentient_ui_controller.cc` → `firmware/main/boards/sentient-cube/`
- `boards/sentient-cube/toggle_button_screen.cc` → `firmware/main/boards/sentient-cube/`
- `patches/0001-add-sentient-cube-board.patch` → obsoleted (board is the only board now)
- `patches/0002-virtualize-board-late-init.patch` → obsoleted (no derivation = no vtable problem)
- `patches/0003-disable-power-save-for-sentient-cube.patch` → applied as direct edit to `application.cc`
- `patches/0004-audio-inject-hook.patch` → applied as direct edit to `audio/audio_service.cc`

### 3.5 Architectural payoff

After Phase 1:

1. `SentientCubeDisplay` is no longer a class derived from `CustomLcdDisplay` — it is the display class. Patch 0002 disappears.
2. No `DeferLateInit` tag struct. Constructors call siblings naturally.
3. No `LateInit()` dance from derived ctor body.
4. USB-aware power-save monitor is a regular function in `application.cc`.
5. `ReadAudioData` audio-inject hook is a regular virtual or callback, not a weak symbol.

## 4. Phase Ordering

Five phases. All five land on `feature/esp32-cube-v1` as commit batches. Each phase = its commits + smoke bar green + handover doc posted to chat. The feature branch merges to `develop` ONCE, after Phase 5 handover is reviewed. Per-phase handovers are internal review checkpoints — they do not gate a git merge, they gate "agent moves on to next phase."

### Phase 1: Foundation

**Goal:** cube boots from new tree, agent_console responds, UDP logs ship. No HW features wired beyond what boot needs.

**Work:**
- Drop submodule + create `firmware/` tree.
- Copy xiaozhi sources from a known-good v2.2.6 checkout, trim aggressively in the same PR.
- Strip OTA / MCP / MQTT / wake-word from `application.cc` directly.
- Move agent_console + net_logger into `firmware/components/`.
- Merge sentient-cube board files into `firmware/main/boards/sentient-cube/` as one set.
- Apply patches 0003 + 0004 as direct edits.
- Update top-level `CMakeLists.txt` and `sdkconfig.defaults` paths.
- Retarget pytest-embedded HIL harness at `firmware/`.

**Smoke bar (≤ 3 flashes):**
- `idf.py build flash monitor` boots clean.
- `cube-cmd state` returns a device-state string.
- `cube-cmd mark hello` emits `>>> CHECKPOINT hello <ts>`.
- `nc -ul 9000` receives `>>> LOG sentient.cube.*` lines.

### Phase 2: Display + Touch

**Goal:** screen renders, touch coords logged, agent can see screen via `ui.snapshot`. LVGL PC simulator stands up alongside.

**Work:**
- LVGL + framebuffer + backlight via copied `Display::Init`.
- Touch via copied `Touch::Init` (CST816 on AMOLED 2.16).
- Replace xiaozhi's default emoji-face UI with `sentient_cube_test_screen()`: solid color, gradient bar, "SENTIENT CUBE" label, touch-coord heatmap dot.
- LVGL touch indev wired to log `>>> EVT touch.tap x y` via agent_console event channel.
- Stand up `lvgl-sim/` host build (`lv_port_pc_vscode` template). README documents version pin and "how to update upstream" steps.

**Smoke bar (≤ 4 flashes):**
- `cube-cmd ui.snapshot --output /tmp/p2.png` → PNG shows test screen.
- `cube-cmd events --tail 30` after manual finger tap → at least one `touch.tap` event with sane x/y.
- LVGL 1–2 Hz spinner visible in two snapshots taken 500ms apart.
- Host `lvgl-sim` build runs same screen code → SDL2 window shows same layout.

### Phase 3: Speaker

**Goal:** speaker audible. Software can play canned PCM via agent_console.

**Work:**
- Codec init (ES8311 or AW88298 per AMOLED 2.16). Use copied `boards/common/audio_codec.{cc,h}` as-is.
- `AudioService` starts in stub mode (output enabled, input disabled).
- New agent_console verbs:
  - `audio.test_tone freq=440 ms=500` — on-device sine generator → codec.
  - `audio.play_pcm <base64 PCM16 16kHz mono>` — mirror of input `audio.inject_pcm`.

**Smoke bar (≤ 4 flashes):**
- Boot tone audible on first boot.
- `cube-cmd audio.test_tone freq=440 ms=500` plays 440Hz for 500ms (ear test).
- `cube-cmd audio.play_pcm hello.pcm` plays a canned "hello" recorded earlier (ear test).

### Phase 4: Mic

**Goal:** mic captures audio. Software can read levels + dump capture via agent_console.

**Work:**
- Codec input enabled in `AudioService`.
- New agent_console verbs:
  - `audio.record_rms ms=1000` — capture N ms, return mean RMS over UDP-log.
  - `audio.record_pcm ms=500` — capture N ms, return base64 PCM16 in RSP (capped at ~1s to avoid heap pressure).

**Smoke bar (≤ 4 flashes):**
- `cube-cmd audio.record_rms ms=1000` while quiet returns low RMS (< 500).
- Same command during clap returns high RMS (> 5000).
- `cube-cmd audio.record_pcm ms=500` returns ~16KB base64 that plays back as recognizable speech on host (round-trip via `audio.play_pcm`).

### Phase 5: Sentient Connect

**Goal:** full voice loop on real hardware. Toggle button → mic → opus → WS → gateway → opus → speaker.

**Work:**
- Restore toggle-button-screen as default boot UI.
- Wire WS protocol to sentient gateway URL + PASETO auth (port from current `xiaozhi-adapter` work).
- AudioService input feeds opus encoder → WS uplink.
- WS downlink opus frames → opus decoder → AudioService output.
- Device state machine: IDLE → ListeningOnPress → Streaming → ReleaseFlush → AwaitingResponse → Speaking → IDLE.

**Smoke bar (≤ 5 flashes):**
- `cube-cmd state` reports `IDLE` after WS connected.
- Press toggle → state `Listening` → gateway sees mic frames over WS.
- Release toggle → gateway responds → speaker plays response.
- Existing HIL pytest suite Group A (test_boot, test_mic_toggle, test_ws_disconnect, test_wifi_loss, test_bad_paseto, test_reboot, test_udp_log_shipping) + Group B (test_voice_loop, test_barge_in) green against local gateway stack. test_long_uplink (Group A) depends on `audio.inject_pcm` chunked variant — gated on that follow-up landing.

## 5. Per-Phase Handover Format (plan-scoped, mandatory)

Every phase MUST end with a handover document at
`docs/superpowers/handovers/YYYY-MM-DD-esp32-cube-phase<N>-<slug>.md`.

This requirement is scoped to this plan's 5 phases. Not a long-lived rule.

Required sections in order:

```
## What's done
- <one bullet per merged commit, plain language, no SHAs>

## What's used (stack the user now owns)
- File: <path> — <one-line responsibility>
- Component: <name> — <what it does, who calls it>
- Verb: <agent_console verb> — <example invocation>
- Pin/GPIO: <num> → <function> (only if HW wiring is newly relevant)

## What's smoked
- <case>: <command run> → <observed result> (✅ green | ❌ red)
- Screenshot evidence: <path>
- Log evidence: <path or inline quote>

## What you need to know
- 2–5 bullets, things the agent learned that the user would not derive from code
- Examples: "AXP2101 must be powered before display init or backlight stays dark"

## Hardware glossary (terms new this phase)
- **<term>**: <plain definition + why it matters to this cube>
- Terms accumulate across phases. Do not repeat earlier glossary entries.

## Open questions / risks
- One bullet per uncertainty. If genuinely none, write "no known risks" + justification.

## Flash + smoke metrics
- Flashes this phase: <n>
- AXP2101 faults hit: <n>
- Daemon restarts: <n>
- Cold physical recoveries: <n>
- Total dev time on smoke runs: <approx hours>
```

Handover is the LAST step before moving on to the next phase. Post to chat for user review. User may reopen the phase. Only after Phase 5's handover is approved does the full feature branch merge to `develop`.

## 6. Debug Tooling (locked, no change)

Port the following forward into `firmware/components/` as native — no protocol change, no path change for users of the host scripts:

| Tool | New path | Purpose |
|------|----------|---------|
| `agent_console` | `firmware/components/agent_console/` | JSON-RPC over USB-CDC |
| `net_logger` | `firmware/components/net_logger/` | UDP log shipping to host:9000 |
| `cube-cmd.sh` + daemon | `esp32/cube/scripts/` (unchanged) | Persistent USB-CDC session, sentinel RSP matching, PSRAM-backed rx |
| `ui.dump_tree` verb | `firmware/components/agent_console/verbs/ui.cc` | LVGL widget-tree introspection |
| `ui.snapshot` verb | `firmware/components/agent_console/verbs/ui_snapshot.cc` | Chunked base64 RGB565 → host PNG |
| `audio.inject_pcm` / `audio.record_pcm` | added Phase 3/4 | Speaker stimulation + mic capture |

Known follow-ups (not phase blockers):
- `ui.snapshot` intermittent RPC parse-error (log line truncation suspect).
- `audio.inject_pcm` heap OOM on 21KB single payload. Phase 3 must add a chunked-stream variant.

## 7. LVGL PC Simulator (Phase 2 deliverable)

**Why:** UI iteration on real hardware is ~30s per change (build + flash + boot + smoke). PC simulator brings that to ~2s. Critical for animation work in Phase 5 polish.

**What:**

- `esp32/cube/lvgl-sim/` host build, based on [`lvgl/lv_port_pc_vscode`](https://github.com/lvgl/lv_port_pc_vscode).
- Pin version explicitly in `lvgl-sim/README.md` — record commit SHA and `lv_conf.h` version. Document `git remote add upstream && git fetch && cherry-pick`-style update flow.
- Share `lv_conf.h` between host and device builds.
- Move portable LVGL code (screens, widgets, animations) into a directory both targets compile against.
- `disp_drv` / `indev_drv` glue stays per-target.

**What it does NOT validate (still requires device smoke):**
- `esp_lcd_panel_draw_bitmap` async-done callback timing.
- LVGL display lock contention with our agent_console event-emit path.
- Refresh rate / tearing under real DMA.

**Scope guard:** simulator is a UI-iteration aid only. Never gate a phase smoke bar on simulator-only verification. Device smoke is always required.

## 8. Sentient v1 Feature Scope

Unchanged from prior v1 spec:

- One screen — toggle-button. Press = start mic. Release = stop + flush + await response.
- Hardcoded PASETO token baked into `firmware/main/sentient_creds.h` at build time (gitignored).
- Hardcoded WS URL pointing at local mac stack via `.e2e-testing` injection.
- WiFi creds baked same way (SSID `interweb`, password from `.e2e-testing`).
- No settings UI, no provisioning flow, no OTA, no MCP, no wake word.
- Asset framework retained, not exercised in v1.

## 9. Test Strategy

**Unit tests:** none added in foundation. Per `.claude/rules/testing.md`, only pin state-machines + wire protocols. xiaozhi's state machine is borrowed code; we do not own its invariants.

**HIL tests** (`esp32/cube/tests/`): existing pytest-embedded suite retargeted at `firmware/`. Phase 1 keeps current Group A boot tests as-is. Phase 4 (mic) re-introduces `audio.inject_pcm`-dependent cases. Phase 5 closes Group B (voice loop) and Group C (manual runbook).

**Phase smoke:** each phase has its own smoke bar (Section 4). No phase merges until smoke 100% green AND handover written.

**LVGL PC simulator:** UI-iteration only. Not a gate.

## 10. Migration (Phase 1, single PR)

```
Step 1: branch already exists — feature/esp32-cube-v1. Stay on it.

Step 2: archive recovery marker
   git tag esp32-cube-v1-overlay-archive  # marks 8db3a9c as recoverable

Step 3: drop submodule
   git submodule deinit -f esp32/cube/upstream
   git rm -rf esp32/cube/upstream
   rm -rf .git/modules/esp32/cube/upstream
   # edit .gitmodules — delete the [submodule "esp32/cube/upstream"] block

Step 4: copy xiaozhi sources from a fresh clone
   git clone --depth 1 https://github.com/78/xiaozhi-esp32 /tmp/xz-rescope
   cd /tmp/xz-rescope && git checkout b72945a   # match prior submodule pin
   mkdir -p esp32/cube/firmware/main
   # copy keep-list only — explicit cp commands enumerated in plan

Step 5: trim in same commit
   rm -rf esp32/cube/firmware/main/boards/<every non-target dir>
   rm esp32/cube/firmware/main/{ota.cc,ota.h,mcp_server.cc,mcp_server.h}
   rm -rf esp32/cube/firmware/main/audio/wake_words
   rm esp32/cube/firmware/main/protocols/mqtt_protocol*
   rm -rf esp32/cube/firmware/main/audio/demuxer

Step 6: port overlay → native
   mv esp32/cube/sentient/components/{agent_console,net_logger} esp32/cube/firmware/components/
   mkdir esp32/cube/firmware/main/boards/sentient-cube
   # merge waveshare board file + our sentient_cube.cc into a single file
   # move sentient_ui_controller.cc + toggle_button_screen.cc alongside
   rm -rf esp32/cube/sentient

Step 7: apply patches 0003 + 0004 as direct edits
   # USB-aware power save: edit application.cc directly
   # audio inject hook: edit audio_service.cc directly

Step 8: wire CMakeLists.txt
   # update esp32/cube/CMakeLists.txt to point at firmware/, not upstream/

Step 9: idf.py build (green required before any flash)

Step 10: flash + Phase 1 smoke (boot + state + UDP log)

Step 11: write Phase 1 handover

Step 12: post Phase 1 handover to chat for user review
   # do NOT merge to develop yet — feature branch keeps going through Phase 5
```

## 11. Risks + Known Limitations

- **AXP2101 PMIC boot fault** persists. Mitigated by USB-aware power-save direct edit (Phase 1) + cube-daemon + DTR/RTS hygiene. Physical recovery still required if it triggers. Tracked in `.claude/rules/esp32/cube/flash-discipline.md`.
- **`ui.snapshot` intermittent RPC parse-error** — not blocking. Investigate Phase 2 if it recurs after the move.
- **`audio.inject_pcm` heap OOM** — Phase 3 must implement chunked variant before reusing for HIL `test_long_uplink`.
- **xiaozhi update path** — manual cherry-pick only after rescope. If xiaozhi ships a critical opus codec fix we need, that's a deliberate forward-port exercise, not an automatic submodule bump. Acceptable cost given trim depth.

## 12. References

- Flash discipline rule: `.claude/rules/esp32/cube/flash-discipline.md`
- Flash discipline details: `agents/docs/esp32/cube/flash-discipline-details.md`
- Existing cube rules: `.claude/rules/esp32/cube/{build,agent-console,logging,testing}.md`
- Existing cube docs: `agents/docs/esp32/cube/{build,agent-console,logging,testing}-details.md`
- xiaozhi upstream: https://github.com/78/xiaozhi-esp32 (we will not pull from this after Phase 1)
- LVGL PC simulator template: https://github.com/lvgl/lv_port_pc_vscode
- v1 archive marker: tag `esp32-cube-v1-overlay-archive` at `8db3a9c`
