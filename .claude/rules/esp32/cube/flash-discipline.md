---
paths:
  - "esp32/cube/**"
---
# ESP32 Cube Flash Discipline Rules

> When a rule is unclear, read `agents/docs/esp32/cube/flash-discipline-details.md`.

- Flash count, not flash wear, is the binding constraint. The AXP2101 PMIC enters an unrecoverable I2C init fault state after repeated reset cycles. Recovery requires physical USB unplug + BOOT-hold replug. NOR flash itself has ~100k cycles/sector headroom — never the bottleneck under realistic dev pace.

- One flash per smoke-bar unit. A smoke-bar unit is one merge-ready commit batch — typically 2-5 commits inside one phase PR. Edit → build → edit → build → ... → flash + smoke ONCE. If smoke fails, debug from logs first; only re-flash after a code change.

- Target ≤ 5 flashes per phase. Each phase's smoke bar must run green on a single flash. If a phase needs more than 5 flashes to reach green, stop and root-cause the flake before merging — do not paper over with retries.

- Never flash to "see what happens." Every flash MUST be paired with: a written smoke bar, a checklist of what's expected, and a stop condition for what counts as red. No exploratory flashes.

- The `esp32-devtool` daemon (auto-spawned on first command) MUST be running before any smoke. Daemon mitigates DTR/RTS auto-reset between CMDs. Killing + restarting the daemon (`esp32-devtool daemon stop`/`start`) counts as a reset; minimize.

- After any AXP2101 fault recovery (physical unplug + BOOT-hold), restart the smoke bar from scratch. Do not assume mid-run state carried over. Log the recovery in the phase handover's "what you need to know" section.

- Pyserial opens MUST use `dtr=False rts=False dsrdtr=False rtscts=False`. Any helper script that opens the cube's USB-CDC without these flags will auto-reset the cube on open — fix the script before merging.

- Background `monitor` sessions count as serial-port owners. The daemon holds the port; `idf.py monitor` will fight it. Use `esp32-devtool logs --follow` instead, which multiplexes off the daemon.

- Track "boots since last cold recovery" as a loose health signal. Once past ~30, expect AXP2101 fault risk to rise — proactively schedule a clean recovery before a critical smoke run.

- Never flash to a wedged cube. If `esp32-devtool cmd state` doesn't return in 3s, the cube is wedged — recover first, do not flash on top. Flashing a wedged cube can deepen the fault.

- Any merge-ready writeup (PR description, phase handover, spec section) MUST record: flash count, AXP2101 faults hit, daemon restarts. These are part of the smoke evidence trail.

- After `esp32-devtool flash --profile debug`, the daemon eagerly respawns and captures the cube's boot trace from ROM bootloader through the first `IDLE` state — no separate `monitor` session needed. Inspecting the daemon ring buffer is the canonical way to read post-flash boot state WITHOUT re-flashing: `esp32-devtool daemon ring --lines 20000`. Ring buffer holds ~20000 lines — full boot trace plus minutes of runtime.
