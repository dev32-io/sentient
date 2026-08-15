# ESP32 Cube Flash Discipline — Details

Treat a flash as a deliberate smoke boundary, not a way to inspect state. Group
related code changes, build once, inspect available evidence, then flash once for
the diagnosed smoke unit. Do not flash a wedged or unresponsive cube merely to
see whether it recovers.

Use the managed path, `esp32-devtool flash --profile debug|prod`. The devtool
daemon owns USB-CDC and keeps the ring available across boot; do not launch
`idf.py monitor`, `monitor.sh`, `flash.sh`, or a competing serial reader.

Before another flash, inspect the daemon ring, `esp32-devtool cmd state` when
responsive, the HTTP screenshot/UI tree where relevant, and decoded panic
addresses. A repeated failure is a reason to stop and read the implementation,
not to cycle hardware blindly. Keep flash count and any recovery/restart facts
in the handoff when they affect confidence.

If the cube is physically wedged, stop and return control to the hardware owner
for recovery. This guidance is intentionally valid without touching hardware.
