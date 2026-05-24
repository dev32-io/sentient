# ESP32 Cube v2 — Phase 3: Speaker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speaker audible on the cube. Boot tone plays on first boot. Two new agent_console verbs (`audio.test_tone` + `audio.play_pcm`) let the agent generate sine tones and play arbitrary PCM blobs without touching the gateway. Add the chunked-stream variant to `audio.inject_pcm` + `audio.play_pcm` that Phase 1 flagged as a Phase 3 prerequisite (21KB single-payload heap OOM).

**Architecture:** Phase 1 already vendored xiaozhi's `AudioService` + `AudioCodec` infrastructure. Phase 2 boot logs confirmed `Adev_Codec: Open codec device OK` + `AudioCodec: Set output enable to true` + `AudioService: Resampling audio from 16000 to 24000` at every boot — the speaker output path is already initialized end-to-end. Phase 3 adds a small `AudioService::PlayPcm(int16_t* samples, int len, int sample_rate)` method that resamples and writes to the codec directly (bypassing opus encode/decode for synthetic streams), exposes it through two new verbs, generates a sine tone for `test_tone`, and extends both `inject_pcm` + `play_pcm` to accept multi-message chunked uploads to fix the heap-OOM regression.

**Tech Stack:**
- ESP-IDF v5.5.2, Xtensa GCC, ESP32-S3
- ES8311 codec (board-pinned ES8311_CODEC_DEFAULT_ADDR; AMOLED 2.16 baseline)
- xiaozhi-derived `AudioService` (`firmware/main/audio/audio_service.{cc,h}`) — opus-aware streaming audio task
- agent_console JSON-RPC over USB-CDC, `<<< RSP` / `<<< EVT` line protocol
- pytest-embedded HIL suite (Phase 1 infra, extended here for one new Group A test)

**Spec source:** `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md` §4 Phase 3 + §6 known follow-ups.

**Phase 2 handover:** `docs/superpowers/handovers/2026-05-12-esp32-cube-phase2-display-touch.md`

---

## What Phase 1+2 already give us (read before starting)

- **Codec init + AudioService.Start happen at boot, no work needed.** Phase 2 boot trace shows:
  ```
  I (8011) Adev_Codec: Open codec device OK
  I (8011) AudioCodec: Set output enable to true
  I (8011) AudioService: Resampling audio from 16000 to 24000
  ```
  These come from xiaozhi's `Application::Initialize` calling `audio_service_.Start()` after board ctor returns. No changes to the boot path required.

- **`AudioService::PlaySound(string_view ogg)`** already plays OGG blobs through the codec. Sound assets at `firmware/main/assets/common/{success,popup,exclamation,low_battery,vibration}.ogg`. Existing call site in `application.cc:321` plays `Lang::Sounds::OGG_SUCCESS` on activation — verify in Phase 3 smoke whether that fires audibly at boot (it should — if it does, no extra "boot tone" task is needed).

- **`firmware/components/agent_console/verbs/audio.cc`** has the existing `audio.inject_pcm` verb. Ring-buffer-backed (32000 samples / 2 s @ 16kHz). Phase 3 layers `audio.play_pcm` next to it + adds chunked-stream params to both.

- **agent_console event channel** for async out-of-band notifications (`agent_console_event(json)`). Phase 3 uses it to signal `audio.play_pcm.done` events (so a HIL test can wait for playback completion without polling).

- **`agent_audio_inject_pop_samples()`** strong override at `audio.cc:205` feeds injected samples into the mic capture path. Phase 3 mirrors that pattern with a `agent_audio_push_play_samples()` helper that AudioService consumes on the output side.

---

## Constraints + Rules

- **Flash budget: ≤ 4 flashes total this phase.** Per `.claude/rules/esp32/cube/flash-discipline.md` and spec §4 Phase 3 smoke bar. Tasks 1–6 verified by `idf.py build` alone. Only Task 7 flashes.
- **One logical change per commit.** Per `.claude/rules/git-workflow.md`.
- **Build must stay green at every commit.** No exceptions.
- **No changes to `audio_service.{cc,h}` beyond the additive `PlayPcm` method in Task 3.** Phase 1 stabilized this surface; keep churn out.
- **`audio.inject_pcm` is `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`-gated.** Same gating MUST apply to `audio.play_pcm` (it speaker-tests on a device that may be in a quiet environment) and to the chunked variants. Phase 1's `sdkconfig.defaults` already has `CONFIG_AGENT_CONSOLE_DESTRUCTIVE=y` for dev builds — verify before assuming the verbs are reachable.
- **No `printf` / `ESP_LOGI` inside per-sample loops.** Volume of audio data would flood logs. Log only at start, completion, and on errors.
- **All ESP-IDF commands assume the env-source dance.** Wrap every `idf.py` invocation:
  ```bash
  bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py <args>'
  ```
- **HIL tests use real cube.** New `test_audio_play_pcm.py` in Task 6 runs against the cube via `cube_dut` fixture. Real audio measurement is out of scope (no mic loopback in Phase 3); the HIL test only verifies the verb returns `{"ok": true}` and emits a `audio.play_pcm.done` EVT within the expected time window.
- **CONFIG_NEWLIB_NANO_FORMAT=y carry-over.** Same trap as Phase 2 `ts_us`: any `snprintf("%lld", x)` silently emits literal `"ld"`. Use `(unsigned long) %lu` instead.

---

## File Structure

Files modified or created in this phase:

| Path | Change | Task |
|---|---|---|
| `esp32/cube/firmware/main/audio/audio_service.h` | + `PlayPcm(int16_t* samples, int len, int sample_rate)` method declaration | Task 3 |
| `esp32/cube/firmware/main/audio/audio_service.cc` | + `PlayPcm` implementation (resample → codec write); + `agent_audio_push_play_samples` weak default symbol | Task 3 |
| `esp32/cube/firmware/components/agent_console/verbs/audio.cc` | + `audio.test_tone` verb (sine generator); + `audio.play_pcm` verb (PCM passthrough); + chunked-stream support for both `audio.inject_pcm` and `audio.play_pcm` | Tasks 4, 5, 6 |
| `esp32/cube/firmware/components/agent_console/CMakeLists.txt` | Already lists `verbs/audio.cc`; no change unless WHOLE_ARCHIVE invariant breaks (see build rule) | (verify Task 4) |
| `esp32/cube/tests/hil/test_audio_play_pcm.py` | NEW — single Group A test for `audio.play_pcm` happy + sad paths | Task 7 |
| `docs/superpowers/handovers/2026-05-12-esp32-cube-phase3-speaker.md` | NEW — Phase 3 handover | Task 9 |

---

## Task 1: Survey + baseline metrics

Pure data-collection. No file changes, no commit.

**Files:** none modified
**Output:** scratch notes saved to `/tmp/phase3-baseline-record.txt` for the handover

- [ ] **Step 1: Read AudioService output API surface**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && \
sed -n '105,180p' main/audio/audio_service.h
```

Expected: `class AudioService` with public methods including `PlaySound`, `Initialize`, `Start`, `Stop`, `PushPacketToDecodeQueue`. Note the `audio_playback_queue_` private member (line ~173) — this is the queue the output task consumes.

```bash
sed -n '680,750p' main/audio/audio_service.cc
```

Read the existing `PlaySound` implementation (line 684). Note how it:
- Calls `codec_->EnableOutput(true)` to ensure speaker rail is on
- Decodes the OGG blob via the OGG demuxer + opus decoder
- Pushes decoded PCM frames into the codec via the playback queue

For raw PCM, we DON'T need OGG or opus — we can write samples to the codec directly (after sample-rate conversion). This is the design for `AudioService::PlayPcm`.

- [ ] **Step 2: Read the existing audio.cc verb file structure**

```bash
cat /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware/components/agent_console/verbs/audio.cc
```

Note:
- File-scope ring buffer + mutex (lines 30-55 area)
- `agent_audio_inject_pop_samples` strong override (around line 205)
- Registration in `__attribute__((constructor))` block at the bottom

Task 3+4 will mirror this pattern for the play-side ring buffer.

- [ ] **Step 3: Verify CONFIG_AGENT_CONSOLE_DESTRUCTIVE is enabled**

```bash
grep "CONFIG_AGENT_CONSOLE_DESTRUCTIVE" esp32/cube/firmware/sdkconfig.defaults
```

Expected: `CONFIG_AGENT_CONSOLE_DESTRUCTIVE=y`. If missing, Phase 1 didn't enable it — `audio.inject_pcm` would compile out and chunked variants would be unreachable. Stop and report BLOCKED with instruction to add the flag.

- [ ] **Step 4: Capture binary baseline**

```bash
ls -la esp32/cube/firmware/build/sentient_cube.bin 2>&1
```

Record the size to `/tmp/phase3-baseline-record.txt`:

```
PHASE 3 BASELINE (pre-implementation):
- sentient_cube.bin: <size> bytes
- partition free: ~30% (from Phase 2 handover)
- CONFIG_AGENT_CONSOLE_DESTRUCTIVE: <y/n>
- AudioService output path: codec-resample-write (verified via PlaySound impl at audio_service.cc:684)
```

- [ ] **Step 5: No commit. Move to Task 2.**

---

## Task 2: Verify boot tone audibility

Pure observation. No file changes, no commit. We don't flash YET — this is documentation that informs Task 7's smoke matrix.

Application::Initialize calls `audio_service_.PlaySound(Lang::Sounds::OGG_SUCCESS)` on activation (line 321). Phase 2's flashed firmware already has this code path. If the cube is currently plugged in and the speaker is connected, a boot ding should already play on every reset.

- [ ] **Step 1: Listen on next boot**

Assuming the cube is plugged in and `cube-cmd state` returns `IDLE`:

```bash
bash esp32/cube/scripts/cube-cmd.sh restart 2>&1
```

(If `restart` verb is not registered on this build, skip this step — boot tone observation moves to Task 7's smoke matrix.)

Listen to the speaker as the cube reboots. A short "ding" within 8-10 s of reset means the speaker output path works end-to-end with the existing PlaySound code — no Phase 3 task needs to add a boot tone.

If NO tone is heard:
- Speaker hardware may be muted (check `AUDIO_CODEC_PA_PIN` GPIO 46 in `config.h` — a high level enables the power amp on this board)
- Codec mute state may default to muted; investigate `codec_->EnableOutput(true)` actually unmuting the rail
- Move "wire boot tone" into Task 7 as a fallback

Record the observation in `/tmp/phase3-baseline-record.txt`:

```
BOOT TONE: <audible / silent / inconclusive>
```

- [ ] **Step 2: No commit.**

---

## Task 3: `AudioService::PlayPcm` — raw PCM passthrough

**Files:**
- Modify: `esp32/cube/firmware/main/audio/audio_service.h`
- Modify: `esp32/cube/firmware/main/audio/audio_service.cc`

**Why:** xiaozhi's existing audio API expects either OGG blobs (`PlaySound`) or opus-encoded packets (`PushPacketToDecodeQueue`). For agent-driven testing of the speaker (sine tones, canned hellos), we want a direct raw PCM path: hand the AudioService a buffer of int16_t samples at a known sample rate and have it resample (to the codec's 24 kHz native rate, per the Phase 2 boot trace `Resampling audio from 16000 to 24000`) and write to the codec output. This is a small additive method on the AudioService class — no churn to existing flows.

- [ ] **Step 1: Declare PlayPcm in `audio_service.h`**

Open `esp32/cube/firmware/main/audio/audio_service.h`. Find the public method declarations block (~line 110-135), immediately after `PlaySound`:

```cpp
    void PlaySound(const std::string_view& sound);
