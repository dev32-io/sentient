# Cube firmware and asset model

USB-only firmware architecture, verified by migration on the connected development cube. Inspect other devices' actual layouts rather than assuming they already use this target.

## Storage and updates

Cube uses one factory application partition for executable code and bundled assets. Small NVS, PHY and device-enrollment partitions remain separate persistent storage; their offsets and contents must survive updates. There is no OTA slot, automatic firmware rollback, or separate derived asset-cache partition. An interrupted or faulty update is recovered through an explicitly approved USB reflash, with hardware-owner recovery if bootloader entry is needed.

The asset directory is a **read-only namespace**, not a writable Linux filesystem. Hierarchical paths group resources, for example:

```text
/companions/cat/companion.json
/companions/cat/ready.rgb565
/ui/fonts/...
/ui/bubble.rgb565
```

A USB firmware update replaces code and its bundled assets together. It must not erase enrollment or Wi-Fi state. Runtime downloads, writable user content and dynamic loading are not current features.

## Build and runtime

Offline tooling cooks and packages source resources deterministically. The firmware contains their compressed canonical representation; there is no boot-time extraction back into flash. Large decoded resources live in PSRAM with stable lifetime while font/image pointers reference them. Small resources can remain directly accessible in firmware when appropriate.

Build admission checks cover the complete application image, including decoder and resource bytes. Runtime admission checks cover pack format/integrity, canonical paths, entry bounds and decoded sizes before any resources are published. Decoder workspace and output allocations are bounded. Compression is measured rather than assumed; all fonts, sound effects, imagery, display buffers and audio/network allocations contribute to the budget.

Boot/loading/error presentation is independent of package assets. Resource loading precedes consumers and runs outside audio callbacks and the LVGL lock. Failure must leave a controlled boot error rather than partial resources or repeated resets. PSRAM contents are recreated after every boot; they are not persistent files.

## Companion and views

The visual document is named `companion`. It defines metadata, canvas, named image frames and per-state clips supporting static, once-and-hold and loop playback with explicit fallback. It contains no executable behavior or serialized LVGL structures.

Firmware owns actual device/voice state, recording indicators, system warnings, pairing QR and input authority. A small view host separates BootView, SetupView and MainView. MainView presents the companion without making clip playback responsible for navigation. Hidden views stop animation; exiting an input-owning view cancels that input. Wake-only touch and press/release capture remain hardware/application contracts.

Setup's 10,376-byte QR backing buffer is allocated once on first use, not reserved in internal static RAM. Its owner outlives the image descriptor; later setup visits reuse the same storage. Allocation failure stays in the controlled boot error without capture or retries. Existing large-allocation policy prefers PSRAM.

## Measured development verification

The current 37-entry pack occupies 1,328,054 compressed bytes and 2,841,732 decoded bytes. Decoder output plus bulk workspace peaks at 2,852,724 bytes in PSRAM; observed device decode time is approximately 0.55 seconds. Complete images measured 4,779,888 bytes (debug) and 4,353,792 bytes (release), within the `0xfe0000`-byte factory partition. These are measurements, not permanent budget guarantees.

Approved USB migration preserved enrollment and Wi-Fi state; verified TLS and local gateway authentication resumed. A short physical-microphone capture completed with matched AFE feed/fetch counts, recording-time screenshot rejection, and return to idle. Speaker test-tone generation completed. After capture, internal free-memory minimum was 13,067 bytes and PSRAM minimum 4,750,992 bytes; the earlier inline QR allocation had reduced internal minimum to 563 bytes and was removed. Host checks cover malformed packs/documents, allocation failure and shared view lifecycle; release strip and development-certificate exclusion checks pass.

These checks are not an acoustic-quality or sustained-load benchmark. USB-tethered sleep suppression prevents proving untethered physical wake in this run; wake/input logic has host regression coverage. Enrollment was retained, not reset to repeat onboarding.

Future notifications, settings, imported companions and UI sound additions must respect measured storage, memory and rendering/audio budgets rather than assume a desktop game engine's resources.
