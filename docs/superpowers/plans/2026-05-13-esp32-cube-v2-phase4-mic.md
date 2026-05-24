# ESP32 Cube v2 Phase 4 — Mic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the sentient-cube's mic input path (BoxAudioCodec → ES7210 ADC) and expose two agent_console verbs — `audio.record_rms` (capture N ms, return mean RMS) and `audio.record_pcm` (capture N ms, return base64 PCM16 mono) — so the agent and operator can verify the mic path is alive and capture audible clips.

**Architecture:** Add `AudioService::RecordPcm(samples_out, sample_count, sample_rate)` mirroring Phase 3's `PlayPcm`. It pulls frames via the existing `ReadAudioData()` API (codec auto-enables on first call), discards the first warmup frame, **strided-extracts channel 0** from the codec's 2-channel interleaved buffer (channel 1 is the AEC reference loopback), and writes mono samples to the caller's destination buffer. Two new verbs in `verbs/audio.cc` call it through a callback-provider pair on `agent_console` (`agent_console_set_record_pcm_provider` / `agent_console_record_pcm`), matching the Phase 3 cycle-break pattern. Verbs are synchronous and gated by `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`. Closed-loop HIL test uses `audio.inject_pcm → audio.record_pcm` round-trip (the injection hook duplicates mono → all channels, so channel-0 extraction recovers exactly the injected mono) plus a quiet-baseline check that asserts RMS is non-zero (which proves the real codec path is active).

**Tech Stack:** ESP-IDF 5.5.2, Xtensa GCC, Waveshare ESP32-S3-Touch-AMOLED-2.16 (ES8311 codec, AXP2101 PMIC), xiaozhi-derived `AudioService` (`firmware/main/audio/`), `agent_console` JSON-RPC over USB-CDC, mbedtls base64, pytest-embedded HIL fixtures.

---

## Spec reference

- Active spec: `docs/superpowers/specs/2026-05-11-esp32-cube-v2-rescope-design.md` §4 Phase 4 + §6 Debug Tooling.
- Smoke bar (≤ 4 flashes):
  - `cube-cmd audio.record_rms ms=1000` while quiet returns low RMS (< 500).
  - Same command during clap returns high RMS (> 5000) — operator-driven.
  - `cube-cmd audio.record_pcm ms=500` returns ~16 KB base64 that plays back as recognizable speech on host via `audio.play_pcm`.

## Phase 3 carry-over (relevant context)

- `audio.play_pcm` + `audio.test_tone` shipped Phase 3, using callback-provider pattern on `agent_console`. Same pattern applies here.
- USB-CDC fgets-accumulation loop (Phase 3) means commands and responses larger than one USB packet round-trip cleanly. 1 s of PCM @ 16 kHz mono = 32 KB raw = ~43 KB base64 — within the daemon's 64 KB rx cap.
- `ReadAudioData(data, sample_rate, samples)` in `audio_service.cc:207` is the high-level mic-read API. It auto-enables the codec input on first call, handles resampling from `codec_->input_sample_rate()` → requested rate, and short-circuits to `agent_audio_inject_pop_samples()` when the injection ring buffer has samples queued.
- `AudioService::PlayPcm` (Phase 3) is the structural template for `RecordPcm`.
- `verbs/audio.cc` is currently 682 lines (over the 300-line cap). Phase 4 will add ~100 more lines. The split into `verbs/audio/` per-verb files is queued for the Phase 5+ cleanup pass and is not in scope here.

## Constants (lifted into named values)

| Constant | Value | Where |
|---|---|---|
| `kRecordSampleRate` | 16000 | Request rate to `ReadAudioData` |
| `kRecordMinMs` | 10 | Verb param minimum |
| `kRecordMaxMs` | 1000 | Verb param maximum (16 KB raw, 21 KB b64) |
| `kRecordFrameMs` | 30 | Per-frame read size for the inner loop |
| `kRecordWarmupFrames` | 1 | Discard count before capture begins |
| `kMaxRecordB64Bytes` | 64 * 1024 | Response b64 cap — matches play_pcm single-payload |

