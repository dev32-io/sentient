# ESP32 Cube v2 Phase 5 — Sentient Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the full voice loop on the sentient-cube. Restore the toggle-button screen as the boot UI; verify mic → opus → WS uplink to the local sentient gateway and WS → opus → speaker downlink work end-to-end against a live gateway; pin the behavior with Group A HIL tests + operator voice round-trip.

**Architecture:** Most of the plumbing is already in place from Phase 1 — `WebsocketProtocol` is wired into `Application::Initialize` (`application.cc:402`), the PASETO token and WS URL are seeded into the `Settings("websocket")` NVS namespace by `SentientCubeBoard::InjectWebsocketConfig()` (`sentient_cube.cc:726`), and the button is wired to `Application::GetInstance().ToggleChatState()` (`sentient_cube.cc:101`). The work in Phase 5 is mostly subtractive (swap the boot UI from the Phase 2 test screen to the toggle-button screen) plus additive HIL coverage of the full loop. The device's existing FSM (`DeviceState` enum: `Idle/Connecting/Listening/Speaking`) maps directly to the spec's `IDLE → Listening → Speaking → IDLE` cycle — no new states are added.

**Tech Stack:** ESP-IDF 5.5.2, Xtensa GCC, Waveshare ESP32-S3-Touch-AMOLED-2.16 (ES7210 mic + ES8311 DAC, AXP2101 PMIC), xiaozhi-derived `WebsocketProtocol` over `Authorization: Bearer <PASETO>` header, Opus encoder/decoder, agent_console JSON-RPC over USB-CDC, pytest-embedded HIL fixtures. Local sentient gateway (Docker stack on `deploy/macos/`) is the WS server; reachable via `SENTIENT_GATEWAY_HOST:SENTIENT_GATEWAY_WS_PORT/SENTIENT_GATEWAY_WS_PATH` baked into `firmware/main/sentient_creds.h`.

---

## Spec reference

- Active spec: `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md` §4 Phase 5.
- Smoke bar (≤ 5 flashes):
  - `cube-cmd state` reports `IDLE` after WS connected.
  - Press toggle → state `Listening` → gateway sees mic frames over WS.
  - Release toggle → gateway responds → speaker plays response.
  - HIL pytest Group A (boot, mic toggle, ws disconnect, wifi loss, reboot, udp log shipping) + Group B (voice loop, barge-in) green against the local Docker stack.
  - `test_long_uplink` already covered by Phase 3 chunked `inject_pcm` — no Phase 5 work.

## Phase 1-4 carry-over (relevant context)

- `WebsocketProtocol` already constructed in `Application::Initialize` (`application.cc:402`) — no protocol selection work needed.
- `SentientCubeBoard::InjectWebsocketConfig()` (`sentient_cube.cc:720-734`) writes `url` and `token` into `Settings("websocket")` NVS at board ctor — picked up by `WebsocketProtocol::OpenAudioChannel()` at `websocket_protocol.cc:84-86`.
- WS sends `Authorization: Bearer <PASETO>`, `Device-Id: <mac>`, `Client-Id: <uuid>` headers (`websocket_protocol.cc:106-110`). PASETO validation happens server-side in the gateway; the cube just transports the token.
- Boot UI is currently the Phase 2 test screen (`sentient_cube.cc:267 sentient_cube_show_test_screen()`). The toggle-button screen lives one function over (`sentient_cube_create_toggle_button_screen()` in `sentient_ui_controller.cc:249`).
- The toggle-button screen spawns a polling task (`sentient_ui_controller.cc:259 poll_state_task`) that maps `Application::GetDeviceState()` to LVGL UI state and emits `>>> CHECKPOINT <event> <ts_us>` markers. Phase 2-4 paused this path; Phase 5 brings it back.
- `>>> READY` print belongs to that polling task too — restored at the same time.
- `test_audio_play_pcm.py` (Phase 3) + `test_audio_record.py` (Phase 4) already pass. Phase 5 adds new HIL files; does not modify them.

## Constants (lifted into named values)

| Constant | Value | Where |
|---|---|---|
| `kBootToIdleTimeoutSec` | 30 | HIL `test_boot_to_idle` — generous WiFi+WS connect window |
| `kStateTransitionTimeoutSec` | 5 | HIL `test_toggle_to_listening` — button → state transition wall-clock |
| `kWsDisconnectRecoverySec` | 30 | HIL `test_ws_disconnect_recovery` — full reconnect window |
| `kUplinkFrameProbeSec` | 3 | HIL `test_toggle_emits_uplink_frames` — wait for first frame in gateway log after press |

