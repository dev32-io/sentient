# ESP32 Cube Testing — Details

## Transport ownership

Use the provided HIL fixtures and `esp32-devtool`; do not add mocks for hardware
transport or hand-written pyserial access. The daemon owns USB-CDC. A test must
not have `cube_dut` and `serial_dut` read the same port concurrently: coordinate
through the fixture/session contract, or use the daemon ring and command result
instead of a second reader.

`cube_dut.cmd("state")` exercises the USB verb registry. Use `serial_dut` only
for the fixture-supported checkpoint path, with generous timeouts for WiFi/WS
reconnects. After an asynchronous action, wait for its checkpoint before making
a state assertion; avoid asserting transient `CONNECTING` state immediately
following `button.toggle`.

For gateway assertions, record the log position before the action and search
only newly received lines. UDP log relay is optional (manifest port 9000 and
may be disabled), so tests should use the supported USB/ring path when relay
availability is not part of the behavior under test.

The HTTP screenshot surface is `GET /screenshot`, exercised through
`esp32-devtool screenshot`; there is no `ui.snapshot` USB verb. Keep UI simulator
checks separate from device smoke: a green simulator run never replaces a
required device test.

Run host/unit and fixture checks without hardware where possible. Hardware smoke,
flash, and physical recovery require explicit hardware availability and should
not be improvised in a non-hardware validation pass.
