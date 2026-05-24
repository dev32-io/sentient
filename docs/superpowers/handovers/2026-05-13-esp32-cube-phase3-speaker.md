# ESP32 Cube Phase 3 — Speaker Output Handover

**Date:** 2026-05-13
**Branch:** feature/esp32-cube-v2-rescope
**Plan:** docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase3-speaker.md
**Spec:** docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md §5 Phase 3

## What's done

- Added `AudioService::PlayPcm(const int16_t* samples, size_t sample_count, int sample_rate)` to `audio_service.{h,cc}` — raw PCM16 passthrough to the ES8311 codec. Validates inputs, resamples via linear interpolation when input rate ≠ target rate, manages the audio power timer (stop/restart around playback, update `last_output_time_`). Uses codec's `OutputData(vector<int16_t>&)` API (not raw pointer+bytes — the codec API returns void, so PlayPcm returns false only on validation failures, not codec rejection). No `input_resampler_mutex_` held during resampling (resampling operates on local data only).

- Added `audio.test_tone` verb — generates a sine wave on-device (20–20000 Hz, 10–1000 ms) and pushes it through `agent_console_play_pcm`. Params: `freq` (Hz) and `ms` (duration). Gated by `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`. Returns `{"ok":true,"samples_generated":N}`.

- Added `audio.play_pcm` verb — base64-decode PCM16 mono @ 16kHz and play through speaker via `agent_console_play_pcm`. Single-payload variant: `{"b64":"..."}` → decode and play. Chunked variant: `{"b64":"...","chunk":i,"of":N,"stream_id":"..."}` → accumulate base64 fragments, decode on final chunk. Gated by `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`.

- Added `agent_console_set_play_pcm_provider()` / `agent_console_play_pcm()` callback-provider pair in `agent_console.h/.cc` — follows the existing pattern (state, ws, button, tts_cancel) to avoid `main` → `agent_console` dependency cycle. Board registration in `sentient_cube.cc` wires `AudioService::PlayPcm` as the provider.

- **Fixed USB-CDC command truncation bug**: ESP32-S3's VFS `fgets` returns after the first USB packet (~64 bytes), truncating commands longer than ~56 bytes of JSON payload. Replaced single `fgets` with an accumulation loop that retries on null returns (USB-CDC VFS returns null on inter-packet read timeout, not just EOF). 20 retries at 10ms each covers ~200ms of inter-packet gaps. Without this fix, `audio.test_tone` and `audio.play_pcm` commands were silently truncated to ~56 bytes, producing `-32700 Parse error` responses.

- **Fixed chunked-stream base64 accumulation**: Original implementation decoded each chunk's base64 independently and appended raw bytes to a buffer. This fails because splitting a base64 string into substrings produces invalid base64 on each piece. Changed `ChunkedStream` from `std::vector<uint8_t> buffer` to `std::string b64_accum` — fragments accumulate as base64 text, decode only on the final chunk. Both `inject_pcm` and `play_pcm` chunked paths updated.

- Added `ok:true` to all chunked-stream responses for API consistency with single-payload responses. Changed `buffered_bytes` → `buffered_b64` in chunked response fields (measures accumulated base64 length, not decoded byte count).