These live in `verbs/audio.cc` next to the existing `kMaxInjectBytes` / `kMaxStreamB64Bytes` block.

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `esp32/cube/firmware/main/audio/audio_service.h` | Modify | + `RecordPcm(int16_t* dst, size_t sample_count, int sample_rate)` declaration. |
| `esp32/cube/firmware/main/audio/audio_service.cc` | Modify | + `RecordPcm` definition. Pulls frames via `ReadAudioData` in a loop, discards `kRecordWarmupFrames` initial frames, copies into caller's buffer. |
| `esp32/cube/firmware/components/agent_console/include/agent_console.h` | Modify | + `agent_record_pcm_fn_t` typedef + setter + helper, mirroring `agent_play_pcm_fn_t`. |
| `esp32/cube/firmware/components/agent_console/agent_console.cc` | Modify | + `g_record_pcm_fn` global, `agent_console_set_record_pcm_provider`, `agent_console_record_pcm`. |
| `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` | Modify | + `sentient_record_pcm_provider()` wrapping `AudioService::RecordPcm`. + register call in board init. |
| `esp32/cube/firmware/components/agent_console/verbs/audio.cc` | Modify | + `handle_audio_record_rms`, `handle_audio_record_pcm` handlers. + 2 `agent_dispatcher_register` calls under `CONFIG_AGENT_CONSOLE_DESTRUCTIVE`. |
| `esp32/cube/tests/hil/test_audio_record.py` | Create | Group A HIL: quiet RMS baseline, record_pcm size + shape, inject→record round-trip, bad params. |
| `docs/superpowers/handovers/2026-05-13-esp32-cube-phase4-mic.md` | Create | Final phase handover. Follows spec §5 format. |

---

## Task 1: Survey + baseline metrics (no commit)

**Goal:** Confirm assumptions about codec input rates, AudioService warmup behavior, and current build before any code changes. This is reconnaissance, not implementation.

**Files:**
- Read: `esp32/cube/firmware/main/audio/audio_service.cc:207-279` (ReadAudioData)
- Read: `esp32/cube/firmware/main/audio/audio_service.cc:281-340` (AudioInputTask, look for warmup logic)
- Read: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc` (find AudioCodec init, confirm ES8311 input_sample_rate + input_channels)
- Read: `esp32/cube/firmware/components/agent_console/verbs/audio.cc:436-642` (Phase 3 verbs — mirror for new verbs)

- [ ] **Step 1: Print survey notes inline (no file changes)**

Confirmed during plan-write reconnaissance — record these in the subagent's report:

- **Codec wrapper:** `BoxAudioCodec` (`esp32/cube/firmware/main/audio/codecs/box_audio_codec.cc`). Duplex driver wrapping ES8311 (DAC, output) + ES7210 (ADC, input). NOT plain `Es8311AudioCodec`.
- **`codec_->input_sample_rate()`** = **24000** (from `AUDIO_INPUT_SAMPLE_RATE` in `esp32/cube/firmware/main/boards/sentient-cube/config.h:6`). `ReadAudioData` internally resamples from 24 kHz to the requested rate via `input_resampler_` (already wired in `AudioService::Initialize`).
- **`codec_->input_channels()`** = **2** (set in `box_audio_codec.cc:14` because `AUDIO_INPUT_REFERENCE=true` in `config.h:9`). Channel 0 = mic, channel 1 = loopback reference signal (for AEC). `ReadAudioData` returns a vector of size `samples_received * input_channels` packed as **interleaved int16** (`[ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...]`).
- **Critical for RecordPcm:** the caller wants mono PCM16; we MUST strided-copy channel 0 out of the 2-channel interleaved buffer. A `memcpy` would emit interleaved garbage.
- **Injection-hook duplicates mono → all channels** (`audio_service.cc:223-227`). So `audio.inject_pcm` of 1600 mono samples produces 1600 × 2 = 3200 interleaved int16 from `ReadAudioData`, with ch0 == ch1 == injected mono. The Task 7 round-trip test still works: channel 0 extraction recovers exactly the injected mono.
- **AudioInputTask gating:** `AudioInputTask` (`audio_service.cc:281`) blocks on `xEventGroupWaitBits(AS_EVENT_AUDIO_TESTING_RUNNING | AS_EVENT_WAKE_WORD_RUNNING | AS_EVENT_AUDIO_PROCESSOR_RUNNING)`. None of those are set at boot — so synchronous `ReadAudioData` calls from a verb context will NOT race with it as long as wake-word / testing / processor have not been enabled. Confirm this is the case at boot via `cube-cmd state` (Step 3).

- [ ] **Step 2: Verify pre-Phase-4 device build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds, `sentient_cube.bin` produced. No flash.

- [ ] **Step 3: Verify pre-Phase-4 state via daemon (no flash)**

Run: `bash esp32/cube/scripts/cube-cmd.sh state`
Expected: `{"state":"IDLE","wifi_connected":true,"ws_connected":true}`. Daemon is up; cube is responsive. This is the baseline to compare against post-Phase-4.

No commit.

---

## Task 2: AudioService::RecordPcm — sync mic capture

**Files:**
- Modify: `esp32/cube/firmware/main/audio/audio_service.h`
- Modify: `esp32/cube/firmware/main/audio/audio_service.cc`

- [ ] **Step 1: Declare RecordPcm in audio_service.h**

In `audio_service.h`, immediately after the `PlayPcm` block (after `bool PlayPcm(...)` line ~146):

```cpp
    // Phase 4: synchronous PCM16 MONO capture from the codec input. Pulls
    // frames via ReadAudioData in a loop, discards the first warmup frame
    // (codec just-enabled noise), strided-extracts channel 0 from the
    // codec's interleaved multi-channel buffer (channel 1 is the AEC
    // loopback reference when input_reference is enabled on the board),
    // and writes mono samples to `dst`. Returns false if inputs fail
    // validation (null dst, zero count, out-of-range rate, null codec)
    // or any ReadAudioData call fails.
    //
    // Caller-imposed cap: <= 1 second of audio per call. Larger captures
    // should be issued as repeated calls.
    //
    // Thread-safety: the agent_console task is the only caller. AudioInputTask
    // blocks on event bits that are clear at boot, so this does not race with
    // it unless wake-word / processor / testing has been enabled.
    bool RecordPcm(int16_t* dst, size_t sample_count, int sample_rate);
