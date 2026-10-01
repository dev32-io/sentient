---
paths:
  - "esp32/cube/firmware/**"
  - "esp32/cube/lvgl-sim/**"
  - "esp32/cube/tests/**"
---
# Cube firmware architecture

Target contract for the active refactor; verify current source before assuming migration is complete.

- Preserve verified HTTPS/WSS in both profiles: development may use an explicitly supplied trusted certificate; release retains its CA-bundle trust policy. Do not add TLS verification bypasses. Release excludes devtool implementation; verify ELF/map, not config alone. Inert linkage stubs are not debug functionality.
- Cube updates are USB-only, with one factory application partition and no OTA/automatic firmware rollback. Preserve NVS, PHY and enrollment partition offsets/state during layout changes; no erase-all or credential reset. Bad/interrupted firmware updates require operator-controlled USB recovery.
- Firmware bundles authoritative assets under hierarchical read-only paths such as `/companions/cat/` and `/ui/fonts/`. This is not a writable Linux filesystem. Do not reintroduce a separate asset-cache partition, boot-time flash extraction, or a writable asset store without a new requirement.
- Cook assets offline and embed a reproducible pack. Decode required compressed assets directly into bounded PSRAM before consumers start; retain storage while font/image pointers reference it. Keep minimal boot/loading/error UI independent of the pack.
- Validate pack version, integrity, paths, entry counts/ranges and expanded sizes before publishing assets. Bound decompression output and peak allocations; failure stays in controlled boot/error state, never partial resources. Builds reject images exceeding the application partition; compression ratios and decoder costs must be measured.
- Choose storage/runtime representations using total firmware size including decoder code, decoded PSRAM/internal-RAM requirements and measured load/playback costs. Small assets may remain directly flash-accessible. No runtime recompression, dynamic eviction or generic filesystem without demonstrated need.
- The per-state visual document/package is named `companion`. Keep it declarative, versioned, bounded and independent of LVGL memory layouts; support static, once-and-hold and looping clips with explicit missing-state fallback. Device truth, recording indicators, warnings and input authority remain firmware-owned.
- A small view host owns BootView, MainView, setup/pairing presentation, lifecycle and input routing. Keep companion playback separate from navigation; stop hidden-view animation and cancel owned input on view exit. Preserve wake-touch consumption and prevent non-main views from starting voice capture.
- Shared rendering and companion playback stay target-independent. Preserve nonblocking producer-to-UI updates and LVGL ownership/locking; no decompression or flash writes in audio callbacks or frame ticks.
- Budget assets together with fonts, sounds, decoder workspace, display buffers and audio/network memory. Verify on-device audio continuity, input latency, minimum free/largest-block internal RAM and PSRAM; simulator success is not device-performance evidence.
