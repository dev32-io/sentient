# ESP32 Cube Testing — Details

## Host checks

Source `scripts/env.sh`, then use `python3 -m pytest -q esp32/cube/tests/unit` for the offline suite. `unittest discover` alone misses pytest-style functions. Some checks require the reviewed local ESP-IDF sources, C++ compiler, Pillow, OpenSSL and `rsvg-convert`; consult the test's actual inputs. Build-only and host tests do not prove hardware behavior.

Test current wire contracts, state transitions, resource/security boundaries and regressions. Historical HIL uses retired toggle/protocol assumptions; reconcile each case before execution rather than treating the old matrix as current authority.

## Device transport and completion

Use `esp32-devtool` on explicitly approved local hardware. Daemon owns USB-CDC. Existing HIL `serial_dut` opens raw pyserial with no handoff; do not combine it with daemon-backed `cube_dut` or commands, and do not open another monitor. Consume available checkpoints through the daemon ring instead.

Command acceptance is not asynchronous completion. Wait for observable target state with a bounded deadline; do not infer capture, enrollment or gateway readiness from a `mark` checkpoint, elapsed time or a transient `CONNECTING` state. Current shipping UI uses press/release capture, not tap-to-toggle.

For approved gateway assertions, inspect only bounded new sanitized diagnostics. Do not collect transcripts, prompts, audio or secrets. Project manifest is `esp32/cube/devtool/boards/cube.yaml`; UDP relay is currently disabled in manifest/debug defaults, with port 9000 reserved if enabled. USB/ring is the default diagnostic path.

HTTP screenshot is `GET /screenshot` through `esp32-devtool screenshot`, not a `ui.snapshot` USB verb. Never bypass bootstrap screenshot refusal. Tree dumps are not a safe replacement: they include label text, including populated hidden pairing labels. Do not use tree/transcript diagnostics with protected or real-user content; see [agent console details](agent-console-details.md).

The current simulator renders only the 466x466 diagnostic test screen, not shipping 480x480 companion views. Even shared shipping-view simulation cannot establish physical touch, microphone, speaker, panel timing or memory behavior.

Hardware smoke, flash, fault injection and recovery require explicit local target availability/approval. Do not improvise them during host validation; read [flash discipline](flash-discipline-details.md).