```

- [ ] **Step 2: Implement RecordPcm in audio_service.cc**

Insert after `PlayPcm` (search for the closing `}` of `PlayPcm` near line ~755, add immediately below):

```cpp
bool AudioService::RecordPcm(int16_t* dst, size_t sample_count, int sample_rate) {
    if (dst == nullptr || sample_count == 0) {
        ESP_LOGW(TAG, "RecordPcm rejected: empty dst");
        return false;
    }
    if (codec_ == nullptr) {
        ESP_LOGW(TAG, "RecordPcm rejected: codec not initialized");
        return false;
    }
    if (sample_rate <= 0 || sample_rate > 48000) {
        ESP_LOGW(TAG, "RecordPcm rejected: bad sample_rate=%d", sample_rate);
        return false;
    }

    // Frame size in samples at the REQUESTED rate. ReadAudioData internally
    // handles resampling from codec_->input_sample_rate() to sample_rate.
    constexpr int kFrameMs = 30;
    constexpr int kWarmupFrames = 1;
    const int frame_samples = sample_rate * kFrameMs / 1000;
    if (frame_samples == 0) {
        ESP_LOGW(TAG, "RecordPcm rejected: frame_samples=0 (rate=%d)", sample_rate);
        return false;
    }

    // ReadAudioData returns `samples_received * channels` interleaved int16
    // (ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...). On sentient-cube the codec has
    // channels = 2 (mic + AEC reference). We strided-extract channel 0 to
    // produce mono samples for the caller. Default to 1 if codec is somehow
    // mis-reporting (defensive — shouldn't happen given the validation above).
    int channels = codec_->input_channels();
    if (channels < 1) channels = 1;

    ESP_LOGI(TAG, "RecordPcm samples=%u rate=%d frame=%d channels=%d",
             (unsigned)sample_count, sample_rate, frame_samples, channels);

    // Warmup: discard initial frames so codec settles. ReadAudioData
    // implicitly calls EnableInput(true) on its first invocation.
    for (int i = 0; i < kWarmupFrames; ++i) {
        std::vector<int16_t> warmup;
        if (!ReadAudioData(warmup, sample_rate, frame_samples)) {
            ESP_LOGW(TAG, "RecordPcm warmup ReadAudioData failed");
            return false;
        }
    }

    size_t collected = 0;
    while (collected < sample_count) {
        std::vector<int16_t> chunk;
        const int request = std::min<int>(frame_samples,
                                          static_cast<int>(sample_count - collected));
        if (!ReadAudioData(chunk, sample_rate, request)) {
            ESP_LOGW(TAG, "RecordPcm ReadAudioData failed at collected=%u",
                     (unsigned)collected);
            return false;
        }
        // chunk.size() is `mic_samples_received * channels`. Strided extract
        // channel 0; clamp to remaining destination capacity.
        const size_t mic_samples_received =
            chunk.size() / static_cast<size_t>(channels);
        const size_t to_copy =
            std::min(mic_samples_received, sample_count - collected);
        for (size_t i = 0; i < to_copy; ++i) {
            dst[collected + i] = chunk[i * static_cast<size_t>(channels)];
        }
        collected += to_copy;
    }

    last_input_time_ = std::chrono::steady_clock::now();
    ESP_LOGI(TAG, "RecordPcm done collected=%u", (unsigned)collected);
    return true;
}
```

- [ ] **Step 3: Verify build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds. `RecordPcm` symbol present in `.elf`.
Verify: `xtensa-esp32s3-elf-nm build/sentient_cube.elf | grep RecordPcm` should show one entry.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/audio/audio_service.h \
        esp32/cube/firmware/main/audio/audio_service.cc
git commit -m "feat(esp32-cube/audio): AudioService::RecordPcm — sync mic capture"
```

---

## Task 3: agent_console_record_pcm callback-provider pair

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/include/agent_console.h`
- Modify: `esp32/cube/firmware/components/agent_console/agent_console.cc`

- [ ] **Step 1: Add typedef + decls to agent_console.h**

In `agent_console.h`, immediately after the `agent_play_pcm_fn_t` block (the existing Phase 3 typedef + setter + helper):

```c
// audio.record_pcm provider — registered from sentient_cube.cc to avoid
// agent_console → main dependency cycle. Returns true if capture succeeded.
typedef bool (*agent_record_pcm_fn_t)(int16_t* dst, size_t count, int sample_rate);