These live in `esp32/cube/tests/hil/test_voice_loop.py` as module-level Python constants.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | Modify | Swap line 267 `sentient_cube_show_test_screen()` → `sentient_cube_create_toggle_button_screen()`; update the 11-line "Phase 2..5" comment above it. |
| `esp32/cube/tests/hil/test_voice_loop.py` | Create | 4-6 Group A cases — boot to IDLE, toggle → Listening, uplink frames cross-stack, WS disconnect recovery, cube-alive sentinel. |
| `esp32/cube/tests/hil/test_ws_recovery.py` | Create | 2-3 Group A cases — wifi.disconnect → WS disconnects → wifi reconnects → WS reconnects. Failure isolation from the voice loop file. |
| `docs/superpowers/handovers/2026-05-13-esp32-cube-phase5-sentient-connect.md` | Create | Final phase handover. Follows spec §5 format. |

No firmware code beyond the one-line UI swap. Phase 5 is "flip the switch + write tests."

---

## Task 1: Survey + baseline (no commit)

**Goal:** Confirm the running cube already reaches WS-connected against the local gateway BEFORE any code change. If it doesn't, gateway setup is needed before any other Phase 5 task can run.

- [ ] **Step 1: Verify the cube is alive and at IDLE post-Phase-4-refactor**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: `{"state":"IDLE","wifi_connected":true,"ws_connected":true,"cycle_id":null}` within 3 s.

If `ws_connected` is **false** OR `state` is `CONNECTING` for more than 30 s → gateway is unreachable; STOP and verify the local Docker stack is up via `cd /Users/kevinye/Development/sentient && docker compose -f deploy/macos/docker-compose.yml ps`. The cube already has the WS URL + PASETO baked; failure is gateway-side, not cube-side.

If `ws_connected` is **true** → proceed.

- [ ] **Step 2: Confirm the `>>> READY` marker is currently paused (test screen active)**

```bash
python3 -c "
import socket, json, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/cube-daemon.sock')
s.sendall(json.dumps({'kind':'events','n':20000}).encode())
buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
sys.stdout.write(buf.decode())
" | grep -E '>>> READY|>>> CHECKPOINT' | head -10
```

Expected: ZERO `>>> READY` or `>>> CHECKPOINT` lines in the ring buffer. The polling task in `sentient_ui_controller.cc::poll_state_task` is the only emitter of these and it spawns only from `sentient_cube_create_toggle_button_screen()`. Phase 5 Task 2 restores it.

- [ ] **Step 3: Inspect the current boot UI insertion point**

```bash
grep -n "sentient_cube_show_test_screen\|sentient_cube_create_toggle_button_screen" \
  esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc \
  esp32/cube/firmware/main/boards/sentient-cube/sentient_ui_controller.cc
```

Expected: one call to `sentient_cube_show_test_screen()` in `sentient_cube.cc` around line 267, two definitions in `sentient_ui_controller.cc`. No call to `sentient_cube_create_toggle_button_screen()` yet — Task 2 adds it.

- [ ] **Step 4: Confirm WS protocol selection is WebsocketProtocol (not MQTT)**

```bash
grep -n "make_unique<.*Protocol>\|new MqttProtocol\|new WebsocketProtocol" \
  esp32/cube/firmware/main/application.cc
```

Expected: exactly one `make_unique<WebsocketProtocol>()` line near `application.cc:402`. No `MqttProtocol` references (Phase 1 stripped MQTT at compile time).

No commit.

---

