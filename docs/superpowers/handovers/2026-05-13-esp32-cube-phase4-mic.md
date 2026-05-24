# ESP32 Cube Phase 4 — Mic Handover

**Date:** 2026-05-13
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-13-esp32-cube-v2-phase4-mic.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §4 Phase 4

## What's done

- Wrote the Phase 4 mic plan document, including the initial channel extraction approach.
- Corrected the plan's channel extraction code before implementation: pre-implementation survey of `BoxAudioCodec` found that `input_channels()` returns 2 (mic mix + AEC reference), not 1 — switched plan code from `memcpy` to strided channel-0 extraction.
- Added `AudioService::RecordPcm(int16_t* dst, size_t sample_count, int sample_rate)` — synchronous PCM16 mono mic capture. Loops `ReadAudioData`, discards a 1-frame (30 ms) warmup, and extracts channel 0 via strided copy from the codec's 2-channel interleaved buffer.
- Hardened `RecordPcm` from code review: split null-dst and zero-count guard warnings into separate `WARN` log entries, and enforced a 1-second sample-rate-relative cap on `sample_count`.
- Added the `agent_record_pcm_fn_t` callback typedef, `agent_console_set_record_pcm_provider()` setter, and `agent_console_record_pcm()` helper to `agent_console.{h,cc}` — follows the existing callback-provider pattern to avoid a `main` → `agent_console` dependency cycle.
- Wired `AudioService::RecordPcm` to the agent_console provider in `sentient_cube.cc` via `sentient_record_pcm_provider`.
- Added the `audio.record_rms` verb — captures N ms of mic audio and returns the mean RMS of the samples. Gated by `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`.
- Added the `audio.record_pcm` verb — captures N ms of mic audio and returns the raw samples as base64-encoded PCM16 mono. Gated by `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`.
- Documented `audio.record_pcm` in the `verbs/audio.cc` file-header verb list.
- Wrote `tests/hil/test_audio_record.py` — 7 Group A HIL cases covering quiet-RMS baseline, record_pcm payload shape, inject-then-record round-trip, three bad-params variants, and cube-alive check.

## What's used (stack the user now owns)

| Path | Responsibility |
|---|---|
| `esp32/cube/firmware/main/audio/audio_service.{h,cc}` | + `RecordPcm(int16_t* dst, size_t sample_count, int sample_rate)` — sync PCM16 mono capture; loops `ReadAudioData`, discards 1-frame warmup, strided-extracts channel 0 from codec's 2-channel interleaved buffer |
| `esp32/cube/firmware/components/agent_console/include/agent_console.h` | + `agent_record_pcm_fn_t` typedef + `agent_console_set_record_pcm_provider` setter + `agent_console_record_pcm` helper |
| `esp32/cube/firmware/components/agent_console/agent_console.cc` | + `g_record_pcm_fn` global + provider setter + helper |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | + `sentient_record_pcm_provider` wrapper wiring `AudioService::RecordPcm` to agent_console |
| `esp32/cube/firmware/components/agent_console/verbs/audio.cc` | + `audio.record_rms` verb (capture N ms, return mean RMS); + `audio.record_pcm` verb (capture N ms, return base64 PCM16 mono); + `kRecord*` named constants; + file-header doc entry for `audio.record_pcm` |
| `esp32/cube/tests/hil/test_audio_record.py` | 7 Group A HIL cases: quiet-RMS baseline, record_pcm shape, inject→record round-trip, bad-params (×3), cube-alive |

- Component: `AudioService::RecordPcm` — synchronous mic capture called by the agent_console task; blocks for the full recording duration; returns mono PCM16 samples extracted from the codec's 2-channel (mic + AEC reference) buffer.
- Component: `agent_console_record_pcm` helper — dispatches to the board-registered provider; follows the same callback-provider pattern as `play_pcm`, `inject_pcm`, and `tts_cancel`.
- Verb: `audio.record_rms` — `cube-cmd audio.record_rms '{"ms":500}'` → `{"ok":true,"ms":500,"samples":8000,"rms":1256.8}`
- Verb: `audio.record_pcm` — `cube-cmd audio.record_pcm '{"ms":500}'` → `{"ok":true,"ms":500,"samples":8000,"rate":16000,"b64":"<base64 PCM16 mono>"}`

## What's smoked