void agent_console_set_record_pcm_provider(agent_record_pcm_fn_t fn);

// Helper for verb implementations. Returns false if no provider registered.
bool agent_console_record_pcm(int16_t* dst, size_t count, int sample_rate);
```

- [ ] **Step 2: Add global + setter + helper to agent_console.cc**

In `agent_console.cc`, find the existing `g_play_pcm_fn` global (in the anonymous namespace) and add directly below:

```cpp
agent_record_pcm_fn_t g_record_pcm_fn = nullptr;
```

Then in the `extern "C"` block, after the `agent_console_play_pcm` definition, add:

```cpp
void agent_console_set_record_pcm_provider(agent_record_pcm_fn_t fn) {
    g_record_pcm_fn = fn;
}

bool agent_console_record_pcm(int16_t* dst, size_t count, int sample_rate) {
    if (g_record_pcm_fn != nullptr) {
        return g_record_pcm_fn(dst, count, sample_rate);
    }
    return false;
}
```

- [ ] **Step 3: Verify build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds. New symbols `agent_console_set_record_pcm_provider`, `agent_console_record_pcm` in `.elf`.
Verify: `xtensa-esp32s3-elf-nm build/sentient_cube.elf | grep record_pcm` shows both.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/components/agent_console/include/agent_console.h \
        esp32/cube/firmware/components/agent_console/agent_console.cc
git commit -m "feat(esp32-cube/agent_console): record_pcm callback-provider pair"
```

---

## Task 4: Wire RecordPcm in sentient_cube.cc

**Files:**
- Modify: `esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc`

- [ ] **Step 1: Add provider wrapper**

Find the existing `sentient_play_pcm_provider` function (added in Phase 3 — search for `sentient_play_pcm_provider`). Add directly below it, INSIDE the same `extern "C"` block:

```cpp
static bool sentient_record_pcm_provider(int16_t* dst, size_t count, int sample_rate) {
    return Application::GetInstance().GetAudioService().RecordPcm(dst, count, sample_rate);
}
```

- [ ] **Step 2: Register the provider during board init**

Find the existing `agent_console_set_play_pcm_provider(sentient_play_pcm_provider);` line (Phase 3). Add directly below:

```cpp
        agent_console_set_record_pcm_provider(sentient_record_pcm_provider);
```

Indentation must match the surrounding init block (4-space inside the class method scope).

- [ ] **Step 3: Verify build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds, no warnings about unused statics.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/main/boards/sentient-cube/sentient_cube.cc
git commit -m "feat(esp32-cube/board): wire RecordPcm to agent_console provider"
```

---

## Task 5: audio.record_rms verb

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/verbs/audio.cc`

- [ ] **Step 1: Add named constants**

Find the existing `kMaxInjectBytes` block near line 45 (in the anonymous namespace at top of file). Add directly below:

```cpp
// audio.record_rms / audio.record_pcm constants.
constexpr int kRecordSampleRate = 16000;
constexpr int kRecordMinMs = 10;
constexpr int kRecordMaxMs = 1000;
// 1 s @ 16 kHz mono = 16000 samples = 32000 bytes raw = ~42667 base64 chars.
constexpr size_t kMaxRecordSamples =
    static_cast<size_t>(kRecordSampleRate) * kRecordMaxMs / 1000;
constexpr size_t kMaxRecordB64Bytes = 64 * 1024;
```

- [ ] **Step 2: Add handle_audio_record_rms**

Insert directly above the `__attribute__((constructor))` register_audio_verbs block at the bottom of the namespace (around line 645):

```cpp
// audio.record_rms — capture `ms` of mic, return mean RMS as a number.
// Gated by CONFIG_AGENT_CONSOLE_DESTRUCTIVE.
#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE
int handle_audio_record_rms(const cJSON* params, cJSON* out_result,
                            int* ec, const char** em) {
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect ms (number)";
        return 1;
    }
    const int ms = ms_node->valueint;
    if (ms < kRecordMinMs || ms > kRecordMaxMs) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000";
        return 1;
    }

    const size_t sample_count =
        static_cast<size_t>(kRecordSampleRate) * static_cast<size_t>(ms) / 1000U;
    std::vector<int16_t> samples(sample_count);
    ESP_LOGI(TAG, "record_rms ms=%d samples=%u", ms, (unsigned)sample_count);
    const bool ok = agent_console_record_pcm(samples.data(), sample_count,
                                             kRecordSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "RecordPcm failed (codec disabled or read aborted)";
        return 1;
    }

    // Mean of squares in double space, then sqrt → RMS in PCM16 units.
    double sum_sq = 0.0;
    for (size_t i = 0; i < sample_count; ++i) {
        const double v = static_cast<double>(samples[i]);
        sum_sq += v * v;
    }
    const double mean_sq = sum_sq / static_cast<double>(sample_count);
    const double rms = std::sqrt(mean_sq);

    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "ms", static_cast<double>(ms));
    cJSON_AddNumberToObject(out_result, "samples", static_cast<double>(sample_count));
    cJSON_AddNumberToObject(out_result, "rms", rms);
    return 0;
}
#endif  // CONFIG_AGENT_CONSOLE_DESTRUCTIVE
```