- `flash.sh` now ensures `idf.py` is on PATH by re-sourcing `export.sh` from `$IDF_PATH` when needed (Phase 1 finding #5).

- HIL test `test_audio_play_pcm.py` — 5 Group A cases: single-payload, chunked, bad_b64, missing_b64, cube_alive_after_play_pcm. All pass.

## What's used (stack the user now owns)

| Path | Responsibility |
|---|---|
| `esp32/cube/firmware/main/audio/audio_service.{h,cc}` | + `PlayPcm(samples, count, sample_rate)` — raw PCM16 passthrough to ES8311 codec |
| `esp32/cube/firmware/components/agent_console/verbs/audio.cc` | `audio.dump_state`, `audio.inject_pcm`, `audio.play_pcm`, `audio.test_tone`, `tts.cancel` verbs. Chunked-stream uses `b64_accum` string accumulation. |
| `esp32/cube/firmware/components/agent_console/agent_console.{h,cc}` | + `agent_console_set_play_pcm_provider()` / `agent_console_play_pcm()` callback pair. + USB-CDC fgets accumulation loop (retries on null between USB packets). |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | + `sentient_play_pcm_provider()` wiring `AudioService::PlayPcm` to agent_console. |
| `esp32/cube/firmware/components/agent_console/CMakeLists.txt` | `verbs/audio.cc` in SRCS list (was already there from inject_pcm). |
| `esp32/cube/tests/hil/test_audio_play_pcm.py` | 5 Group A HIL cases for `audio.play_pcm`. |
| `esp32/cube/scripts/flash.sh` | + PATH fix for idf.py when sourced outside $IDF_PATH. |

Verbs callable today (all previous + new): `state`, `mark`, `events`, `ui.dump_tree`, `ui.snapshot`, `audio.inject_pcm`, `audio.play_pcm`, `audio.test_tone`, `audio.dump_state`, `tts.cancel`, `log_level`, `wifi.*`, `ws.*`, `button.*`, `restart`.

## What's smoked

| Case | Command / observation | Result | Evidence |
|---|---|---|---|
| device build green | `idf.py build` after all tasks + USB-CDC fix + chunked fix | ✅ | binary `sentient_cube.bin` 2.7 MB |
| boot clean | `cube-cmd state` after flash | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true}` | daemon ring buffer |
| `audio.test_tone` single | `cube-cmd audio.test_tone '{"freq":440,"ms":200}'` | ✅ `{"ok":true,"samples_generated":3200}` | 3200 = 16000 * 200 / 1000 |
| `audio.play_pcm` single | `cube-cmd audio.play_pcm '{"b64":"..."}'` (440 Hz, 100ms) | ✅ `{"ok":true,"samples":1600}` | 1600 = 16000 * 100 / 1000 |
| HIL test suite | `pytest tests/hil/test_audio_play_pcm.py -v` | ✅ 5 passed | single, chunked, bad_b64, missing_b64, alive_after |
| cube alive after all tests | `cube-cmd state` | ✅ `{"state":"IDLE","wifi_connected":true,"ws_connected":true}` | post-smoke check |
| `audio.test_tone` after HIL | `cube-cmd audio.test_tone '{"freq":1000,"ms":100}'` | ✅ `{"ok":true,"samples_generated":1600}` | post-HIL sanity |
| daemon log clean | no WARN/ERROR from agent_console or audio | ✅ | ring buffer grep |

## What you need to know

1. **USB-CDC command truncation was the blocking bug.** ESP32-S3's VFS `fgets` returns partial data between USB packets (~64 bytes each). Any JSON-RPC command longer than ~56 bytes of payload was silently truncated. The fix: accumulate across multiple `fgets` calls with null-return retries (20 retries at 10ms). This affects ALL verbs — Phase 1/2 `state`, `ui.dump_tree`, etc. worked only because their payloads were short enough to fit in one USB packet. Future verbs with large params (chunked audio, OTA payloads) depend on this fix.

2. **Chunked-stream protocol must accumulate base64, not decode per chunk.** Base64 is a streaming encoding — splitting a base64 string at arbitrary byte boundaries produces invalid base64 on each piece. The `ChunkedStream` struct now stores `std::string b64_accum` and decodes only on the final chunk. Both `inject_pcm` and `play_pcm` use this pattern.

3. **`PlayPcm` is synchronous and blocks the agent_console task.** Under `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`, the verb handler blocks for the tone/audio duration. This is acceptable for HIL testing. For production use (Phase 6+), PlayPcm should spawn a FreeRTOS worker task and return `{"ok":true,"in_flight":true}` with an EVT on completion.

4. **`agent_console_play_pcm` callback returns `bool`** — but `AudioService::PlayPcm` returns void (calls `codec_->OutputData()` which returns void). The boolean tracks validation failures only (null samples, zero count, null codec, unsupported rate). Not a codec rejection signal.

5. **`audio.test_tone` params are `freq` and `ms`**, not `freq_hz` and `duration_ms`. The HIL test for `test_tone` (not yet written) should use these param names.

6. **Phase 2 finding #3 (`CONFIG_NEWLIB_NANO_FORMAT=y` breaks `%lld`)** was partially addressed. The `ts_us` field in `touch.tap` EVT still uses `(unsigned long)` + `%lu` with ~71-min rollover. PlayPcm and audio verb logs use `(unsigned)` + `%u` for `size_t`. No `%zu` or `%lld` remain in agent_console or audio verb code.

## Hardware glossary (terms new this phase)

- **ES8311**: I2S codec on the Waveshare AMOLED 2.16 board. Handles mic input (I2S → analog) and speaker output (analog → I2S). `OutputData(vector<int16_t>&)` API for speaker playback.
- **PlayPcm**: AudioService method that passes raw PCM16 samples to the codec's output path. Resamples if input rate ≠ hardware rate (24000 Hz). Manages audio power timer around playback.
- **USB-CDC command truncation**: ESP32-S3 VFS fgets returns partial data between USB packets (~64 bytes each). Accumulation loop with retries fixes commands longer than one packet.
- **ChunkedStream**: Protocol for sending large base64 payloads across multiple JSON-RPC commands. Each chunk carries a `chunk` index, `of` total, and `stream_id`. Server accumulates base64 fragments and decodes on the final chunk.

(Phase 1–2 glossary terms still apply: AMOLED, AXP2101, USB-Serial-JTAG, QSPI, PowerSaveTimer, I²C, LVGL, indev, addr2line.)

## Open questions / risks

- **`PlayPcm` blocks agent_console task** for the audio duration. Acceptable under DESTRUCTIVE flag for HIL. Production path needs async worker + EVT.
- **`PlayPcm` resampling uses linear interpolation** — adequate for 16kHz→24kHz but may produce audible artifacts at wider rate ratios. Spec notes `esp_ae_rate_cvt` as future improvement.
- **HIL test for `audio.test_tone`** not yet written. The verb is manually smoked (`cube-cmd audio.test_tone '{"freq":440,"ms":200}'`). A Group A HIL test case should be added to `test_audio_play_pcm.py` or a new `test_audio_tone.py`.
- **`touch.tap` `ts_us` field** still uses `(unsigned long)` cast with ~71-min rollover (Phase 2 carry-over).

## Flash + smoke metrics

- Flashes this phase: **3** (budget ≤ 5)
  - Flash 1 (Task 8 first attempt): AXP2101 I2C fault after flash — required physical USB unplug/replug recovery.
  - Flash 2 (Task 8 second attempt): successful flash; `audio.test_tone` command truncated by USB-CDC bug → `-32700 Parse error`.
  - Flash 3 (Task 8 third attempt after USB-CDC fix + chunked b64 fix): successful flash; all smoke green.
- AXP2101 faults hit: **1** (Flash 1 — required physical recovery, re-smoked from scratch)
- Daemon restarts: **3** (killed before each flash for port release)
- Cold physical recoveries: **1** (Flash 1 AXP2101 fault)
- Total dev time on smoke: ~2 hours (3 flashes, USB-CDC debug, chunked protocol fix, HIL validation)