## Task 2: Restore toggle-button screen as boot UI

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc:240-268` — replace `sentient_cube_show_test_screen()` call with `sentient_cube_create_toggle_button_screen()`, rewrite the surrounding comment block.

- [ ] **Step 1: Make the swap**

In `sentient_cube.cc`, find the `CustomLcdDisplay::SetupUI()` method (around line 240). Replace the existing test-screen call + comment block with:

```cpp
    virtual void SetupUI() override {
        ESP_LOGI(TAG, "setup_ui device_id=" SENTIENT_DEVICE_ID);

        // Parent creates LVGL display + status bar; we then customize.
        SpiLcdDisplay::SetupUI();

        // Re-acquire the LVGL mutex: parent's DisplayLockGuard was scoped to
        // its own SetupUI() and released on return.
        DisplayLockGuard lock(this);
        lv_obj_set_style_pad_left(status_bar_, LV_HOR_RES * 0.1, 0);
        lv_obj_set_style_pad_right(status_bar_, LV_HOR_RES * 0.1, 0);
        lv_display_add_event_cb(display_, rounder_event_cb,
                                LV_EVENT_INVALIDATE_AREA, NULL);

        // Phase 5: restore the toggle-button screen as the boot UI. This
        // spawns the device-state polling task in sentient_ui_controller.cc,
        // which is the sole emitter of:
        //   >>> READY
        //   >>> CHECKPOINT {listen,ws,wifi}.{start,stop,connected,disconnected}
        // The Phase 2 test-screen path is retained as a callable function
        // (sentient_cube_show_test_screen()) so HIL UI-snapshot smoke can
        // still exercise it via a verb if a future need arises.
        sentient_cube_create_toggle_button_screen();
    }
```

- [ ] **Step 2: Verify build green**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware
idf.py build
```

If `idf.py` not on PATH, source first:
```bash
IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
pushd "$IDF_PATH" >/dev/null && . ./export.sh && popd >/dev/null
```

Expected: full build succeeds. `sentient_cube.bin` produced (~2.8 MB). Partition headroom unchanged.

- [ ] **Step 3: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
git commit -m "feat(esp32-cube/ui): restore toggle-button screen as boot UI"
```

No flash in this task. Task 3 flashes once + smokes.

---

## Task 3: HIL test_voice_loop.py (Group A)

**Files:**
- Create: `esp32/cube/tests/hil/test_voice_loop.py`

These tests will FAIL until the cube is reflashed in Task 5. That's the TDD red phase. Write them first.

- [ ] **Step 1: Create the test file**

`esp32/cube/tests/hil/test_voice_loop.py`:

```python
"""Phase 5 voice-loop verb smoke (Group A).

Cube-side smoke for the full voice loop after the toggle-button screen is
restored. Verifies:
- Boot → IDLE with WS connected (cube already had this; reconfirms after flash)
- button.toggle verb transitions IDLE → Listening
- gateway logs receive cube uplink frames within ~3 s of button press
- ws.disconnect verb is recoverable within 30 s (auto-reconnect via xiaozhi)
- After all the above, cube is back in IDLE + responsive

Operator ear test (full voice round-trip via speaker) lives in Task 6 device
smoke, not here.
"""
from __future__ import annotations

import time

import pytest


# Module-level HIL constants. Keep names in sync with the plan.
kBootToIdleTimeoutSec = 30
kStateTransitionTimeoutSec = 5
kWsDisconnectRecoverySec = 30
kUplinkFrameProbeSec = 3


@pytest.mark.group_a
def test_boot_to_idle(cube_dut):
    """Within 30 s, state must be IDLE and ws_connected=true."""
    deadline = time.time() + kBootToIdleTimeoutSec
    last_state = None
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        last_state = s
        if s.get("state") == "IDLE" and s.get("ws_connected") is True:
            return
        time.sleep(1.0)
    pytest.fail(
        f"cube did not reach IDLE+ws_connected within {kBootToIdleTimeoutSec}s; "
        f"last state: {last_state}"
    )


@pytest.mark.group_a
def test_toggle_to_listening(cube_dut):
    """button.toggle from IDLE transitions to LISTENING within 5 s.

    Cleanup: send button.toggle again to return to IDLE so subsequent tests
    don't inherit a Listening-state cube.
    """
    # Sanity: precondition is IDLE.
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"

    cube_dut.cmd("button.toggle", timeout=5)
    deadline = time.time() + kStateTransitionTimeoutSec
    saw = None
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        saw = s["state"]
        if saw == "LISTENING":
            break
        time.sleep(0.25)
    else:
        pytest.fail(
            f"state did not transition IDLE → LISTENING within "
            f"{kStateTransitionTimeoutSec}s; last={saw}"
        )

    # Cleanup: toggle off
    cube_dut.cmd("button.toggle", timeout=5)
    time.sleep(0.5)