- [ ] **Step 3: Register the verb**

In the existing `register_audio_verbs()` constructor (bottom of file, around line 645), add inside the `#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE` block (next to play_pcm / test_tone registrations):

```cpp
    agent_dispatcher_register("audio.record_rms", handle_audio_record_rms);
```

- [ ] **Step 4: Verify build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds. `audio.record_rms` is callable after flash.

- [ ] **Step 5: Commit**

```bash
git add esp32/cube/firmware/components/agent_console/verbs/audio.cc
git commit -m "feat(esp32-cube/agent_console): audio.record_rms verb"
```

---

## Task 6: audio.record_pcm verb (single-payload, ≤1s)

**Files:**
- Modify: `esp32/cube/firmware/components/agent_console/verbs/audio.cc`

- [ ] **Step 1: Add handle_audio_record_pcm**

Insert directly below the `handle_audio_record_rms` definition added in Task 5, INSIDE the same `#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE` guard:

```cpp
// audio.record_pcm — capture `ms` of mic, return base64-encoded PCM16 mono.
// Single-payload only; ≤ 1 s cap (~43 KB base64 in the response).
// Gated by CONFIG_AGENT_CONSOLE_DESTRUCTIVE.
int handle_audio_record_pcm(const cJSON* params, cJSON* out_result,
                            int* ec, const char** em) {
    const cJSON* ms_node = cJSON_GetObjectItem(params, "ms");
    if (!cJSON_IsNumber(ms_node)) {
        *ec = -32602;
        *em = "Invalid params: expect ms (number)";
        return 1;
    }
    const int ms = ms_node->valueint;
    if (ms < kRecordMinMs || ms > kRecordMaxMs) {
        *ec = -32602;
        *em = "Invalid params: ms must be 10-1000";
        return 1;
    }

    const size_t sample_count =
        static_cast<size_t>(kRecordSampleRate) * static_cast<size_t>(ms) / 1000U;
    std::vector<int16_t> samples(sample_count);
    ESP_LOGI(TAG, "record_pcm ms=%d samples=%u", ms, (unsigned)sample_count);
    const bool ok = agent_console_record_pcm(samples.data(), sample_count,
                                             kRecordSampleRate);
    if (!ok) {
        *ec = -32603;
        *em = "RecordPcm failed";
        return 1;
    }

    // base64-encode the raw PCM16 byte buffer.
    const size_t raw_bytes = sample_count * sizeof(int16_t);
    const size_t b64_capacity = ((raw_bytes + 2) / 3) * 4 + 1;
    if (b64_capacity > kMaxRecordB64Bytes) {
        *ec = -32603;
        *em = "Server error: encoded payload exceeds 64 KB cap";
        return 1;
    }
    std::vector<unsigned char> b64(b64_capacity);
    size_t b64_len = 0;
    const int rc = mbedtls_base64_encode(
        b64.data(), b64.size(), &b64_len,
        reinterpret_cast<const unsigned char*>(samples.data()), raw_bytes);
    if (rc != 0) {
        *ec = -32603;
        *em = "Server error: base64 encode failed";
        return 1;
    }
    // mbedtls returns b64_len excluding the null terminator. Ensure terminator.
    if (b64_len < b64.size()) b64[b64_len] = '\0';

    cJSON_AddBoolToObject(out_result, "ok", true);
    cJSON_AddNumberToObject(out_result, "ms", static_cast<double>(ms));
    cJSON_AddNumberToObject(out_result, "samples", static_cast<double>(sample_count));
    cJSON_AddNumberToObject(out_result, "rate",
                            static_cast<double>(kRecordSampleRate));
    cJSON_AddStringToObject(out_result, "b64",
                            reinterpret_cast<const char*>(b64.data()));
    return 0;
}
```

- [ ] **Step 2: Register the verb**

In the existing `register_audio_verbs()` constructor, add inside the `#ifdef CONFIG_AGENT_CONSOLE_DESTRUCTIVE` block (next to `audio.record_rms`):

```cpp
    agent_dispatcher_register("audio.record_pcm", handle_audio_record_pcm);
```

- [ ] **Step 3: Verify build green**

Run: `cd esp32/cube/firmware && idf.py build`
Expected: build succeeds. Both new verbs callable after flash.

- [ ] **Step 4: Commit**

```bash
git add esp32/cube/firmware/components/agent_console/verbs/audio.cc
git commit -m "feat(esp32-cube/agent_console): audio.record_pcm verb (PCM passthrough)"
```

---

