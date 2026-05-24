# ESP32 Cube Testing — Details & Examples

## CubeDut.cmd / expect_checkpoint patterns

### Basic verb roundtrip (Group A)

```python
def test_state_returns_known_fields(cube_dut):
    state = cube_dut.cmd("state")
    assert "state" in state
    assert isinstance(state["wifi_connected"], bool)
    assert state["state"] in ("IDLE", "CONNECTING", "LISTENING", "SPEAKING", ...)
```

### Cross-stack assertion with gateway_logs

```python
def test_button_toggle_emits_ws_message(cube_dut, gateway_logs):
    # Capture position BEFORE the action so grep only sees new lines.
    pos = gateway_logs.position()

    cube_dut.cmd("button.toggle")

    # Allow time for the gateway to receive and log the mic-start event.
    import time; time.sleep(1.5)

    lines = gateway_logs.grep("listen-start", since_pos=pos)
    assert lines, f"expected listen-start in gateway logs after button.toggle, got none"
```

### Checkpoint via serial_dut (Group B)

```python
@pytest.mark.group_b
def test_wifi_reconnect_checkpoint(cube_dut, serial_dut):
    cube_dut.cmd("wifi.disconnect")
    serial_dut.expect(r">>> CHECKPOINT wifi\.disconnected \d+", timeout=10)

    cube_dut.cmd("wifi.connect")
    serial_dut.expect(r">>> CHECKPOINT wifi\.connected \d+", timeout=15)
```

---

## Flaky test: tight checkpoint timeouts

`expect_checkpoint(label, timeout=5)` is often too tight when the WiFi reconnect
path is involved. Association can take 3-8s on a congested network. Use 10-15s for
any test that goes through WiFi or WS reconnect:

```python
# Too tight — flaky on 5GHz band with interference:
cube_dut.expect_checkpoint("ws.connected", timeout=5)

# Reliable:
cube_dut.expect_checkpoint("ws.connected", timeout=15)
```

---

## Common pattern: toggle + state without races

`button.toggle` routes through the state machine: Idle → Connecting → Listening.
A `state` verb issued immediately after `button.toggle` may catch the `CONNECTING`
transient rather than `LISTENING`.

Pattern: send toggle, wait for the `listen.start` checkpoint, THEN read state:

```python
def test_toggle_reaches_listening(cube_dut, serial_dut):
    cube_dut.cmd("button.toggle")
    serial_dut.expect(r">>> CHECKPOINT listen\.start \d+", timeout=15)
    state = cube_dut.cmd("state")
    assert state["state"] == "LISTENING"
```

If `serial_dut` is not available (Group A only), poll with a short sleep:

```python
import time

def test_toggle_group_a(cube_dut):
    cube_dut.cmd("button.toggle")
    time.sleep(3)  # allow Connecting → Listening transition
    state = cube_dut.cmd("state")
    assert state["state"] in ("CONNECTING", "LISTENING")
```

---

## Group C runbook (human-driven)

Cases C12-C15 require physical interaction and must be run manually.

### C12: real-mic voice loop
1. Start `bash esp32/cube/scripts/monitor.sh` and tail `gateway/logs/cube-cube-001-*.log`.
2. Tap the toggle button on the cube screen to activate mic.
3. Say "hello sentient" into the cube microphone.
4. Expected: gateway logs show STT → cognitive cycle → TTS trail. Speaker plays a
   response. Confirm audibly.
5. Tap toggle again to stop. Expected: `>>> CHECKPOINT listen.stop <ts>` on serial.

### C13: real-mic barge-in mid-TTS
1. Trigger a voice loop (C12). Wait for TTS audio to start playing.
2. Speak over the speaker while TTS is playing.
3. Expected: speaker cuts within ~500ms. Gateway logs show `tts.stop` with barge-in.

### C14: stuck DOWNLOAD_MODE recovery
1. If `bash scripts/flash.sh` hangs at "Connecting..." for > 10s: cube is not in
   download mode.
2. Hold BOOT, tap RST, release BOOT.
3. Re-run `bash scripts/flash.sh`. Expected: succeeds.

### C15: cold-boot cable unplug/replug
1. While cube is running, unplug USB-C from Mac.
2. Wait 5s, then re-plug.
3. Expected: `tio` reconnects within 2s (auto-connect mode). Subsequent
   `bash scripts/flash.sh` works without manual reset.

---

## Stuck-cube recovery during a test run

If the cube stops responding during a test suite run:

1. Unplug USB-C from Mac.
2. Hold BOOT button.
3. Plug USB-C back in while holding BOOT.
4. Release BOOT. Cube is now in download mode.
5. Run `bash esp32/cube/scripts/flash.sh`.
6. Resume the test run from the failed case.

The `conftest.py` `cube_port` fixture is session-scoped and re-detects the port on
re-connection — no fixture teardown needed for port changes.