@pytest.mark.group_a
def test_toggle_emits_uplink_frames(cube_dut, gateway_logs):
    """Press button → within 3 s, gateway log shows incoming audio frames.

    Cross-stack assertion: capture gateway log position BEFORE press, grep
    for cube-source frame markers AFTER. The exact log line shape depends on
    the gateway's audio sink; this test asserts the presence of ANY
    cube-source uplink activity in the window.
    """
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"

    pos = gateway_logs.position()
    cube_dut.cmd("button.toggle", timeout=5)
    time.sleep(kUplinkFrameProbeSec)
    cube_dut.cmd("button.toggle", timeout=5)  # cleanup: release toggle
    time.sleep(0.5)

    # Look for any gateway-side audio ingest line. Pattern is broad on
    # purpose; the gateway evolves its log format and the test cares about
    # presence, not exact shape. The substring `audio` is the minimum
    # commitment.
    matches = gateway_logs.grep("audio", since_pos=pos)
    assert len(matches) >= 1, (
        f"no gateway-side audio activity observed within "
        f"{kUplinkFrameProbeSec}s of button press; "
        f"gateway log additions since press: {len(matches)}"
    )


@pytest.mark.group_a
def test_ws_disconnect_recovery(cube_dut):
    """ws.disconnect verb forces a reconnect within 30 s."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"
    assert s["ws_connected"] is True

    # ws.disconnect actually closes the underlying WS; xiaozhi's reconnect
    # logic should re-establish it inside the recovery window.
    cube_dut.cmd("ws.disconnect", timeout=5)

    # Confirm we observed the disconnect (give the daemon a moment).
    time.sleep(1.0)
    s = cube_dut.cmd("state", timeout=5)
    # state may briefly be CONNECTING; ws_connected should be false.
    if s["ws_connected"] is True:
        pytest.fail(f"ws.disconnect did not take effect: {s}")

    # Wait for recovery.
    deadline = time.time() + kWsDisconnectRecoverySec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["ws_connected"] is True:
            return
        time.sleep(2.0)
    pytest.fail(f"ws did not reconnect within {kWsDisconnectRecoverySec}s; last={s}")


@pytest.mark.group_a
def test_cube_alive_after_voice_loop_smoke(cube_dut):
    """Smoke: after the suite above, the cube is still IDLE + responsive."""
    state = cube_dut.cmd("state", timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True
```

- [ ] **Step 2: Run the tests against the pre-Phase-5 firmware (red phase verification)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube
source /Users/kevinye/Development/sentient/.venv/bin/activate 2>/dev/null \
  || source /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/tests/hil/.venv/bin/activate 2>/dev/null \
  || true
pytest tests/hil/test_voice_loop.py -v -m group_a 2>&1 | tail -30
```

Expected behavior on the **pre-Phase-5 firmware (test screen still active)**:
- `test_boot_to_idle`: PASSES (WS is up regardless of UI; pre-Phase-5 firmware already reaches IDLE)
- `test_toggle_to_listening`: may PASS or FAIL — depends on whether `button.toggle` still calls `ToggleChatState` (it does; see `sentient_cube.cc:101`). If it PASSES, that's fine — it confirms the button wiring is independent of the UI screen. If it FAILS, that's also fine — Task 5 reflash will green it.
- `test_toggle_emits_uplink_frames`: may pass or fail depending on whether the gateway is fully wired today.
- `test_ws_disconnect_recovery`: PASSES (ws.disconnect verb is independent of UI).
- `test_cube_alive_after_voice_loop_smoke`: PASSES.

Capture the exact pass/fail counts in your subagent report. Do NOT modify the test to make it pass on pre-Phase-5 firmware.

- [ ] **Step 3: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
git add esp32/cube/tests/hil/test_voice_loop.py
git commit -m "test(esp32-cube/hil): test_voice_loop — Group A smoke"
```

---

## Task 4: HIL test_ws_recovery.py (Group A, WiFi loss isolation)

**Files:**
- Create: `esp32/cube/tests/hil/test_ws_recovery.py`

Per spec smoke bar: `test_wifi_loss` is a separate Group A case. Keeping it in its own file isolates it — WiFi loss takes longer to recover than WS disconnect, so a flake here shouldn't drag down the voice-loop file's reporting.

- [ ] **Step 1: Create the test file**

`esp32/cube/tests/hil/test_ws_recovery.py`:

```python
"""Phase 5 WiFi + WS recovery smoke (Group A).

Verifies the cube auto-recovers from a forced WiFi disconnect within the
expected window. Run sequentially after test_voice_loop.py because a WiFi
cycle is the most disruptive single test in the suite.