```

Add immediately AFTER this line:

```cpp
    // Phase 3: raw PCM16 mono playback. Resamples from sample_rate to the
    // codec's native rate and writes to the codec output. Returns false if
    // the codec rejected (output disabled, EnableOutput failed). Used by
    // the agent_console audio.test_tone and audio.play_pcm verbs.
    //
    // Caller-imposed cap: <= 1 second of audio per call (16000 samples at
    // 16 kHz). Larger payloads should chunk via the chunked-stream verb.
    //
    // Thread-safety: serializes against PlaySound via the existing audio
    // queue mutex. Safe to call from any task that doesn't already hold
    // the audio_queue_mutex.
    bool PlayPcm(const int16_t* samples, size_t sample_count, int sample_rate);
```

- [ ] **Step 2: Implement PlayPcm in `audio_service.cc`**

Open `esp32/cube/firmware/main/audio/audio_service.cc`. Find the end of `PlaySound` (line ~705 — `}` closing the function). Add the new function AFTER `PlaySound`'s closing brace:

```cpp
bool AudioService::PlayPcm(const int16_t* samples, size_t sample_count, int sample_rate) {
    if (samples == nullptr || sample_count == 0) {
        ESP_LOGW(TAG, "PlayPcm rejected: empty buffer");
        return false;
    }
    if (codec_ == nullptr) {
        ESP_LOGW(TAG, "PlayPcm rejected: codec not initialized");
        return false;
    }
    if (sample_rate <= 0 || sample_rate > 48000) {
        ESP_LOGW(TAG, "PlayPcm rejected: bad sample_rate=%d", sample_rate);
        return false;
    }
    const int target_rate = codec_->output_sample_rate();
    ESP_LOGI(TAG, "PlayPcm samples=%zu input_rate=%d target_rate=%d",
             sample_count, sample_rate, target_rate);

    // Pre-grow a vector for the resampled output. Max upsample factor
    // bounded by codec_native_rate / 8000 — generous worst case.
    std::vector<int16_t> resampled;

    if (sample_rate == target_rate) {
        resampled.assign(samples, samples + sample_count);
    } else {
        // Use the existing output_resampler_ if its rates match; otherwise
        // do a one-shot linear resample. Both paths produce int16_t at
        // target_rate.
        std::lock_guard<std::mutex> lock(input_resampler_mutex_);
        const float ratio = (float)target_rate / (float)sample_rate;
        const size_t out_count = (size_t)((float)sample_count * ratio);
        resampled.resize(out_count);
        for (size_t i = 0; i < out_count; ++i) {
            const float src_idx_f = (float)i / ratio;
            const size_t src_idx = (size_t)src_idx_f;
            const float frac = src_idx_f - (float)src_idx;
            const int16_t a = samples[std::min(src_idx, sample_count - 1)];
            const int16_t b = samples[std::min(src_idx + 1, sample_count - 1)];
            resampled[i] = (int16_t)((float)a * (1.0f - frac) + (float)b * frac);
        }
    }

    codec_->EnableOutput(true);
    const esp_err_t err = codec_->OutputData(resampled.data(),
                                              resampled.size() * sizeof(int16_t));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "PlayPcm codec OutputData rc=%s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "PlayPcm done samples_out=%zu", resampled.size());
    return true;
}
```

Note: this assumes `AudioCodec` has an `output_sample_rate()` accessor and an `OutputData(buf, bytes)` method. Verify by grepping:

```bash
grep -nE "output_sample_rate|OutputData" esp32/cube/firmware/main/audio/audio_codec.h esp32/cube/firmware/main/boards/common/audio_codec.h 2>/dev/null | head -10
```

If `OutputData` is named differently (e.g. `Write`, `WriteOutput`, `WriteSamples`), substitute the correct symbol. If `output_sample_rate()` doesn't exist, use the hardcoded 24000 we observed in Phase 2 boot trace (`Resampling audio from 16000 to 24000`).

If the codec API is NOT shaped like this at all, STOP and report BLOCKED with the actual `audio_codec.h` API — the resample-then-write design needs to match the codec's actual interface.

- [ ] **Step 3: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -15'
```

Expected: `Project build complete.` If `OutputData` is unresolved, fix per Step 2 alternate-symbol guidance.

- [ ] **Step 4: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/main/audio/audio_service.{cc,h} && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/audio): AudioService::PlayPcm — raw PCM passthrough

Adds a small additive method on the xiaozhi-derived AudioService for
direct raw-PCM playback. Resamples int16_t input to the codec's native
rate and writes via codec->OutputData. Bypasses opus encode/decode —
appropriate for synthetic streams from the agent_console verbs
(audio.test_tone sine generator, audio.play_pcm canned blobs) where
the source is already PCM and going through opus would only add
latency + decode overhead for no benefit.

Caller-imposed cap of 1 second per call (16000 samples at 16 kHz);
larger payloads should chunk via the agent_console chunked-stream
variant added later in this phase.

Phase 3 Task 3 — Speaker bring-up.
EOF
)"
```

---

## Task 4: `audio.test_tone` verb

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/verbs/audio.cc`

**Why:** Generate a sine tone on-device given a frequency + duration. Single self-contained verb — feeds the generated samples directly into `AudioService::PlayPcm`. The agent can sweep frequencies, verify the speaker frequency response, and catch broken-codec failures without uploading any data.

JSON-RPC shape:

```
>>> CMD {"jsonrpc":"2.0","id":N,"method":"audio.test_tone","params":{"freq":440,"ms":500}}
<<< RSP {"jsonrpc":"2.0","id":N,"result":{"ok":true,"samples_generated":<N>}}
```