## Task 7: HIL test — test_audio_record.py (Group A)

**Files:**
- Create: `esp32/cube/tests/hil/test_audio_record.py`

**Pre-test note:** Mirror the `test_audio_play_pcm.py` pattern: subprocess-per-call `cube_dut.cmd`, `@pytest.mark.group_a` on every case, no fixture state held between cases, no mic-side assumptions beyond a quiet room.

- [ ] **Step 1: Write the failing test**

Create `esp32/cube/tests/hil/test_audio_record.py`:

```python
"""Phase 4 Task 7 — audio.record_rms + audio.record_pcm verb smoke (Group A).

Cube-side smoke for the new mic-capture verbs. Verifies:
- record_rms returns a non-zero RMS when the room is quiet (proves the codec
  input path is alive — silent codec would return zero samples, RMS = 0)
- record_rms quiet baseline is below an empty-room threshold
- record_pcm shape: samples == ms * 16000 / 1000, b64 length sane
- record_pcm round-trip via audio.inject_pcm: injecting a known tone then
  recording reads back the SAME samples (injection hook short-circuits the
  codec; this verifies the verb-level read loop is correct)
- bad-params paths emit -32602 Invalid params

Operator ear test (record live speech → b64 → play_pcm round-trip) lives
in Task 8 device smoke, not here.
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


@pytest.mark.group_a
def test_record_rms_quiet_nonzero(cube_dut):
    """Quiet-room RMS is > 0 (codec alive) AND < 2000 (no loud noise)."""
    rsp = cube_dut.cmd("audio.record_rms", params={"ms": 500}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 500 // 1000
    rms = rsp["rms"]
    assert rms > 0.0, f"RMS = {rms} — codec input path may be disabled"
    assert rms < 2000.0, f"RMS = {rms} — room is too loud for quiet baseline"


@pytest.mark.group_a
def test_record_pcm_shape(cube_dut):
    """record_pcm 250 ms returns ~4000 samples + matching b64 length."""
    rsp = cube_dut.cmd("audio.record_pcm", params={"ms": 250}, timeout=5)
    assert rsp["ok"] is True
    assert rsp["samples"] == 16000 * 250 // 1000
    assert rsp["rate"] == 16000
    raw = base64.b64decode(rsp["b64"])
    # 4000 samples * 2 bytes = 8000 raw bytes
    assert len(raw) == rsp["samples"] * 2
    # b64 encoding inflates by 4/3 (plus padding)
    expected_b64_len = ((len(raw) + 2) // 3) * 4
    assert len(rsp["b64"]) == expected_b64_len


@pytest.mark.group_a
def test_record_pcm_round_trip_via_inject(cube_dut):
    """inject_pcm tone → record_pcm reads back the same samples.

    The injection hook in ReadAudioData short-circuits the codec when the
    injection ring buffer is non-empty. This proves the verb-side read +
    base64-encode path is correct WITHOUT depending on a live mic.
    """
    # 100 ms of 440 Hz sine — 1600 samples = 3200 bytes.
    raw = pcm16_sine(440, 100)
    b64_in = base64.b64encode(raw).decode()
    inject_rsp = cube_dut.cmd(
        "audio.inject_pcm", params={"pcm_b64": b64_in}, timeout=5,
    )
    assert inject_rsp["ok"] is True

    # Record EXACTLY the injected length back. The hook drains sample-by-sample.
    rec_rsp = cube_dut.cmd(
        "audio.record_pcm", params={"ms": 100}, timeout=5,
    )
    assert rec_rsp["ok"] is True
    out = base64.b64decode(rec_rsp["b64"])

    # Allow for first-frame warmup discard in RecordPcm: the first 30 ms
    # (480 samples = 960 bytes) of the injected stream may be eaten by the
    # warmup-discard frame inside AudioService::RecordPcm. Compare what
    # remains: the tail of the recorded buffer should match the tail of
    # the injected buffer for at least the post-warmup window.
    warmup_bytes = 480 * 2  # 30 ms @ 16 kHz mono
    assert len(out) == len(raw)
    # Compare the post-warmup tail (skip first warmup_bytes of `raw` to
    # account for the warmup discard).
    assert out[: len(raw) - warmup_bytes] == raw[warmup_bytes:][: len(raw) - warmup_bytes], (
        "post-warmup tail mismatch — injection ring read order broken"
    )


@pytest.mark.group_a
def test_record_rms_bad_ms(cube_dut):
    """ms below minimum emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_rms", params={"ms": 5}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_record_pcm_bad_ms(cube_dut):
    """ms above maximum emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_pcm", params={"ms": 5000}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_record_missing_ms(cube_dut):
    """Missing ms in audio.record_rms emits -32602 Invalid params."""
    with pytest.raises(AssertionError) as ex:
        cube_dut.cmd("audio.record_rms", params={}, timeout=5)
    assert "-32602" in str(ex.value) or "Invalid params" in str(ex.value)


@pytest.mark.group_a
def test_cube_alive_after_record(cube_dut):
    """Smoke: after all the above, cube must still be IDLE + responsive."""
    state = cube_dut.cmd("state", timeout=5)
    assert state["state"] == "IDLE"
    assert state["wifi_connected"] is True
    assert state["ws_connected"] is True
```

