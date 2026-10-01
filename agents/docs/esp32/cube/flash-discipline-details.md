# ESP32 Cube Flash Discipline — Details

The USB-only architecture uses a single factory application, not OTA slots or automatic rollback. Initial migration must preserve NVS, PHY and enrollment offsets; inspect generated flash ranges before writing. Do not erase-all. A faulty or interrupted update requires USB recovery, not selecting an older OTA slot. See `esp32/cube/docs/firmware-assets.md` (repository-relative).

Treat a flash as a deliberate smoke boundary, not a way to inspect state. Group
related code changes, build once, inspect available evidence, then flash once for
the diagnosed smoke unit. Do not flash a wedged or unresponsive cube merely to
see whether it recovers.

For explicitly approved local debug flashing, use `esp32-devtool flash --profile debug`. The CLI also supports prod, but capability is not production authorization. The devtool daemon owns USB-CDC and keeps the ring available across boot; do not launch
`idf.py monitor`, an unmanaged flash/monitor script, or a competing serial reader. The interactive `esp32/cube/scripts/flash.py` wizard is allowed: it discovers USB candidates, requires target/profile confirmation, delegates to the same devtool and never opens serial itself.

Before another flash, inspect the daemon ring, `esp32-devtool cmd state` when
responsive, approved non-sensitive HTTP screenshots where relevant, and decoded panic addresses. Never bypass bootstrap screenshot refusal or substitute a tree dump: populated pairing labels, even hidden ones, can leak through `ui.dump_tree`. Do not request `sentient.last_transcript` for real-user sessions. A repeated failure is a reason to stop and read the implementation,
not to cycle hardware blindly. Keep flash count and any recovery/restart facts
in the handoff when they affect confidence.

Managed debug flash waits for companion readiness and either a settled application state or healthy BLE bootstrap. A fresh cube may remain `UNKNOWN`; the verifier accepts it only when `cube.hardware.status` reports bootstrap, active BLE, no fatal failure and an empty error. A timeout does not establish bad credentials or justify reflashing; inspect bounded `cube.hardware.status` and return unresolved readiness to the operator.

If the cube is physically wedged, stop and return control to the hardware owner
for recovery. This guidance is intentionally valid without touching hardware.