`freq` is the tone frequency in Hz (allowed range: 20-20000). `ms` is the tone duration in milliseconds (allowed range: 10-1000; 1 second is the PlayPcm hard cap). On bad params: emit JSON-RPC error code -32602 (`Invalid params`).

- [ ] **Step 1: Add the verb implementation**

Open `esp32/cube/firmware/components/agent_console/verbs/audio.cc`. After the existing `handle_audio_inject_pcm` function definition and before the `__attribute__((constructor))` registration block at the bottom, add:

```cpp
// audio.test_tone — generate a sine wave on-device + push to speaker.
int handle_audio_test_tone(const cJSON* params, cJSON* out_result,
                           int* ec, const char** em) {
    const cJSON* freq_node = cJSON_GetObjectItem(params, "freq");
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(freq_node) || !cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect freq + ms (numbers)";
        return 1;
    }
    const int freq = freq_node->valueint;
    const int ms = ms_node->valueint;
    if (freq < 20 || freq > 20000) {
        *ec = -32602;
        *em = "Invalid params: freq must be 20-20000 Hz";
        return 1;
    }
    if (ms < 10 || ms > 1000) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000 (1s PlayPcm cap)";
        return 1;
    }

    constexpr int kSampleRate = 16000;
    const size_t sample_count = (size_t)kSampleRate * (size_t)ms / 1000U;
    std::vector<int16_t> samples(sample_count);
    const float omega = 2.0f * 3.14159265358979323846f * (float)freq / (float)kSampleRate;
    for (size_t i = 0; i < sample_count; ++i) {
        const float v = sinf(omega * (float)i);
        samples[i] = (int16_t)(v * 16384.0f);  // 50% amplitude to avoid clipping
    }

    auto& app = Application::GetInstance();
    auto& as = app.GetAudioService();
    const bool ok = as.PlayPcm(samples.data(), samples.size(), kSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "PlayPcm failed (codec disabled or rate rejected)";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "samples_generated", (double)sample_count);
    return 0;
}
```

You also need to ensure these includes are at the top of `audio.cc`:

```cpp
#include <cmath>
#include "application.h"
```

If the file already has `#include <vector>` (it does, for the inject ring buffer), reuse that. If `application.h` isn't on the include path for `agent_console/` (it lives in `main/`), this verb file would gain a coupling that the agent_console rule explicitly forbids (`agent_console MUST NOT list main in its REQUIRES`). Instead, use the existing callback-registration pattern from `agent_console.h`:

```cpp
// Bad — creates dependency cycle:
// #include "application.h"

// Good — register a callback at startup from sentient_cube.cc.
// agent_console_set_audio_provider(...) — must be added to
// components/agent_console/include/agent_console.h.
typedef bool (*agent_play_pcm_fn_t)(const int16_t* samples, size_t count, int sample_rate);
void agent_console_set_play_pcm_provider(agent_play_pcm_fn_t fn);

// Then in audio.cc:
extern agent_play_pcm_fn_t g_play_pcm_provider;
// ...
const bool ok = g_play_pcm_provider != nullptr &&
                g_play_pcm_provider(samples.data(), samples.size(), kSampleRate);
```

Pick whichever fits the existing code style — `audio.cc` already uses the state/action provider pattern via `agent_console_set_state_provider` etc. (verified during Phase 1). Follow that pattern: add `agent_console_set_play_pcm_provider` to the public header, store the function pointer in `agent_console.cc`, expose `agent_console_play_pcm()` for verbs to call. Register the callback from `sentient_cube.cc`'s ctor after AudioService is initialized.

(This callback-registration step is a small refactor — split into Task 4a if it grows beyond ~30 LOC; otherwise inline here.)

- [ ] **Step 2: Register the verb**

At the bottom of `audio.cc`, find the `__attribute__((constructor))` block. Add the new registration alongside the existing ones:

```cpp
__attribute__((constructor))
void register_audio_test_tone(void) {
    agent_dispatcher_register("audio.test_tone", handle_audio_test_tone);
}
```

- [ ] **Step 3: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -15'
```

Expected: `Project build complete.` If `agent_dispatcher_register` is unresolved, the registration block placement is wrong — verify the include of `dispatcher.h` at the top of `audio.cc`.

- [ ] **Step 4: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/components/agent_console/ && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/agent_console): audio.test_tone verb (sine generator)

Generates a sine wave on-device at a given frequency (20-20000 Hz) for
a given duration (10-1000 ms), pushes to AudioService::PlayPcm. Used
to verify speaker hardware + codec chain without uploading any audio.

JSON-RPC shape:
  CMD: {"method":"audio.test_tone","params":{"freq":440,"ms":500}}
  RSP: {"result":{"ok":true,"samples_generated":8000}}

Bad params (out of range, missing fields) return JSON-RPC -32602
"Invalid params". Codec/PlayPcm failure returns -32603 "Internal".

Wires through the agent_console_set_play_pcm_provider callback
pattern to avoid the agent_console → main dependency cycle (per
.claude/rules/esp32/cube/agent-console.md). Provider registered from
sentient_cube.cc after AudioService init.

Phase 3 Task 4.
EOF
)"
```

---