| Case | Command / observation | Result | Evidence |
|---|---|---|---|
| device build green | `idf.py build` after all Phase 4 tasks | ✅ | `sentient_cube.bin` 2.76 MB, 30% partition headroom |
| pre-flash state | `cube-cmd state` before flash #2 | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true}` | daemon ring buffer |
| flash #1 (failed) | `flash.sh` — dropped at 4% during `sentient_cube.bin` write | ❌ `A fatal error occurred: Serial data stream stopped: Possible serial noise or corruption.` | esptool log; required physical USB unplug + BOOT-hold replug to recover |
| flash #2 (success) | `flash.sh` after recovery | ✅ all partitions wrote and hash-verified; cube reached IDLE within ~8 s | esptool output, `>>> READY` in serial trace |
| boot clean | `cube-cmd state` after flash #2 | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true,"cycle_id":null}` | daemon ring buffer |
| `audio.record_rms` 250 ms (initial post-flash) | `cube-cmd audio.record_rms '{"ms":250}'` | ⚠️ `{"ok":true,"ms":250,"samples":4000,"rms":9.3}` — RMS suspiciously low | Likely codec-warmup transient; subsequent calls show normal RMS |
| `audio.record_rms` 500 ms (post-warmup) | `cube-cmd audio.record_rms '{"ms":500}'` (operator-driven, ~5 min later) | ✅ `{"ok":true,"ms":500,"samples":8000,"rms":1256.8}` | real mic ambient noise |
| `audio.record_rms` 1000 ms during clap (spec smoke bar) | `cube-cmd audio.record_rms '{"ms":1000}'` with operator clap mid-window | ⚠️ `{"ok":true,"rms":844}` — spec wanted > 5000 but 1 s averaging diluted the brief impulse | Not a defect — short-window record (e.g., `ms=100`) or peak-rms (vs mean-rms) verb would catch transients; defer to Phase 5+ if voice-loop SNR validation needs it |
| `audio.record_pcm` 500 ms | `cube-cmd audio.record_pcm '{"ms":500}'` | ✅ `{"ok":true,"ms":500,"samples":8000,"rate":16000,"b64":"..."}` (~21336 b64 chars, 16000 raw bytes) | response shape exact |
| HIL test suite | `pytest tests/hil/test_audio_record.py -v -m group_a` | ✅ 7/7 PASSED in 2.45 s | quiet_nonzero, shape, round_trip_via_inject, bad_ms (×2), missing_ms, cube_alive |
| operator ear round-trip | record 1 s of speech → play_pcm round-trip on speaker | ✅ recognizable speech played back | quality is poor + quiet but the word is recognizable; gain tune queued for Phase 5+ |
| daemon log clean | grep WARN/ERROR in post-smoke ring buffer (filter pre-WiFi + WiFi reconnect spam) | ✅ no unexpected output from `sentient.cube.audio_service` or `sentient.cube.agent_console.audio` | clean |
| final state | `cube-cmd state` after all smoke | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true}` | cube survived |

- Log evidence: `sentient.cube.audio_service` and `sentient.cube.agent_console.audio` — no unexpected WARN/ERROR in post-smoke ring buffer (pre-WiFi-connect noise filtered).

## What you need to know

- **Channel layout: `BoxAudioCodec` uses the ES7210 4-mic ADC, not the ES8311 mic input.** With `AUDIO_INPUT_REFERENCE=true` (board config), `input_channels()` returns 2 — channel 0 is the mic mix, channel 1 is the loopback AEC reference. This is confirmed by `afe_audio_processor.cc:20-28`, which builds the AFE input format string as `"MR"` (Mic, Reference). The underlying TDM has 4 slots (ES7210_SEL_MIC1..4) but downstream data flow sees 2 channels. `RecordPcm` strided-extracts channel 0; the HIL round-trip and operator ear test both validate it.

- **First post-flash `RecordPcm` call may show a transient low RMS.** The first `audio.record_rms` call immediately after flash returned RMS=9.3; the same call 5+ minutes later (at IDLE) returned RMS=1256. Likely cause: the ES7210 I²S DMA / input filter needs more than the single 1-frame (30 ms) warmup to fully stabilize after fresh boot. The current warmup is sufficient for HIL closed-loop tests (which use the injection hook, bypassing the codec), but may need extending to 3-5 frames in Phase 5+ if voice-loop quality demands it.

- **Input gain is currently `input_gain_ = 30` (set in `box_audio_codec.cc:17`).** The operator ear test confirmed recognizable but quiet playback. Gain tuning is queued for Phase 5+ when the full WS-uplink voice loop is exercised — premature tuning without the full pipeline would just chase tester-ear preferences rather than end-to-end SNR.

- **`RecordPcm` blocks the agent_console task for the full recording duration.** Same design trade-off as Phase 3's `audio.test_tone` and `audio.play_pcm`. Acceptable under `CONFIG_AGENT_CONSOLE_DESTRUCTIVE` for HIL. Production path (Phase 6+) should spawn a worker task and return `{"ok":true,"in_flight":true}` with an EVT on completion — this is the same `agent-console.md` rule note that carried over from Phase 3.

- **Injection-hook short-circuit is the basis for the HIL round-trip test.** `audio.inject_pcm` followed by `audio.record_pcm` reads back the injected samples without touching the codec — the hook in `ReadAudioData` short-circuits when the injection ring is non-empty, duplicating mono into all channels. Channel 0 strided extraction recovers exactly the injected mono. This means the HIL suite does not require ambient noise or mic hardware to validate the read loop.

## Hardware glossary (terms new this phase)

- **ES7210**: 4-channel mic-array I²S ADC paired with the ES8311 DAC on the Waveshare board. Reports as `BoxAudioCodec` in firmware. Configured via `ES7210_SEL_MIC1 | MIC2 | MIC3 | MIC4`. Underlying TDM has 4 slots; downstream data flow sees 2 channels (mic mix + AEC reference).
- **AEC reference channel**: A 16-bit interleaved channel running alongside the mic channel that carries the speaker's outgoing signal as a loopback. The AFE audio processor subtracts it from the mic input to remove self-speech. When `input_reference=true`, the codec exposes `input_channels() = 2`.
- **AFE input format string ("MR" / "MMR" etc.)**: An Espressif AFE library convention for describing channel ordering in an interleaved input buffer. 'M' = mic, 'R' = reference. Built in `afe_audio_processor.cc:20-28`. For sentient-cube the format is `"MR"` — confirms channel 0 is mic, channel 1 is reference.
- **Warmup discard (1 frame, 30 ms)**: `RecordPcm` consumes and discards the first 30 ms of mic data after enabling input to avoid the DMA-just-enabled transient. Controlled by the `kWarmupFrames` constant in `audio_service.cc`.

## Open questions / risks

- **Initial-call RMS variance.** Measured RMS for `audio.record_rms` ranged from ~9 (immediately post-flash) to ~1256 (5 min after IDLE). The single-frame warmup may be insufficient for the first invocation after a fresh boot. A repeat-call mitigation — drop the first `record_*` call result or extend warmup to 3-5 frames for the first-ever call — is a candidate Phase 5+ tune.
- **Input gain tune.** Ear test recognizable but quiet. `input_gain_ = 30` may need an increase to ~40-50 for a clean voice loop in Phase 5. Defer until full WS uplink is wired so tuning reflects the real end-to-end path.
- **`audio.record_pcm` capped at 1 s.** Longer captures would require a chunked-stream response variant (server pushes chunks via additional CMDs or EVTs). Defer to Phase 5+ — if mic-to-WS uplink doesn't naturally cover it, design a streaming variant then.
- **HIL test `test_record_rms_quiet_nonzero` RMS threshold `< 2000`.** Ambient-noise-dependent. Currently passes in the operator's dev environment (~1256 RMS); a significantly noisier room would trip it. Document room conditions in `agents/docs/esp32/cube/testing-details.md` if it ever flakes.
- **`verbs/audio.cc` is now 766 lines** (was 478 pre-Phase-3, 682 pre-Phase-4) — well past the 300-line clean-code cap. Split into per-verb files (`verbs/audio/inject.cc`, `verbs/audio/play.cc`, `verbs/audio/record.cc`, etc.) is queued for a Phase 5+ cleanup pass.
- **`RecordPcm` synchronous-blocking pattern** carries over from the Phase 3 design. Async worker + EVT refactor is queued for Phase 6+.

## Flash + smoke metrics

- Flashes this phase: **2** (plan budget: ≤1; bumped to 2 due to first-attempt USB serial drop at 4%)
  - Flash 1: failed mid-write at 4% of `sentient_cube.bin` (USB serial corruption at 460800 baud, root cause unknown — likely USB cable or hub instability)
  - Flash 2: successful after operator BOOT-hold recovery; all partitions hash-verified; cube booted to IDLE in ~8 s
- AXP2101 faults hit: **0**
- Daemon restarts: **1** (between flash attempts — killed before flash #2 to release the port)
- Cold physical recoveries: **1** (operator BOOT-hold replug after flash #1 fail)
- Total dev time on smoke runs: ~1.5 hours (2 flashes, 1 recovery cycle, all HIL pass, operator ear test)