These tests assume the cube is online and at IDLE before the first case.
"""
from __future__ import annotations

import time

import pytest


kWifiDisconnectDetectSec = 10
kWifiReconnectSec = 60
kWsReconnectAfterWifiSec = 30


@pytest.mark.group_a
def test_wifi_disconnect_takes_ws_down(cube_dut):
    """wifi.disconnect verb causes ws_connected to flip to False within 10 s."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE", f"precondition violated: state={s['state']}"
    assert s["wifi_connected"] is True
    assert s["ws_connected"] is True

    cube_dut.cmd("wifi.disconnect", timeout=5)

    deadline = time.time() + kWifiDisconnectDetectSec
    last = None
    while time.time() < deadline:
        last = cube_dut.cmd("state", timeout=5)
        if last["wifi_connected"] is False or last["ws_connected"] is False:
            return
        time.sleep(1.0)
    pytest.fail(
        f"wifi.disconnect did not deactivate WiFi/WS within "
        f"{kWifiDisconnectDetectSec}s; last={last}"
    )


@pytest.mark.group_a
def test_wifi_reconnect_restores_ws(cube_dut):
    """After a wifi.reconnect, both wifi and ws come back within their windows.

    Depends on `test_wifi_disconnect_takes_ws_down` having JUST run — this
    test issues `wifi.reconnect` against a cube whose WiFi was just downed.
    Pytest runs tests in file order within one module; the file ordering
    guarantees this precondition.
    """
    cube_dut.cmd("wifi.reconnect", timeout=5)

    # Wait for WiFi first.
    deadline = time.time() + kWifiReconnectSec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["wifi_connected"] is True:
            break
        time.sleep(2.0)
    else:
        pytest.fail(f"wifi did not reconnect within {kWifiReconnectSec}s")

    # Now wait for WS.
    deadline = time.time() + kWsReconnectAfterWifiSec
    while time.time() < deadline:
        s = cube_dut.cmd("state", timeout=5)
        if s["ws_connected"] is True:
            return
        time.sleep(2.0)
    pytest.fail(f"ws did not reconnect within {kWsReconnectAfterWifiSec}s after wifi up")


@pytest.mark.group_a
def test_cube_alive_after_wifi_recovery(cube_dut):
    """Final sanity: cube is back to IDLE + fully connected."""
    s = cube_dut.cmd("state", timeout=5)
    assert s["state"] == "IDLE"
    assert s["wifi_connected"] is True
    assert s["ws_connected"] is True
```

- [ ] **Step 2: Run the tests against pre-Phase-5 firmware (red phase verification)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube
pytest tests/hil/test_ws_recovery.py -v -m group_a 2>&1 | tail -30
```

Expected on pre-Phase-5 firmware:
- `test_wifi_disconnect_takes_ws_down`: should PASS (wifi.disconnect verb exists from Phase 1; behavior is independent of UI).
- `test_wifi_reconnect_restores_ws`: should PASS.
- `test_cube_alive_after_wifi_recovery`: should PASS.

The voice-loop file's `test_toggle_emits_uplink_frames` may already be the only Phase-5-dependent test in this round. That's fine — Task 5 reflash brings everything fully green together.

- [ ] **Step 3: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
git add esp32/cube/tests/hil/test_ws_recovery.py
git commit -m "test(esp32-cube/hil): test_ws_recovery — wifi + ws recovery cases"
```

---

## Task 5: Bundled flash + device smoke (no commit unless fix needed)

**Goal:** Single flash, then run the full Phase 5 smoke bar (visual UI verification + HIL Groups A from voice_loop + ws_recovery files + existing Phase 3/4 HIL files).

- [ ] **Step 1: Pre-flash daemon + state check**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: returns IDLE within 3 s. If wedged, recover via physical USB unplug + BOOT-hold replug BEFORE flashing. See `.claude/rules/esp32/cube/flash-discipline.md`.

- [ ] **Step 2: Kill the daemon BEFORE flashing**

The Phase 4 Task 8 retry surfaced a `flash.sh` ordering bug: it tears down the daemon AFTER esptool runs, but esptool needs the port free at startup. Manual kill avoids the failed-connect path:

```bash
if [ -e /tmp/cube-daemon.pid ]; then
  pid=$(cat /tmp/cube-daemon.pid 2>/dev/null)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    sleep 0.5
  fi