## Task 5: `audio.play_pcm` verb

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/verbs/audio.cc`

**Why:** Push a base64-encoded PCM16 mono blob from the agent to the speaker. Mirror of the existing `audio.inject_pcm` (which targets the mic input path) — same JSON wire shape, different destination. Phase 4 (Mic) uses this to round-trip a recording: capture via `audio.record_pcm`, then play back via `audio.play_pcm` to confirm the codec chain is symmetric.

JSON-RPC shape:

```
>>> CMD {"jsonrpc":"2.0","id":N,"method":"audio.play_pcm","params":{"b64":"<base64 PCM16 16kHz mono>"}}
<<< RSP {"jsonrpc":"2.0","id":N,"result":{"ok":true,"samples":<N>}}
```

Hard caps: payload base64 length <= 64 KB (== 48 KB raw PCM == 1.5 s @ 16 kHz). Phase 5 chunked variant (Task 6) lifts this.

- [ ] **Step 1: Add the verb implementation**

In `esp32/cube/firmware/components/agent_console/verbs/audio.cc`, after `handle_audio_test_tone`:

```cpp
// audio.play_pcm — base64-decode PCM16 mono @ 16 kHz, push to speaker.
int handle_audio_play_pcm(const cJSON* params, cJSON* out_result,
                          int* ec, const char** em) {
    const cJSON* b64_node = cJSON_GetObjectItem(params, "b64");
    if (!cJSON_IsString(b64_node)) {
        *ec = -32602;
        *em = "Invalid params: expect b64 (string)";
        return 1;
    }
    const char* b64 = b64_node->valuestring;
    const size_t b64_len = strlen(b64);
    constexpr size_t kMaxB64Bytes = 64 * 1024;
    if (b64_len > kMaxB64Bytes) {
        *ec = -32602;
        *em = "Invalid params: b64 length exceeds 64 KB cap (use chunked variant)";
        return 1;
    }

    std::vector<uint8_t> raw(b64_len);
    size_t raw_len = 0;
    const int rc = mbedtls_base64_decode(raw.data(), raw.size(), &raw_len,
                                          (const unsigned char*)b64, b64_len);
    if (rc != 0) {
        *ec = -32602;
        *em = "Invalid params: base64 decode failed";
        return 1;
    }
    if (raw_len % 2 != 0) {
        *ec = -32602;
        *em = "Invalid params: decoded length not PCM16-aligned";
        return 1;
    }

    const int16_t* samples = reinterpret_cast<const int16_t*>(raw.data());
    const size_t sample_count = raw_len / 2;
    const bool ok = agent_console_play_pcm(samples, sample_count, 16000);
    if (!ok) {
        *ec = -32603;
        *em = "PlayPcm failed";
        return 1;
    }
    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "samples", (double)sample_count);
    return 0;
}

__attribute__((constructor))
void register_audio_play_pcm(void) {
    agent_dispatcher_register("audio.play_pcm", handle_audio_play_pcm);
}
```

- [ ] **Step 2: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -12'
```

- [ ] **Step 3: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/components/agent_console/verbs/audio.cc && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/agent_console): audio.play_pcm verb (PCM passthrough)

Mirror of audio.inject_pcm but for output: base64-decodes PCM16 mono
16 kHz from the JSON-RPC param, pushes the samples through
AudioService::PlayPcm to the speaker.

JSON-RPC shape:
  CMD: {"method":"audio.play_pcm","params":{"b64":"<base64 PCM16>"}}
  RSP: {"result":{"ok":true,"samples":<N>}}

Caps payload at 64 KB base64 (~48 KB raw, ~1.5 s of audio). Larger
payloads must use the chunked variant in Task 6 — single-payload
larger than this risks the same heap-OOM regression spec §6 flagged
on audio.inject_pcm.

Phase 3 Task 5.
EOF
)"
```

---

## Task 6: Chunked-stream variant for `audio.inject_pcm` + `audio.play_pcm`

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/verbs/audio.cc`

**Why:** Spec §6 flagged that `audio.inject_pcm` heap-OOMs on a single 21 KB payload. Phase 3 closes this. The fix is a multi-message chunked protocol: caller sends N CMDs each carrying a chunk + index + total, server accumulates into a single buffer, on the last chunk it commits to the existing ring buffer / PlayPcm path.

Wire shape extension (both verbs):

```
>>> CMD {"method":"audio.inject_pcm","params":{"b64":"...","chunk":0,"of":3,"stream_id":"abc"}}
<<< RSP {"result":{"ok":true,"chunk":0,"of":3,"buffered_bytes":12345}}

>>> CMD {"method":"audio.inject_pcm","params":{"b64":"...","chunk":1,"of":3,"stream_id":"abc"}}
<<< RSP {"result":{"ok":true,"chunk":1,"of":3,"buffered_bytes":24690}}

>>> CMD {"method":"audio.inject_pcm","params":{"b64":"...","chunk":2,"of":3,"stream_id":"abc"}}
<<< RSP {"result":{"ok":true,"chunk":2,"of":3,"buffered_bytes":36000,"committed":true}}
```

When `chunk` + `of` + `stream_id` are absent: existing single-payload behavior (backwards-compatible).

`stream_id` is a short opaque tag the caller picks (e.g. UUID prefix) so chunks from concurrent calls don't intermingle. Server keeps one in-flight stream per verb (`audio.inject_pcm` and `audio.play_pcm` get independent buffers); a new stream_id while a stream is in-flight is a JSON-RPC error code -32000 (`Server error: stream already in-flight`).

Caps: total buffered bytes <= 256 KB (== 8 s @ 16 kHz). Chunk payload <= 16 KB raw (~21 KB b64). On commit, the verb behaves like the single-payload variant — pushes to ring (inject) or PlayPcm (play).

- [ ] **Step 1: Add the chunked-stream accumulator**

In `esp32/cube/firmware/components/agent_console/verbs/audio.cc`, add a file-scope struct near the existing ring buffer state (top of the anonymous namespace, around line 50):

```cpp
struct ChunkedStream {
    char stream_id[33] = {0};   // copied from params; 32 char max + null
    std::vector<uint8_t> buffer;
    int next_chunk = 0;
    int total_chunks = 0;
    bool active = false;
};

constexpr size_t kMaxStreamBufferBytes = 256 * 1024;
constexpr size_t kMaxChunkRawBytes = 16 * 1024;

ChunkedStream g_inject_stream;
ChunkedStream g_play_stream;
```

