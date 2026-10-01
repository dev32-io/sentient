# Sentient ESPProvision ownership patch

Source: https://github.com/espressif/esp-idf-provisioning-ios
Revision: `78e58f010f8539f800bce063a26d3e4c4ac596b9` (Apache-2.0).
Only Package.swift, LICENSE and ESPProvision library sources vendored.

Local changes:
- `ESPDevice.invalidate()` terminal main-queue teardown releases credentials,
  session/security, callbacks and BLE transport. Late queued session setup fails.
- BLE status delegate weak; teardown stops timers, detaches CoreBluetooth delegates,
  drops queued/in-flight requests, disconnects and clears credential references.
- BLE response delivery stays on CoreBluetooth's main queue, serialized with teardown.
  Previously global-queue delivery raced cancellation/session state.
- Stopping manager search releases discovered devices and callback captures; stopped
  searches cannot restart when a queued powered-on notification arrives.

Cube uses a fresh device per connection. `disconnect()` remains upstream behavior;
`invalidate()` is terminal and intentionally does not invoke obsolete callbacks.
No cryptographic algorithm changes. Clearing references is not guaranteed zeroization
of Swift String/Data copies. Simulator ownership regressions live in
`ios/Tests/CubeHardwareBoundaryTests.swift`.
