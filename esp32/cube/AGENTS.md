# ESP32 Cube

Waveshare ESP32-S3-Touch-AMOLED-2.16 client. Owned firmware is in `firmware/`; board adaptation is `firmware/main/boards/sentient-cube/`. Current gateway wire contracts live in `shared/protocol/`, not historical cube plans or legacy HIL assertions.

- Use `esp32-devtool` for device operations. Its daemon owns USB serial; do not open a competing monitor or serial reader. Inspect bounded state/log evidence before reset or flash; stop for operator recovery if hardware is wedged.
- Keep debug/test operations on the approved local device and gateway. Never flash placeholder build credentials. Do not log credentials, command payloads, transcripts, or raw audio; keep diagnostic artifacts private.
- Preserve the PMIC initialization order and shutdown guard in `sentient_cube.cc`: AXP2101 shutdown can latch power off. Preserve safe transient touch-read handling and calibrated CST9217 flags (`swap_xy=1, mirror_x=0, mirror_y=1`) unless hardware evidence justifies changing them.
- Keep audio and diagnostic buffers bounded. Host-side conversion and transport-specific paths are deliberate ESP32 resource tradeoffs; measure before replacing them.
- Constructor-registered verbs require link retention (`WHOLE_ARCHIVE`). Verify the companion is stripped in release builds rather than inferring it from configuration alone.
- Shared UI code must remain target-independent. Simulator results do not establish device touch, microphone, speaker, or memory behavior.

Read focused build/flash details under `agents/docs/esp32/cube/` as needed. Older docs describe retired protocol events and toggle-to-talk; reconcile them against current source before using their commands or tests.