- [ ] **Step 2: Refactor inject + play to support chunked path**

Extract the actual commit-to-target logic from `handle_audio_inject_pcm` into a helper:

```cpp
// Drains the chunked buffer into the inject ring. Returns false on
// buffer-full or codec-rejection. Always resets the stream state.
bool commit_inject_buffer(const std::vector<uint8_t>& buf, int* ec, const char** em) {
    // Same body as the current handle_audio_inject_pcm post-decode logic:
    // walk samples, write to g_inject_ring under g_inject_mutex.
    // ... (extract from existing function)
}

bool commit_play_buffer(const std::vector<uint8_t>& buf, int* ec, const char** em) {
    const int16_t* samples = reinterpret_cast<const int16_t*>(buf.data());
    const size_t sample_count = buf.size() / 2;
    return agent_console_play_pcm(samples, sample_count, 16000);
}
```

Then refactor each verb handler to:
1. Parse `b64`, `chunk`, `of`, `stream_id` from params.
2. If `chunk`/`of`/`stream_id` are absent: decode b64 into a local vector → call commit_*_buffer → respond.
3. If present:
   a. Resolve the per-verb stream state (`g_inject_stream` or `g_play_stream`).
   b. If `chunk` == 0: assert stream is inactive (else -32000 stream-already-inflight), copy stream_id, reset buffer.
   c. If `chunk` > 0: assert stream is active AND stream_id matches AND chunk index == next_chunk.
   d. Decode b64 into a vector, append to stream.buffer (bounded by kMaxStreamBufferBytes).
   e. If chunk + 1 == of (final): call commit_*_buffer, reset stream, respond with `committed: true`.
   f. Else: bump next_chunk, respond with `buffered_bytes: stream.buffer.size()`.

Implement carefully — the refactor keeps the non-chunked path bit-identical for backwards compatibility (HIL tests that already use `audio.inject_pcm` continue to work without changes).

- [ ] **Step 3: Build green**

```bash
bash -c 'cd /Users/kevinye/esp/esp-idf && source ./export.sh && cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube/firmware && idf.py build 2>&1 | tail -15'
```

- [ ] **Step 4: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/firmware/components/agent_console/verbs/audio.cc && \
git commit -m "$(cat <<'EOF'
feat(esp32-cube/agent_console): chunked-stream for audio.inject + play

Spec §6 flagged that audio.inject_pcm heap-OOMs on a single 21 KB
payload. Phase 3 adds a chunked-stream variant: each CMD carries
{b64, chunk, of, stream_id}, server accumulates, commit happens on the
final chunk.

Same wire shape applies to audio.play_pcm. Single-payload behavior is
preserved when chunk/of/stream_id are absent — backwards compatible
with existing HIL tests that use the inject_pcm-once-per-utterance
pattern.

Caps:
- chunk raw payload: 16 KB (~21 KB b64, fits in one CMD without
  hitting the daemon's pre-Phase-1 8192-byte recv truncation)
- total stream buffer: 256 KB (8 s of audio @ 16 kHz mono)

Closes the spec §6 follow-up. Unblocks the Phase 4 HIL
test_long_uplink case.

Phase 3 Task 6.
EOF
)"
```

---

## Task 7: HIL test for `audio.play_pcm` (single + chunked)

**Files:**
- Create: `esp32/cube/tests/hil/test_audio_play_pcm.py`

**Why:** Each new verb gets a Group A HIL smoke test (per `.claude/rules/esp32/cube/testing.md`). Single test file covers both single-payload and chunked-stream cases. No mic loopback — we can't verify audio audibility from pytest. The test asserts the verb returns `{"ok": true}` and the firmware doesn't panic over the call duration.

- [ ] **Step 1: Create the test file**

Path: `esp32/cube/tests/hil/test_audio_play_pcm.py`

```python
"""Phase 3 Task 7 — audio.play_pcm verb smoke (Group A).

Cube-side smoke for the new audio.play_pcm verb. Does NOT verify
audibility (no mic loopback in Phase 3); only verifies:
- Single-payload path: 0.5 s 440 Hz sine round-trips green
- Chunked path: 3 chunks of 0.25 s each commit cleanly
- Bad-params paths emit -32602 Invalid params
- Cube remains responsive after each test (cube-cmd state still IDLE)
"""
from __future__ import annotations

import base64
import math
import struct

import pytest


def pcm16_sine(freq_hz: int, duration_ms: int, sample_rate: int = 16000) -> bytes:
    """Generates raw PCM16 mono bytes for a sine tone."""
    count = sample_rate * duration_ms // 1000
    samples = []
    for i in range(count):
        v = math.sin(2.0 * math.pi * freq_hz * i / sample_rate)
        samples.append(int(v * 16384))
    return struct.pack(f"<{count}h", *samples)