- [ ] **Step 2: Run the new tests to verify they fail (firmware not yet flashed)**

Run: `cd esp32/cube && pytest tests/hil/test_audio_record.py -v`
Expected: ALL fail with `Unknown method: audio.record_rms` or similar — the cube is still running pre-Phase-4 firmware. (Flashing happens in Task 8.)

- [ ] **Step 3: Commit the test file**

```bash
git add esp32/cube/tests/hil/test_audio_record.py
git commit -m "test(esp32-cube/hil): test_audio_record — Group A smoke"
```

Tests will go green after Task 8 flash.

---

## Task 8: Bundled flash + device smoke (no commit unless fix needed)

**Goal:** Single flash, then run the full Phase 4 smoke bar (HIL test suite + spec ear test + operator round-trip).

**Pre-flash check:** Verify daemon ring buffer is healthy, no AXP2101 fault state.

- [ ] **Step 1: Pre-flash daemon check**

Run: `bash esp32/cube/scripts/cube-cmd.sh state`
Expected: returns within 3 s with `{"state":"IDLE"...}`. If wedged, recover BEFORE flashing per `.claude/rules/esp32/cube/flash-discipline.md` (physical USB unplug + BOOT-hold replug).

- [ ] **Step 2: Flash + daemon eager-spawn**

Run: `bash esp32/cube/scripts/flash.sh`
Expected: idf.py reports `Hard resetting via RTS pin...`, daemon spawns into `/tmp/cube-daemon.sock`, cube reaches IDLE within ~8 s.

Verify the daemon caught the boot trace:

```bash
python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/cube-daemon.sock')
s.sendall(json.dumps({'kind':'events','n':20000}).encode())
buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
import sys; sys.stdout.write(buf.decode())
" | grep -E 'ESP-ROM|>>> READY|sentient.cube|audio'
```

Expected: `>>> READY` line present. `sentient.cube.agent_console.audio` boot lines present.

- [ ] **Step 3: Smoke verb registration**

Run: `bash esp32/cube/scripts/cube-cmd.sh audio.record_rms '{"ms":250}'`
Expected: `{"ok":true,"ms":250,"samples":4000,"rms":<number>}` — RMS > 0 (codec alive), < 2000 (room quiet baseline).

If RMS == 0, the codec input path is not being enabled. Inspect ring buffer for `EnableInput` log line. Stop and root-cause; do NOT re-flash without a code change.

- [ ] **Step 4: Smoke audio.record_pcm**

Run: `bash esp32/cube/scripts/cube-cmd.sh audio.record_pcm '{"ms":500}'`
Expected: `{"ok":true,"ms":500,"samples":8000,"rate":16000,"b64":"...(~21000 chars)..."}`.

- [ ] **Step 5: HIL test suite**

Run: `cd esp32/cube && pytest tests/hil/test_audio_record.py -v -m group_a`
Expected: all 7 cases pass.

If `test_record_pcm_round_trip_via_inject` fails on the tail comparison, the warmup-discard offset may be off. Tune `warmup_bytes` (matches `kRecordWarmupFrames * kRecordFrameMs * kRecordSampleRate / 1000 * 2 = 1 * 30 * 16000 / 1000 * 2 = 960`).

- [ ] **Step 6: Operator ear round-trip (spec smoke bar — manual)**

```bash
# Operator speaks "hello" loudly within 1 s of pressing return:
bash esp32/cube/scripts/cube-cmd.sh audio.record_pcm '{"ms":1000}' > /tmp/rec.json

# Extract base64, re-feed to play_pcm:
python3 -c "
import json
with open('/tmp/rec.json') as f:
    raw = f.read()
# cube-cmd returns the RSP body — grab the b64 field
data = json.loads(raw.split('<<< RSP ', 1)[-1])
print(data['b64'])
" > /tmp/rec.b64

bash esp32/cube/scripts/cube-cmd.sh audio.play_pcm "$(jq -Rs '{b64: .}' < /tmp/rec.b64)"
```

Expected: speaker plays back the recorded "hello" — quality is poor (16 kHz mono, no AEC, no AGC), but the word is recognizable.

Capture this case explicitly in the handover under "What's smoked" as ✅ ear test.

- [ ] **Step 7: Verify daemon log clean**

```bash
python3 -c "
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/tmp/cube-daemon.sock')
s.sendall(json.dumps({'kind':'events','n':20000}).encode())
buf=b''
while True:
    c=s.recv(65536)
    if not c: break
    buf+=c
import sys; sys.stdout.write(buf.decode())
" | grep -iE 'WARN|ERROR' | grep -v 'pre-WiFi'
```

