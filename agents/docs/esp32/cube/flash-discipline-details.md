# ESP32 Cube Flash Discipline — Details

Pure-rule version: `.claude/rules/esp32/cube/flash-discipline.md`.

## Why flash discipline matters here specifically

The cube is a Waveshare ESP32-S3-Touch-AMOLED-2.16 with an AXP2101 PMIC. On
this board, **the binding constraint on rapid flash cycles is the PMIC, not
the flash**. The PMIC enters a stuck I2C init state under conditions we
have not fully characterized but which correlate with frequent
reset/flash cycles. Recovery is physical: USB unplug, hold BOOT button,
replug while holding, release BOOT. The cube can run for many minutes
post-recovery before re-faulting; rapid cycle pressure brings the next
fault sooner.

We have NOT observed flash-sector wear during this project. NOR flash on
the ESP32-S3 is rated ~100k erase cycles per 4KB sector. At our worst
historical pace (~50 flashes/day on intensive days), we would need ~8 years
to wear out a single sector in the app partition. The mask-ROM
bootloader is physically immutable and cannot be wear-damaged by any
firmware path.

## What a "smoke-bar unit" looks like

A smoke-bar unit is **one merge-ready batch of commits that share a single
flash to verify**. Concrete examples from our history:

- ✅ Good: 3 commits — "agent_console: add audio.inject_pcm verb",
  "agent_console: increase rx buffer to 64KB", "scripts: daemon big-payload
  recv". Flash once. Smoke runs: `cube-cmd state`, `cube-cmd tts.cancel`,
  `cube-cmd audio.inject_pcm --file=hello.pcm`. All green → merge.

- ❌ Bad: edit verb code → flash → see error in log → edit again → flash →
  fix typo → flash → smoke green. Three flashes for one logical change.
  Each one was another DTR/RTS reset cycle, increasing AXP2101 risk and
  burning ~30s of dev time on stub upload + auto-reset wait. The right move
  was to read all three lines from the error log on the first failure and
  apply all three fixes in one batch before re-flashing.

## AXP2101 fault — what to recognize

Boot log line that signals the fault has triggered:

    ESP_ERROR_CHECK failed: esp_err_t 0x103 (ESP_ERR_INVALID_STATE)
    at 0x42020009
    file: "./main/boards/common/i2c_device.cc" line 24
    func: void I2cDevice::WriteReg(uint8_t, uint8_t)

This fires **before app_main** runs. It is upstream/xiaozhi code, not ours.
Our patches/edits cannot intercept it. Reboot loops at this point.

Recovery: unplug USB, hold BOOT, replug while holding, release BOOT after
~2s. Cube enters download mode. Flash a known-good firmware, reset (BOOT
button single press), normal boot returns. The PMIC is now in a clean
state for ~minutes-to-hours.

## DTR/RTS auto-reset background

ESP32-S3's USB-Serial-JTAG hardware translates host CDC SET_CONTROL_LINE_STATE
into strap pin manipulation:

- DTR low + RTS high → EN low → CPU reset
- DTR high + RTS low → IO0 low → boot mode if held during reset

macOS sends SET_CONTROL_LINE_STATE on every `open()` of the CDC port. Every
pyserial open with default flags resets the cube. Every `idf.py monitor`
launch resets the cube. Every `cube-cmd` invocation that opens a fresh
port resets the cube.

Mitigation: `_cube_daemon.py` holds the port open across many CMDs and
sets `dtr=False rts=False dsrdtr=False rtscts=False` to avoid the toggle
chord on open. Pyserial actually has to drive these lines low BEFORE the
port is opened or macOS will still send the strap chord — that's why the
order matters.

## Flash count budget per phase

Realistic budget:

| Phase | Target flashes | Stretch limit | Rationale |
|---|---|---|---|
| 1 Foundation | 1 | 3 | Boot + state CMD + UDP log; minimal moving parts |
| 2 Display+Touch | 2 | 4 | LVGL setup is tricky; one iteration acceptable |
| 3 Speaker | 2 | 4 | Codec init pin pinouts often need one correction |
| 4 Mic | 2 | 4 | Same — DMA buffer sizing iterates once |
| 5 Sentient | 3 | 5 | More integration surface, more flake risk |

Over budget = stop and root-cause. Three flashes that all fail with
similar errors is a code-reading problem, not a flash-once-more problem.

## Track "boots since last cold-recovery"

The daemon's log captures boot count via the `>>> READY` marker emitted on
first ws.connected each boot. After ~30 boots without a clean physical
unplug-replug cycle, AXP2101 fault probability rises. Proactively
recover before a critical smoke run — schedule it before, not during, a
test pass that you need to be clean.

## Anti-patterns we've already paid for

- **Flashing onto a wedged cube** — deepened a PMIC fault once in
  Phase 4. The cube took two physical recoveries to fully recover. Don't
  flash if `cube-cmd state` doesn't respond in 3s.

- **Restarting the daemon to "make it work"** — each daemon restart =
  one port-close-open = one reset chord on macOS. Restart only if the
  daemon is actually broken (check pidfile, check socket). If the daemon
  is alive but the cube isn't responding, the cube is the problem, not
  the daemon.

- **Running `idf.py monitor` while daemon is up** — both fight for the
  port. The monitor wins, daemon dies, on its way down it tries one more
  open, reset chord fires. Always pick one tool per session.

## Flash + smoke evidence schema

Any merge-ready writeup (PR description, plan-specific handover, spec
section) MUST include:

    ## Flash + smoke metrics
    - Flashes this batch: <n>
    - AXP2101 faults hit: <n>
    - Daemon restarts: <n>
    - Cold physical recoveries: <n>
    - Total dev time on smoke runs: <approx hours>

These numbers let the user sanity-check pace and let the agent adjust the
budget for the next batch.