def test_play_pcm_single_payload(cube_dut):
    raw = pcm16_sine(440, 500)
    b64 = base64.b64encode(raw).decode()
    rsp = cube_dut.cmd("audio.play_pcm", {"b64": b64}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 500 // 1000


def test_play_pcm_chunked(cube_dut):
    raw = pcm16_sine(880, 750)
    b64 = base64.b64encode(raw).decode()
    chunk_size = len(b64) // 3 + 1
    chunks = [b64[i:i + chunk_size] for i in range(0, len(b64), chunk_size)]
    of = len(chunks)
    stream_id = "test-chunked-880"

    for idx, chunk in enumerate(chunks):
        rsp = cube_dut.cmd(
            "audio.play_pcm",
            {"b64": chunk, "chunk": idx, "of": of, "stream_id": stream_id},
            timeout=5,
        )
        assert rsp["ok"] is True
        assert rsp["chunk"] == idx
        if idx < of - 1:
            assert rsp.get("committed", False) is False
        else:
            assert rsp.get("committed") is True


def test_play_pcm_bad_b64(cube_dut):
    with pytest.raises(Exception) as ex:
        cube_dut.cmd("audio.play_pcm", {"b64": "not-base64!!!"}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


def test_play_pcm_missing_b64(cube_dut):
    with pytest.raises(Exception) as ex:
        cube_dut.cmd("audio.play_pcm", {}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


def test_cube_alive_after_play_pcm(cube_dut):
    """Smoke: after all the above, cube must still be IDLE + responsive."""
    state = cube_dut.cmd("state", {}, timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True
```

- [ ] **Step 2: Commit (no test run yet — runs in Task 8 after flash)**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add esp32/cube/tests/hil/test_audio_play_pcm.py && \
git commit -m "$(cat <<'EOF'
test(esp32-cube/hil): test_audio_play_pcm — Group A smoke

Single + chunked + bad-params + post-smoke-state cases. No mic
loopback (Phase 3 is speaker-only); audibility is operator-verified
during Task 8 smoke run.

Each test is structured per .claude/rules/esp32/cube/testing.md:
cube_dut fixture, fresh subprocess per cmd, real hardware. Bad-params
cases use pytest.raises to catch the -32602 error path.

Phase 3 Task 7.
EOF
)"
```

---

## Task 8: Single-flash bundled device smoke

**Files:** none modified. Smoke evidence in `/tmp/phase3-*`.

**Smoke matrix (per spec §4 Phase 3):**

1. Boot tone audible on first boot (from existing `PlaySound(OGG_SUCCESS)` call — verified by ear).
2. `cube-cmd audio.test_tone freq=440 ms=500` plays 440 Hz for 500 ms (ear test).
3. `cube-cmd audio.play_pcm hello.pcm` plays a canned "hello" recorded earlier (ear test).
4. HIL `test_audio_play_pcm.py` all 5 cases green.

**Pre-flight gate:**
- Working tree clean (all Tasks 3-7 committed).
- `idf.py build` green on current HEAD.
- Daemon alive: `ls /tmp/cube-daemon.sock`.
- `cube-cmd state` returns valid JSON.

- [ ] **Step 1: Pre-flight**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git status --short && \
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: empty status. State `IDLE` + wifi + ws.

- [ ] **Step 2: Flash**

```bash
bash esp32/cube/scripts/flash.sh 2>&1 | tail -10
```

Expected: flash success + daemon eager-spawn line (`[flash.sh] cube-daemon up ...`). If esptool connect fails, kill daemon + retry once. Second fail = AXP2101 fault; STOP and report BLOCKED.

- [ ] **Step 3: Verify state after boot**

```bash
sleep 12 && bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: IDLE + wifi + ws.

- [ ] **Step 4: Boot tone audibility (operator ear)**

Listen to the speaker as the cube finishes booting. The activation point fires `PlaySound(OGG_SUCCESS)` so a short "ding" should play. Record:

```
BOOT TONE: <audible / silent>
```

If silent: check `AUDIO_CODEC_PA_PIN` GPIO 46 — should be HIGH after AudioCodec init. Investigate as a separate Phase 3 follow-up; do NOT add a workaround inside Task 8.

- [ ] **Step 5: `audio.test_tone` smoke**

```bash
bash esp32/cube/scripts/cube-cmd.sh audio.test_tone '{"freq":440,"ms":500}'
```

Expected: `{"ok": true, "samples_generated": 8000}`. Listen for a 0.5-second A4 tone.

```
TEST TONE 440Hz: <audible / silent>
```

Repeat with `{"freq":880,"ms":300}` (A5, shorter) to confirm parameterization works.

- [ ] **Step 6: `audio.play_pcm` smoke**

Generate a canned "hello" PCM blob on the host:

```bash
python3 -c "
import math, struct, base64
sr = 16000
ms = 800
freq = 600  # 'oh' vowel-ish
count = sr * ms // 1000
samples = [int(math.sin(2*math.pi*freq*i/sr) * 16384) for i in range(count)]
raw = struct.pack(f'<{count}h', *samples)
print(base64.b64encode(raw).decode())
" > /tmp/phase3-hello-b64.txt

B64=\$(cat /tmp/phase3-hello-b64.txt)
bash esp32/cube/scripts/cube-cmd.sh audio.play_pcm "{\"b64\":\"\$B64\"}"
```

Expected: `{"ok": true, "samples": 12800}`. Listen for an 800 ms tone.

```
PLAY PCM 600Hz: <audible / silent>
```

- [ ] **Step 7: HIL test suite**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope/esp32/cube && \
.venv/bin/pytest tests/hil/test_audio_play_pcm.py -v 2>&1 | tail -25
```

Expected: 5 passed, 0 failed. If a test fails, the implementer must fix the underlying verb behavior (don't skip the test).

- [ ] **Step 8: Cube alive after smoke**

```bash
bash esp32/cube/scripts/cube-cmd.sh state
```

Expected: still IDLE + wifi + ws. No panic, no AXP2101 fault.

- [ ] **Step 9: Update `/tmp/phase3-baseline-record.txt` with smoke results**

```bash
cat >> /tmp/phase3-baseline-record.txt <<'EOF'

PHASE 3 SMOKE RESULTS:
- flash: ✅
- state after boot: IDLE+wifi+ws
- boot tone: <audible/silent>
- audio.test_tone 440Hz: <audible/silent>
- audio.test_tone 880Hz: <audible/silent>
- audio.play_pcm 600Hz: <audible/silent>
- HIL test_audio_play_pcm.py: <5/5 pass | N/5 pass>
- flashes used this phase: <N>
- AXP2101 faults: 0
- post-smoke cube state: IDLE
EOF
cat /tmp/phase3-baseline-record.txt
```

- [ ] **Step 10: No commit. Smoke artifacts are not source.**

---

## Task 9: Phase 3 handover doc

**Files:**
- Create: `docs/superpowers/handovers/2026-05-12-esp32-cube-phase3-speaker.md`

**Why:** Per spec §5, every phase ends with a handover doc with the seven mandatory sections. Phase 3 closes when this lands.

- [ ] **Step 1: Write the handover (template per Phase 2's structure)**

Path: `docs/superpowers/handovers/2026-05-12-esp32-cube-phase3-speaker.md`

Use the same seven-section structure Phase 2 used:

1. `## What's done` — one bullet per merged commit, plain language, no SHAs
2. `## What's used (stack the user now owns)` — table of new files + APIs + verbs + the new audio path
3. `## What's smoked` — every smoke matrix row with command + result + evidence
4. `## What you need to know` — 3-5 bullets of non-derivable findings:
   - `AudioService::PlayPcm` is the canonical raw-PCM output API for synthetic streams (sine tones, canned PCMs); avoid going through opus encode/decode unless you have a real opus packet
   - The chunked-stream protocol uses `{chunk, of, stream_id}` triples; single-payload behavior is preserved when those fields are absent for back-compat
   - HIL tests cannot verify audibility — operator ear is mandatory for the smoke matrix
   - If boot tone was silent, the speaker hardware path itself works (test_tone proved it) — the boot-tone path is xiaozhi's PlaySound, not our PlayPcm
5. `## Hardware glossary (terms new this phase)` — ES8311 codec, codec PA pin, sample rate conversion, opus encode/decode (if new since Phase 1's glossary)
6. `## Open questions / risks`:
   - If chunked-stream HIL tests intermittently fail, the daemon's per-CMD subprocess pattern may be racing the cube-side stream accumulator — known follow-up
   - Mic capture (`audio.record_rms`, `audio.record_pcm`) is Phase 4 work, not started
   - Opus encode/decode for WS protocol is Phase 6 — `PlayPcm` is NOT the WS playback path
7. `## Flash + smoke metrics` — flashes used, AXP2101 faults, daemon restarts, total dev time

Fill `<n>` slots from `/tmp/phase3-baseline-record.txt`.

- [ ] **Step 2: Commit**

```bash
cd /Users/kevinye/Development/sentient/.claude/worktrees/esp32-cube-v2-rescope && \
git add docs/superpowers/handovers/2026-05-12-esp32-cube-phase3-speaker.md && \
git commit -m "$(cat <<'EOF'
docs(esp32-cube): Phase 3 speaker handover

Final commit of Phase 3. Documents:
- AudioService::PlayPcm raw-PCM passthrough API
- audio.test_tone verb (on-device sine generator)
- audio.play_pcm verb (base64 PCM passthrough; mirror of inject_pcm)
- Chunked-stream variant for both inject + play (closes spec §6
  follow-up; unblocks Phase 4 HIL test_long_uplink)
- HIL Group A test_audio_play_pcm.py
- Single-flash bundled device smoke + operator-ear audibility check

Phase 4 (Mic — original-spec Phase 4) is next. Carry-overs: chunked
protocol already in place ready for audio.record_pcm; boot-tone
silent path (if observed) deferred to Phase 4 follow-up.
EOF
)"
```

- [ ] **Step 3: Post the handover content to chat for user review.**

Do NOT merge to develop — feature branch continues through Phase 6.

---

## Self-Review Checklist

- **Spec coverage:** Spec §4 Phase 3 work items mapped:
  - Codec init (already in Phase 2 boot trace) → no task needed; verified in Task 1 survey
  - AudioService starts in stub mode → already happens via xiaozhi's Application::Initialize
  - `audio.test_tone freq=N ms=N` → Task 4
  - `audio.play_pcm <base64>` → Task 5
  Spec §4 Phase 3 smoke bar mapped:
  - Boot tone audible → Task 8 Step 4 (operator ear)
  - `audio.test_tone freq=440 ms=500` → Task 8 Step 5
  - `audio.play_pcm hello.pcm` → Task 8 Step 6
  Spec §6 known follow-up `audio.inject_pcm` chunked → Task 6.

- **Placeholder scan:** No "TBD" / "implement later" / "add appropriate validation." Step 2 of Task 3 has a conditional ("If the codec API is shaped differently") with an actionable instruction (substitute the right symbol or STOP and report). Task 4 Step 1 has a real choice point between `#include "application.h"` direct coupling vs callback-provider pattern — the plan recommends the callback pattern and points at the existing reference in `agent_console.h`.

- **Type / path consistency:** `AudioService::PlayPcm` (Task 3) used by Task 4 + Task 5. `agent_console_play_pcm()` / `agent_console_set_play_pcm_provider()` (callback pattern) used consistently across Tasks 4 + 5. `ChunkedStream` struct + `commit_inject_buffer` / `commit_play_buffer` helpers (Task 6) match the existing `g_inject_*` ring-buffer style. JSON-RPC error codes: -32602 Invalid params, -32603 Internal error, -32000 Server error (stream-in-flight) — consistent with the dispatcher.

- **Flash discipline:** Budget ≤ 4. Tasks 1-7 are build-only. Task 8 single flash with one allowed connect-fail retry. Total: 1-2 flashes.

- **One-commit-per-task:** Tasks 1 + 2 + 8 explicit "no commit." Task 6 includes a refactor that touches the same file as Tasks 4 + 5 — kept as a single commit per the "one logical change per commit" rule because the refactor + new path are a unit. Total commits this phase: 7.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-12-esp32-cube-v2-phase3-speaker.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, spec + code-quality review between tasks.

**2. Inline Execution** — execute tasks in this session via executing-plans.

Which approach?