fi
rm -f /tmp/cube-daemon.sock /tmp/cube-daemon.pid 2>/dev/null
```

- [ ] **Step 3: Flash**

```bash
bash esp32/cube/scripts/flash.sh
```

Expected: clean flash, ~30-60 s. Cube reaches IDLE within ~8 s. Daemon eagerly spawns post-flash.

If the flash drops mid-write (the Phase 4 4%-drop scenario), STOP and escalate. Operator BOOT-hold recovery required before retry.

- [ ] **Step 4: Visual UI verification**

```bash
bash esp32/cube/scripts/cube-snapshot.sh /tmp/phase5-boot.png
```

Then `Read /tmp/phase5-boot.png` to inspect. Expected: toggle-button screen visible — a large circular button (320 px) centered on a dark background, status hint label above. NOT the gradient-bar test screen.

If you see the test screen, the UI swap in Task 2 didn't land — re-verify the source diff and rebuild.

- [ ] **Step 5: Verify `>>> READY` + checkpoint markers fire**

```bash
python3 -c "
import socket, json, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/cube-daemon.sock')
s.sendall(json.dumps({'kind':'events','n':20000}).encode())
buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
sys.stdout.write(buf.decode())
" | grep -E '>>> READY|>>> CHECKPOINT' | head -20
```

Expected: at least one `>>> READY` line. At least one `>>> CHECKPOINT ws.connected` line. The polling task in `sentient_ui_controller.cc::poll_state_task` is the only source — its existence proves the Phase-5 UI swap took effect.

If no markers appear, the poll task didn't spawn — check `sentient_cube_create_toggle_button_screen()` is actually called.

- [ ] **Step 6: Press the physical button manually and verify state transitions**

This is operator-driven (one-line task). Operator presses the physical boot button on the cube. Then:

```bash
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: `state` may be `LISTENING` (if button is held / just toggled) or `IDLE` (if released and the gateway hasn't responded yet). Either is acceptable — the test that the button is wired runs in the next step via the `button.toggle` verb.

- [ ] **Step 7: Run HIL voice_loop suite**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube
source /Users/kevinye/Development/sentient/.venv/bin/activate 2>/dev/null \
  || source /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/tests/hil/.venv/bin/activate 2>/dev/null \
  || true
pytest tests/hil/test_voice_loop.py -v -m group_a 2>&1 | tail -40
```

Expected: 5/5 PASSED.

If `test_toggle_emits_uplink_frames` fails on the gateway-log substring match, capture the actual gateway log additions since the press (the test fixture's `gateway_logs.grep` may need a different substring). Do NOT modify the test before discussing — log shape changes go in a separate commit.

- [ ] **Step 8: Run HIL ws_recovery suite (last — most disruptive)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube
pytest tests/hil/test_ws_recovery.py -v -m group_a 2>&1 | tail -30
```

Expected: 3/3 PASSED. Total wall-clock ~60-90 s due to WiFi reconnect window.

- [ ] **Step 9: Run the Phase 3+4 HIL files (regression guard)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube
pytest tests/hil/test_audio_play_pcm.py tests/hil/test_audio_record.py tests/hil/test_smoke.py -v -m group_a 2>&1 | tail -30
```

Expected: 12/12 PASSED (Phase 3 has 5, Phase 4 has 7, smoke has 2 → 14 total; adjust counts to whatever's actually in those files).

- [ ] **Step 10: Daemon log clean check**

```bash
python3 -c "
import socket, json, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/cube-daemon.sock')
s.sendall(json.dumps({'kind':'events','n':20000}).encode())
buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
sys.stdout.write(buf.decode())
" > /tmp/phase5-postsmoke.txt
grep -iE 'WARN|ERROR' /tmp/phase5-postsmoke.txt \
  | grep -v -E 'pre-WiFi|Haven.t to connect|wifi:bcn_timeout|esp_netif_lwip|bcn_timout' \
  | head -30
```

Expected: no unexpected WARN/ERROR from `sentient.cube.audio_service`, `sentient.cube.agent_console.*`, `sentient.cube.protocol.websocket`, or `sentient.cube.ui.*`.

No commit. Smoke evidence captured in Task 7 handover.

---

## Task 6: Operator voice round-trip + barge-in (Group B, manual)

**Goal:** Validate the full voice loop with a real utterance + LLM response on the local gateway. Operator-driven; cannot be automated.

**Requires:** Local Docker stack running (`deploy/macos/`) with gateway + STT + Hermes worker reachable from the cube at `SENTIENT_GATEWAY_HOST`.

- [ ] **Step 1: Confirm gateway responsiveness**

```bash
cd /Users/kevinye/Development/sentient
curl -sf http://localhost:${GATEWAY_HTTP_PORT:-8888}/health 2>&1 | head -5
```

Or whatever the gateway's health endpoint is. If the gateway isn't up, STOP and bring it up first.

- [ ] **Step 2: Voice loop ear test**

Operator action:
1. Press the physical button on the cube
2. Speak a clear question, e.g., "what time is it?"
3. Release the button

Expected:
- Display state transitions visually: idle → listening (during press) → speaking (when response arrives)
- Speaker plays back the gateway's spoken response
- The response is intelligible and topically relevant

After the response plays:

```bash
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: back to `IDLE` + connected.

Record: ✅ recognizable response | ❌ silence / wrong response / cube stuck.

- [ ] **Step 3: Barge-in ear test (spec Group B)**

Operator action:
1. Press the button, ask a question that triggers a longer response (e.g., "tell me about the weather")
2. Release; wait for the speaker to START playing
3. WHILE the speaker is still playing, press the button again

Expected:
- Speaker stops playback
- Display transitions to LISTENING (the new mic capture starts)
- Operator can speak a follow-up utterance

After the operator releases the second press, the cube should respond to the second utterance (not continue the first).

Record: ✅ clean barge-in | ❌ first response continues / cube freezes / unclear.

- [ ] **Step 4: Capture evidence in the handover**

Note in the handover's "What's smoked" table:
- Voice loop ear test: ✅ | ⚠️ | ❌ — one-line observation
- Barge-in ear test: ✅ | ⚠️ | ❌ — one-line observation

If either ⚠️ or ❌, capture the gateway log slice (around the failure) AND the cube daemon ring buffer slice for the same window. Both go into the handover as evidence.

No commit. This is observation only.

---

## Task 7: Phase 5 handover doc

**Files:**
- Create: `docs/superpowers/handovers/2026-05-13-esp32-cube-phase5-sentient-connect.md`

- [ ] **Step 1: Write the handover**

Use the format mandated by spec §5 verbatim. Required sections IN ORDER:

```
# ESP32 Cube Phase 5 — Sentient Connect Handover

**Date:** 2026-05-13
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-13-esp32-cube-v2-phase5-sentient-connect.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §4 Phase 5

## What's done
- <one bullet per merged commit, plain language, no SHAs>

## What's used (stack the user now owns)
- File: <path> — <one-line responsibility>
- Component: <name> — <what it does, who calls it>
- Verb: <agent_console verb> — <example invocation>

## What's smoked
- <case>: <command run> → <observed result> (✅ green | ❌ red)
- Log evidence: <path or inline quote>

## What you need to know
- 2–5 bullets, things the agent learned that the user would not derive from code

## Hardware glossary (terms new this phase)
- **<term>**: <plain definition + why it matters to this cube>

## Open questions / risks
- One bullet per uncertainty.

## Flash + smoke metrics
- Flashes this phase: <n>
- AXP2101 faults hit: <n>
- Daemon restarts: <n>
- Cold physical recoveries: <n>
- Total dev time on smoke runs: <approx hours>
```

Fill from the actual numbers + observations from Task 5 + Task 6 smoke. Specifically:

- `What's done`: 3 commits (UI swap, voice_loop HIL, ws_recovery HIL) + this handover commit = 4 total.
- `What's used`: the toggle-button screen is back as boot UI; `>>> READY` + state checkpoint markers are restored; voice loop is live against the local gateway via `WebsocketProtocol` + Settings NVS-seeded URL + PASETO.
- `What's smoked`: every case from Task 5 step 7-10 + Task 6 step 2-3. ✅/⚠️/❌ for each.
- `What you need to know`: at minimum:
  1. The `>>> READY` and `>>> CHECKPOINT` markers are now back. Any HIL test that consumed them in Phase 1 should be revisited.
  2. The `Authorization: Bearer <PASETO>` header model means the gateway is the single point of token validation. If a future cube needs to re-pair, just re-bake creds; no on-device activation flow exists.
  3. xiaozhi's `Application::ToggleChatState()` is the SINGLE entry point that flips IDLE → Listening → Speaking. Phase 5 doesn't add new states; the spec's `ListeningOnPress / Streaming / ReleaseFlush / AwaitingResponse` are all sub-phases of xiaozhi's `kDeviceStateListening` + `kDeviceStateSpeaking` for display purposes.
  4. `flash.sh` has a known sequencing bug (daemon teardown after esptool runs); Task 5 worked around it manually. Fix queued for Phase 5+ cleanup.
- `Hardware glossary`: NEW terms only (none new in Phase 5 — the toggle-button screen and the state markers are pre-existing; reference earlier phase glossaries).
- `Open questions / risks`: at minimum:
  1. Barge-in behavior depends on the gateway's TTS-cancel handling. If Task 6 step 3 was anything other than ✅, document the failure mode and link to the gateway-side investigation.
  2. The pre-existing `flash.sh` ordering bug (line 38-40 should move before line 32) is a latent footgun for any operator who pre-warms the daemon before flashing.
  3. The codec input gain remains at 30 (Phase 4 carry-over). If the full voice loop has quality issues, gain tune is the first thing to try in Phase 6+.
- `Flash + smoke metrics`: from Task 5 actual numbers.

- [ ] **Step 2: Commit the handover**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope
git add docs/superpowers/handovers/2026-05-13-esp32-cube-phase5-sentient-connect.md
git commit -m "docs(esp32-cube): Phase 5 sentient-connect handover"
```

---

## Self-review (controller, post-write)

**Spec coverage check:**

| Spec §4 Phase 5 requirement | Task |
|---|---|
| Restore toggle-button-screen as default boot UI | Task 2 |
| Wire WS protocol to gateway URL + PASETO auth | Already done in Phase 1 (`InjectWebsocketConfig`); Task 1 survey verifies; no new wiring |
| AudioService input feeds opus encoder → WS uplink | Already wired by xiaozhi (`application.cc:402` constructs `WebsocketProtocol` which uses `protocol_->SendAudio`); no new code |
| WS downlink opus frames → opus decoder → AudioService output | Already wired by xiaozhi (`protocol_->OnIncomingAudio` → playback queue); no new code |
| Device state machine IDLE → Listening → Streaming → ReleaseFlush → AwaitingResponse → Speaking → IDLE | Already implemented in xiaozhi (`DeviceState` enum); the spec's intermediate names map to sub-phases of existing states. No new code. |
| Smoke: `cube-cmd state` reports IDLE after WS connected | Task 5 step 7 + `test_boot_to_idle` |
| Smoke: press toggle → state Listening → gateway sees mic frames | `test_toggle_to_listening` + `test_toggle_emits_uplink_frames` |
| Smoke: release toggle → gateway responds → speaker plays response | Task 6 step 2 (operator ear test) |
| HIL Group A (test_boot, test_mic_toggle, test_ws_disconnect, test_wifi_loss, test_reboot, test_udp_log_shipping, test_bad_paseto) | test_voice_loop covers test_boot + test_mic_toggle + test_ws_disconnect; test_ws_recovery covers test_wifi_loss; test_reboot/test_udp_log/test_bad_paseto are NOT in this plan |
| HIL Group B (test_voice_loop, test_barge_in) | Task 6 manual ear tests (Group B is operator-driven by definition) |
| test_long_uplink (Group A) | Already covered by Phase 3 chunked `inject_pcm` |

**Gaps from spec smoke bar:**
- `test_reboot` — would test `restart` verb + auto-recovery. NOT in this plan because the `restart` verb already works and was tested in Phase 1. Add a one-liner case if needed.
- `test_udp_log_shipping` — would test `net_logger` UDP output is reaching the gateway. NOT in this plan because Phase 1 already smoked it. Worth adding a one-liner if we want pin-tight regression coverage.
- `test_bad_paseto` — would test a bad token fails the WS handshake. NOT in this plan because it requires re-baking creds with a bad token, then re-baking with the good token. Disruptive; defer to a Phase 6+ "stress" task.

**Decision:** include `test_reboot` and `test_udp_log_shipping` in `test_voice_loop.py` as additional cases if the implementer's review surfaces them as easy wins. Skip `test_bad_paseto` as a follow-up.

**Placeholder scan:** no `TBD`, no `TODO` in tasks (the `TODO: source from xiaozhi's AudioService stats` in `audio_misc.cc` is Phase 4 carry-over, not new).

**Type consistency:**
- HIL test functions all take `cube_dut` fixture; `test_toggle_emits_uplink_frames` adds `gateway_logs` fixture (already exists in `conftest.py`).
- `cube_dut.cmd(method, params=None, timeout=...)` signature used uniformly.
- State strings (`"IDLE"`, `"LISTENING"`, `"SPEAKING"`) match what the `state` verb emits (per the existing `test_smoke.py::test_state_verb_roundtrip` enumeration).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-esp32-cube-v2-phase5-sentient-connect.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