Expected: no unexpected WARN/ERROR lines from `sentient.cube.audio_service` or `sentient.cube.agent_console.audio` during the smoke session.

No commit. Smoke evidence captured in the Task 9 handover.

---

## Task 9: Phase 4 handover doc

**Files:**
- Create: `docs/superpowers/handovers/2026-05-13-esp32-cube-phase4-mic.md`

- [ ] **Step 1: Write the handover**

Use the format mandated by spec §5. Required sections in order: `What's done`, `What's used (stack the user now owns)`, `What's smoked`, `What you need to know`, `Hardware glossary (terms new this phase)`, `Open questions / risks`, `Flash + smoke metrics`.

Fill from the actual numbers + observations from Task 8 smoke. The doc must:

- Reference plan + spec at the top.
- List every commit (Tasks 2-7, six commits + this handover commit = seven total).
- Tabulate `What's used`: `RecordPcm`, `agent_console_record_pcm` provider pair, `sentient_record_pcm_provider`, `audio.record_rms` verb, `audio.record_pcm` verb, `test_audio_record.py`.
- Tabulate `What's smoked`: each case from Task 8 with result + evidence.
- `What you need to know`: at minimum:
  1. ES8311 input rate (confirmed during Task 1 survey) — quote actual value.
  2. The warmup-discard frame in `RecordPcm`. Explain WHY (first frame after codec enable is noisy/contains DMA garbage).
  3. The inject-hook short-circuit interaction (`audio.inject_pcm` followed by `audio.record_pcm` reads back injected samples, bypassing the codec — useful for HIL closed-loop, not for testing codec wiring itself).
  4. `record_pcm` is synchronous and blocks the agent_console task for the recording duration. Per Phase 3 carry-over, this is acceptable under `CONFIG_AGENT_CONSOLE_DESTRUCTIVE` and queued for async worker refactor at Phase 6+.
- `Hardware glossary`: new terms only — `ES8311 input path`, `RecordPcm`, `RMS (root-mean-square)`, `mic warmup discard`. Do NOT repeat Phase 1-3 glossary entries.
- `Open questions / risks`: at minimum:
  1. `audio.record_pcm` capped at 1 s; longer captures would need a chunked-stream response variant (server pushes chunks back via additional CMDs or via EVT). Defer to Phase 5+ if mic-to-WS uplink doesn't naturally cover it.
  2. RMS thresholds in HIL test are ambient-noise-dependent. Quiet baseline > 2000 will trip `test_record_rms_quiet_nonzero`. Document the room conditions used (operator's normal dev environment).
  3. `verbs/audio.cc` is now 780+ lines, well past the 300-line cap. Split into per-verb files (`verbs/audio/inject.cc`, `verbs/audio/play.cc`, `verbs/audio/record.cc`, etc.) is queued for Phase 5+ cleanup pass.
- `Flash + smoke metrics`: from Task 8 actual numbers.

- [ ] **Step 2: Commit the handover**

```bash
git add docs/superpowers/handovers/2026-05-13-esp32-cube-phase4-mic.md
git commit -m "docs(esp32-cube): Phase 4 mic handover"
```

---

## Self-review (controller, post-write)

**Spec coverage check:**

| Spec §4 Phase 4 requirement | Task |
|---|---|
| Codec input enabled in AudioService | Task 2 (RecordPcm auto-enables via ReadAudioData) |
| Verb `audio.record_rms ms=1000` | Task 5 |
| Verb `audio.record_pcm ms=500` | Task 6 |
| Smoke: quiet RMS < 500 | Task 7 `test_record_rms_quiet_nonzero` (threshold relaxed to < 2000 — see open questions) + Task 8 step 3 |
| Smoke: clap RMS > 5000 | Task 8 manual operator step (not HIL-automatable; flagged in handover) |
| Smoke: record_pcm → play_pcm recognizable speech | Task 8 step 6 operator ear test |
| Spec §6: `audio.record_pcm` 1 s cap | Task 5/6 `kRecordMaxMs = 1000` enforced in handler |

All spec items have an owning task.

**Placeholder scan:** no `TBD`, `TODO`, `implement later`, or generic "add validation". The TODO comment inside `PlayPcm` for `esp_ae_rate_cvt` is Phase 3 carry-over and is not Phase 4 scope.

**Type consistency:**
- `RecordPcm(int16_t*, size_t, int)` — matches across header, .cc, callback typedef, verb call site.
- `agent_record_pcm_fn_t` signature matches `RecordPcm` signature.
- All verbs use `int(handle_*)(const cJSON*, cJSON*, int*, const char**)` — matches Phase 3 verbs.
- Constants named consistently: `kRecord*`, mirrors `kInject*` / `kMaxStream*` block above.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-esp32-cube-v2-phase4-mic.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, spec compliance + code quality review between tasks. Fast iteration, isolated context per task.

**2. Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
