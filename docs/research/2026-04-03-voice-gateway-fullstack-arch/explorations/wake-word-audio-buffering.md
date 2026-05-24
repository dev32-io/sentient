# On-Device Wake Word & Audio Buffering

## Decision Area
Wake word detection and circular audio buffering on mobile clients (Android, iOS). Web client uses push-to-talk only (no wake word).

## Key Questions
- Picovoice Porcupine: SDK quality on Android/iOS, custom wake word training?
- Alternatives: openWakeWord, Snowboy successors, platform-native voice triggers?
- Circular buffer design: ring buffer size (2-3s), sample rate, memory footprint?
- Pre-trigger audio: how is buffered audio transmitted to gateway?
- Power/battery impact of always-on mic on mobile?
- Web client: no wake word — PTT only (simpler path)
- Custom wake word vs built-in keywords: training effort, accuracy tradeoff?
- False positive/negative rates and tuning sensitivity
- iOS background recording limitations — is always-on mic actually possible?

## Prior Research
- Porcupine identified as primary candidate in project constraints
- Always-on mic with circular buffer is the specified architecture
- Sources already cataloged: Porcupine docs, openWakeWord, TPCircularBuffer, AudioRecord API
- Prior Python iteration did not deeply explore wake word — this is new ground

## Findings

### Wake Word Engine Landscape

#### Picovoice Porcupine (v4.0.2)
- **Platforms**: Android (Kotlin/Java), iOS (Swift/ObjC), Web (WASM via `@picovoice/porcupine-web`), RPi, Python, .NET, Flutter, React Native, Go, Rust, C
- **Audio format**: Single-channel, 16-bit linear PCM, 16 kHz sample rate, 512-sample frames (~32ms per frame)
- **Detection accuracy**: 97%+ detection rate, <1 false alarm per 10 hours (with background speech/noise)
- **CPU usage**: ~3.8% of a single Arm Cortex-A53 core (RPi 3 benchmark); 6.5x faster than competitors
- **Memory**: ~1 MB standard model; ~250 KB compressed model (still 90%+ accuracy)
- **Detection latency**: Sub-frame — detection fires on the frame boundary after utterance ends (~32ms)
- **Custom wake words**: Type-to-train via Picovoice Console — enter a phrase, get a `.ppn` model file in seconds. Best results with 6+ phonemes, 3+ syllables. Custom words achieve comparable accuracy to built-in keywords when phrase is well-chosen.
- **Languages**: English, Mandarin, French, German, Italian, Japanese, Korean, Portuguese, Spanish
- **Pricing**: Free tier allows unlimited interactions for up to 3 active users/month. For 10 devices, may need paid tier. Enterprise plans historically $6,000/year. Picovoice now redirects pricing page to contact form — need to confirm current terms for personal use.
- **Verdict**: Best-in-class for mobile — turnkey SDKs, instant custom training, proven low resource usage.

#### openWakeWord (dscripka/openWakeWord)
- **License**: Apache 2.0, fully open source
- **Audio format**: 16-bit 16 kHz PCM, 80ms frame windows
- **Accuracy**: False-reject <5%, false-accept <0.5/hour
- **Performance**: Single RPi 3 core runs 15-20 models simultaneously
- **Custom training**: Synthetic-data-driven (TTS via Piper), Google Colab notebook trains a model in <1 hour. Uses Google's pre-trained speech embeddings + small classification head.
- **Platforms**: Linux (x86/arm64), Windows, Raspberry Pi. **No native Android/iOS SDK** — would need custom ONNX runtime wrapper.
- **Verdict**: Great open-source option for server-side or RPi, but lacks mobile SDKs. Not viable for on-device mobile wake word without significant custom work.

#### Snowboy (Kitt-AI) — Dead
- Shut down December 2020. Fork at `seasalt-ai/snowboy` exists but accuracy and resource usage are significantly worse than modern options. **Not viable.**

#### Platform-Native Options — Not Viable for Custom Wake Words
- **Android**: "OK Google" is the only always-on system wake word. Voice Interaction API doesn't support custom wake words. Third-party apps cannot access low-power DSP hotword path.
- **iOS**: "Hey Siri" is the only always-on wake word. SiriKit domains are limited, wake phrase cannot be changed. Shortcuts cannot do always-on mic listening.
- **Bottom line**: Neither platform allows custom always-on wake words natively. A third-party engine is required.

### Circular Audio Buffer Design

#### Buffer Parameters
- **Duration**: 2 seconds is the sweet spot. Wake words take ~0.5-1s to speak; Porcupine detects at utterance end, so buffer captures the start of the wake word plus any leading speech. Amazon/Google devices use ~2s. Beyond 3s adds RAM with no STT benefit.
- **Sample rate**: 16 kHz, 16-bit mono PCM — matches both Porcupine's requirement and STT engine inputs (Whisper, Deepgram).
- **Memory footprint** (16 kHz, 16-bit mono):
  - 1 second = 32 KB
  - 2 seconds = 64 KB
  - 5 seconds = 160 KB
  - Negligible on mobile. 64 KB for the recommended 2s buffer.

#### Platform Implementations
- **Android**: Simple `ShortArray` or `ByteArray` with head/tail indices. No need for a library — the data structure is trivial at 64 KB.
- **iOS**: [TPCircularBuffer](https://github.com/michaeltyson/TPCircularBuffer) — uses virtual memory mapping trick (two adjacent VM pages mapped to same physical memory), eliminating wrap-around pointer arithmetic. Lock-free single-producer/single-consumer via `OSAtomic`. Handles `AudioBufferList` natively. Classic, proven solution for iOS audio.

### Android Audio Pipeline

#### AudioRecord Setup
```
AudioSource: VOICE_RECOGNITION
Sample rate: 16000 Hz
Channel: CHANNEL_IN_MONO
Encoding: ENCODING_PCM_16BIT
Buffer size: getMinBufferSize() * 2-3x (avoid overruns)
```

#### Foreground Service (Android 14+)
- Must declare `android:foregroundServiceType="microphone"` in manifest
- Requires `FOREGROUND_SERVICE_MICROPHONE` permission + runtime `RECORD_AUDIO`
- Subject to while-in-use restrictions: cannot start from background or `BOOT_COMPLETED` receiver
- Must start while app has a visible activity
- No explicit time limit (unlike `mediaProcessing` which caps at 6 hours)
- Persistent notification required (standard for foreground services)

#### Pipeline Flow
```
AudioRecord thread → read 512-sample frames
  → feed each frame to porcupine.process()
  → simultaneously write each frame into ring buffer
  → on keyword detection (index >= 0):
      1. Drain ring buffer as pre-trigger audio
      2. Open WebSocket (or use existing connection)
      3. Send control message + pre-trigger binary frame
      4. Continue forwarding live frames until VAD signals end-of-utterance
```

#### Battery Impact
- Continuous AudioRecord at 16kHz mono: ~1-3% battery per hour on modern SoCs
- Many devices offload always-on audio capture to dedicated coprocessor (Qualcomm Hexagon, Google Audio DSP)
- Porcupine adds negligible CPU (<4% of one core)
- Combined: moderate but acceptable for a family assistant that stays plugged in at home most of the time

### iOS Audio Pipeline

#### AVAudioEngine Setup
- Install tap on `inputNode` with format 16kHz/mono
- Hardware mic renders at 44.1kHz/32-bit; AVAudioEngine handles conversion automatically via `installTap(onBus:bufferSize:format:)`
- Write incoming `AVAudioPCMBuffer` data into TPCircularBuffer

#### Background Recording — Severely Limited
- **iOS does not support true always-on mic for third-party apps**
- Can declare `audio` background mode, but Apple restricts to active audio sessions (playback, VoIP calls)
- A pure "listening" app will be suspended when backgrounded
- The **orange dot** indicator is always visible when mic is active — acceptable for personal/family use
- **Practical options**:
  1. App stays foregrounded (viable for dedicated family device — e.g., old iPad as kitchen terminal)
  2. Fall back to push-to-talk when backgrounded
  3. Use a hardware satellite mic that feeds audio to gateway directly (out of scope)
- **Distribution**: TestFlight / personal distribution via Ad Hoc or Apple Developer Enterprise — no App Store review concerns for background audio justification

#### Pipeline Flow
Same as Android: tap → Porcupine → ring buffer → WebSocket

### Pre-Trigger Audio Transmission Protocol

#### Recommended Approach: Control Message + Binary Frame
```
1. Client sends JSON control message:
   {"type": "session.start", "pretrigger_ms": 2000, "sample_rate": 16000, "encoding": "pcm_s16le"}

2. Immediately followed by binary WebSocket frame containing ring buffer contents (contiguous read)

3. Then continue sending live binary frames until end-of-utterance
```

#### Gateway-Side Handling
- Concatenate pre-trigger binary frame with live stream into single audio byte stream
- Forward to STT as continuous audio — boundary metadata stays at gateway layer
- STT service just sees continuous audio, no special handling needed
- Gateway can use `pretrigger_ms` for logging/analytics but STT doesn't need it

#### Why Not Other Approaches
- **Silent prepend** (no metadata): Gateway can't distinguish pre-trigger from live audio for logging/barge-in timing
- **Separate upload**: Adds latency — STT must wait for pre-trigger before processing live audio
- **Timestamp offset**: Overcomplicates; STT engines don't use absolute timestamps

### Web Client — Push-to-Talk Only

- No wake word detection (as specified in constraints)
- Use **Web Audio API** (`AudioContext` + `AudioWorkletNode`) for PTT capture
- Downsample from browser's native 48kHz to 16kHz in AudioWorklet
- Send raw PCM frames over WebSocket — same protocol as mobile but without pre-trigger
- **Avoid MediaRecorder**: outputs Opus/WebM which adds unnecessary transcoding at gateway
- PTT activation: button press sends `session.start` control message, release sends `session.end`

## Approaches

### Approach A: Porcupine on Mobile + PTT on Web (Recommended)

**Description**: Use Picovoice Porcupine for wake word detection on Android and iOS clients with continuous recording into a 2-second ring buffer. Web client uses push-to-talk only. Custom wake word trained via Picovoice Console.

**Architecture**:
- Android: AudioRecord → Porcupine → ring buffer → WebSocket (foreground service)
- iOS: AVAudioEngine → Porcupine → ring buffer → WebSocket (foregrounded app or PTT fallback when backgrounded)
- Web: AudioWorkletNode → PTT capture → WebSocket

**Pros**:
- Turnkey SDKs for all three mobile platforms (Android, iOS, Web WASM)
- Custom wake word training is trivial (type-to-train)
- 97%+ detection accuracy, <1 FA/10hr
- Minimal resource usage: ~1 MB RAM, <4% CPU, 64 KB ring buffer
- Well-documented integration patterns
- Pre-trigger audio provides seamless UX — no perceived detection delay

**Cons**:
- Vendor lock-in to Picovoice (proprietary, though free tier exists)
- Pricing uncertainty — free tier may cover 3 users but family has 5+
- iOS background limitations mean always-on wake word only works when app is foregrounded
- Custom wake word accuracy depends on phoneme selection (short words perform worse)

**Mitigations**:
- Contact Picovoice for personal/home pricing; worst case ~$50/month is within personal project budget
- iOS limitation is inherent to the platform, not Porcupine — accept foregrounded-or-PTT trade-off
- Choose a 3+ syllable wake word for best accuracy

### Approach B: openWakeWord on Gateway + PTT Everywhere

**Description**: Skip on-device wake word entirely. Clients send audio only when user explicitly triggers (PTT on all platforms). Optionally, run openWakeWord on the gateway/RPi as a server-side wake word detector for a dedicated always-on microphone.

**Architecture**:
- All clients: PTT only — no continuous recording, no ring buffer
- Optional: USB mic on RPi → openWakeWord → gateway processes locally

**Pros**:
- No vendor dependency (Apache 2.0 open source)
- No mobile battery drain from continuous recording
- No iOS background recording limitations to work around
- Simpler client code — no foreground service, no ring buffer
- RPi can run 15-20 wake word models on a single core

**Cons**:
- Loses the "natural voice assistant" UX — must physically press a button
- No pre-trigger audio capture (user must speak after pressing button)
- Server-side wake word only works in the room with the RPi mic — not mobile
- openWakeWord has no mobile SDKs — can't easily add on-device detection later
- Fundamentally different product experience — more "walkie-talkie" than "assistant"

### Approach C: Hybrid — Porcupine Mobile + openWakeWord on RPi

**Description**: Porcupine for on-device wake word on Android/iOS with ring buffer. Additionally, openWakeWord running on the RPi with a USB mic for hands-free kitchen/living room use. Web client PTT.

**Architecture**:
- Android/iOS: Same as Approach A (Porcupine + ring buffer + WebSocket)
- RPi: USB mic → openWakeWord → gateway creates a "local" session
- Web: PTT only

**Pros**:
- Best of both worlds: mobile wake word + room-based wake word
- RPi acts as a smart speaker equivalent for common areas
- openWakeWord is free and open source for the RPi component
- Reduces need for phones in high-traffic areas (kitchen, living room)

**Cons**:
- Two different wake word engines to maintain
- RPi microphone quality and pickup range are limited
- More complex system — two audio input paths to the same gateway
- Wake word consistency: different engines may have different sensitivity/false-positive profiles
- RPi mic is out of scope for the core architecture (nice-to-have, not essential)

## iOS Background Recording — Deep Dive

This is the most significant constraint in the decision area. Key findings:

1. **Third-party apps cannot do always-on background mic recording on iOS**. The `audio` background mode is for playback and VoIP, not passive listening.
2. **When foregrounded**, the app works perfectly — Porcupine + AVAudioEngine + ring buffer all function correctly. The orange dot is visible but acceptable for family use.
3. **When backgrounded**, the app must degrade to push-to-talk or be suspended by iOS.
4. **For dedicated devices** (e.g., old iPad mounted in kitchen as a family terminal), foregrounded mode is fine — the device serves a single purpose.
5. **For personal phones**, the UX is: open app → speak naturally (wake word works) → close app → must use PTT or notification.

This is a platform limitation, not a technical one. All approaches must accept it.

## Decomposition

### Shared Wire Protocol Contract

All three clients (Android, iOS, Web) MUST implement the same wire-level contract for audio transmission. This is the authoritative specification — client-gateway-protocol.md defines message types, this defines audio byte-level semantics.

#### Audio Format Specification
```
Canonical format: Linear PCM, signed 16-bit little-endian, 16 kHz, mono
Byte rate: 32,000 bytes/sec (16000 samples × 2 bytes)
Abbreviation in protocol: "pcm_s16le"
```
All clients capture and transmit in this format (or Opus-encode from it). This matches both Porcupine's input requirement and all STT providers' accepted input.

#### Porcupine Frame Contract
```
Frame size: 512 samples = 1024 bytes = 32ms
Feed rate: ~31.25 frames/sec
Input: Int16[] (signed 16-bit) array of exactly 512 elements
Output: keyword index (>= 0 means detected, -1 means not detected)
```
Clients MUST accumulate variable-size audio engine output into exactly 512-sample frames before calling `porcupine.process()`. Partial frames are buffered until complete.

#### Ring Buffer Contract
```
Capacity: 64,000 bytes = 2 seconds at 16kHz/16-bit/mono
  (64,000 not 65,536 — exactly 2.0 seconds, no fractional frames)
Write: every audio frame (from audio capture callback)
Read: only on wake word detection (drain entire contents)
Overwrite policy: oldest data silently overwritten when full (circular)
```

#### Pre-Trigger Transmission Sequence
```
Step 1: Client sends JSON text frame:
  {
    "type": "session.start",
    "encoding": "pcm_s16le",      // or "opus" if Opus-encoded
    "sample_rate": 16000,
    "pretrigger_ms": <actual_ms>   // actual buffer fill, 0-2000
  }

Step 2: Client sends ONE binary WebSocket frame:
  Contents: contiguous ring buffer drain (oldest bytes first)
  Size: 0 to 64,000 bytes (depends on buffer fill level)
  If buffer has < 1 frame of data, skip this step (send 0 pre-trigger)

Step 3: Client sends binary frames continuously (live audio):
  Chunk size: 640 bytes (10ms) to 3200 bytes (100ms) — flexible
  Rate: real-time (as captured from microphone)
  
Step 4: Client sends JSON text frame when speech ends:
  { "type": "audio.end" }
```

**Gateway contract**: Gateway concatenates Step 2 + Step 3 bytes into a single continuous PCM stream and relays to STT. The `pretrigger_ms` value is metadata for logging/analytics only — STT sees no boundary.

#### Web Client (PTT) Simplified Sequence
```
Step 1: { "type": "session.start", "encoding": "pcm_s16le", "sample_rate": 16000 }
  (no pretrigger_ms field — PTT has no pre-trigger buffer)
Step 2: Binary frames continuously (live audio from PTT press)
Step 3: { "type": "audio.end" } (on PTT release)
```

#### Barge-In + Ring Buffer Interaction
When user speaks the wake word while TTS is playing:
1. Client immediately stops TTS playback
2. Client sends `{ "type": "barge_in" }` text frame
3. Client waits for `{ "type": "barge_in.ack" }` (or proceeds optimistically)
4. Ring buffer already contains pre-trigger audio from the new utterance
5. Client sends new `session.start` → pre-trigger binary → live frames
6. Ring buffer does NOT need explicit flushing — it continuously overwrites, so it always has the most recent 2 seconds

### Testing Strategy

#### Ring Buffer Tests (Unit — per platform)

| Test | Assertion |
|------|-----------|
| Write below capacity | Drain returns exact bytes written, in order |
| Write at capacity | Drain returns exactly `capacity` bytes |
| Write past capacity (wrap) | Drain returns most recent `capacity` bytes, oldest overwritten |
| Drain empty buffer | Returns 0 bytes, no crash |
| Drain after drain | Second drain returns 0 bytes (buffer is empty) |
| Write after drain | Fresh writes start from 0, drain returns only new data |
| Byte order preserved | Write [0x01,0x00,0xFF,0x7F], drain returns same sequence |
| Exact 2-second fill | Write 64,000 bytes → drain returns 64,000 bytes |
| Partial frame write | Incomplete frames are still stored and drained correctly |

**Android**: JUnit tests on `RingBuffer` class (plain Kotlin, no Android framework dependency).
**iOS**: XCTest on `TPCircularBuffer` wrapper (Swift, runs on macOS — no simulator needed).
**Web**: Vitest on `RingBuffer` class (SharedArrayBuffer-backed, runs in Node).

#### Wake Word Pipeline Tests (Integration — per platform)

| Test | Setup | Assertion |
|------|-------|-----------|
| Detection triggers drain | Mock Porcupine returning index=0 on frame N | Ring buffer drained, `session.start` sent, pre-trigger binary sent |
| No detection continues buffering | Mock Porcupine returning -1 | Ring buffer accumulates, no WebSocket sends |
| Frame accumulation | Feed variable-size audio buffers (128, 256, 640 samples) | Porcupine receives exactly 512-sample frames |
| Pre-trigger size accuracy | Fill buffer with 1.5s of audio, trigger detection | `pretrigger_ms` = 1500, binary frame = 48,000 bytes |
| Barge-in during playback | TTS playing + wake word detected | Playback stops, `barge_in` sent, new session starts |
| Rapid double-trigger | Two detections 200ms apart | Only one session started, second ignored (debounce) |
| Audio format correct | Capture → ring buffer → drain | PCM is 16-bit LE, 16kHz, mono (validate with WAV header check in test) |

**Android**: Instrumented tests using `AudioRecord` mock (or Robolectric shadow). Mock `Porcupine` via interface injection.
**iOS**: XCTest with mock `AVAudioPCMBuffer` sequences. Mock `Porcupine` via protocol/class substitution.
**Web**: Vitest with mock `AudioWorkletProcessor` messages. Mock Porcupine WASM via stub.

#### End-to-End Protocol Tests (Gateway Integration)

| Test | Setup | Assertion |
|------|-------|-----------|
| Pre-trigger + live = continuous stream | Simulated client sends `session.start` + 64KB binary + live frames | Gateway STT relay receives one continuous byte stream |
| Gateway ignores pretrigger_ms for STT | Client sends `pretrigger_ms: 2000` | STT relay receives raw bytes with no boundary markers |
| PCM and Opus sessions coexist | Two clients: one PCM, one Opus | Gateway handles both correctly per session encoding |
| Empty pre-trigger (Web PTT) | Client sends `session.start` (no pretrigger_ms) + live frames | Gateway handles gracefully, no empty binary frame expected |

**Implementation**: Bun test runner, mock STT provider that captures raw bytes, assert byte-level correctness.

#### Wake Word Debounce/False-Positive Tests

| Test | Assertion |
|------|-----------|
| Sensitivity tuning | At sensitivity 0.5: known wake word audio → detected |
| False positive suppression | 10 minutes of background speech → <1 false trigger |
| Rapid re-trigger debounce | Detection within 500ms of previous → ignored |
| Multiple keywords | Two `.ppn` models loaded → correct keyword index returned |

These require real Porcupine SDK (not mocked) with recorded audio samples.

### Thread-Safety Model Per Platform

#### Android: Dedicated Thread + Channel Bridge

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│  AudioCaptureThread         │   │  Main / Coroutine Scope     │
│  (THREAD_PRIORITY_URGENT_   │   │                             │
│   AUDIO)                    │   │  WebSocket send coroutine   │
│                             │   │  UI state updates           │
│  - AudioRecord.read()       │   │                             │
│  - porcupine.process()      │   │  Consumes from:             │
│  - ringBuffer.write()       │──→│  Channel<AudioEvent>        │
│  - on detection: post event │   │    .WAKE_WORD(bufferDrain)  │
│                             │   │    .AUDIO_FRAME(bytes)      │
│  Invariants:                │   │    .SILENCE_DETECTED        │
│  - No allocations in loop   │   │                             │
│  - No coroutine suspension  │   │  Invariants:                │
│  - No lock contention       │   │  - Channel is buffered (64) │
│  - @Volatile for stop flag  │   │  - Backpressure: drop oldest│
└─────────────────────────────┘   └─────────────────────────────┘
```

**Ring buffer synchronization**: The ring buffer is only accessed from the AudioCaptureThread — write happens continuously, drain happens on detection (same thread). No cross-thread access needed. The drained bytes are posted to the Channel as a `ByteArray` copy (immutable snapshot). The Channel is the only cross-thread communication point.

**Why not `synchronized`**: The audio thread must never block. A `synchronized` block could cause priority inversion if the coroutine scope holds the lock. The Channel-based approach is wait-free on the producer side (buffered channel, drop-oldest policy).

**Porcupine thread safety**: `Porcupine.process()` is safe to call from any single thread. It is NOT thread-safe for concurrent calls. Since only AudioCaptureThread calls it, this is satisfied.

#### iOS: Real-Time Thread + Actor Bridge

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│  CoreAudio Real-Time Thread │   │  AudioPipeline Actor        │
│  (installTap callback)      │   │                             │
│                             │   │  async func handleWakeWord()│
│  - Read AVAudioPCMBuffer    │   │  async func sendAudio()     │
│  - Accumulate 512 samples   │   │                             │
│  - porcupine.process()      │   │  Consumes from:             │
│  - TPCircularBuffer.write() │──→│  AsyncStream<AudioEvent>    │
│  - on detection: yield event│   │    .wakeWord(bufferDrain)   │
│                             │   │    .audioFrame(Data)        │
│  Invariants:                │   │    .silenceDetected         │
│  - NO memory allocation     │   │                             │
│  - NO Objective-C messaging │   │  Invariants:                │
│  - NO locks (TPCircularBuf  │   │  - Actor serializes access  │
│    is lock-free SPSC)       │   │  - WebSocket sends in order │
│  - NO Swift async/await     │   │  - Backpressure: bounded    │
│  - Pre-allocated arrays     │   │    bufferingPolicy(.newest) │
└─────────────────────────────┘   └─────────────────────────────┘
```

**TPCircularBuffer thread safety**: Lock-free single-producer/single-consumer via memory barriers. Producer = audio thread, Consumer = actor (drains on wake word event). This is the exact SPSC pattern TPCircularBuffer is designed for.

**Critical real-time thread rules (iOS-specific)**:
- No `objc_msgSend` (no Objective-C method dispatch) — use C functions only
- No `malloc`/`free` — pre-allocate all buffers before audio engine starts
- No Swift `async`/`await` — runtime may suspend, which blocks the audio thread
- No `print`/`NSLog` — both allocate
- Porcupine's `process()` is a C function call (via Swift-C interop) — safe

**Sample accumulator on real-time thread**: Use a pre-allocated `UnsafeMutableBufferPointer<Int16>` with write index. Reset index after each 512-sample frame is consumed. No dynamic array growth.

#### Web: AudioWorklet Thread + Main Thread Bridge

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│  AudioWorkletProcessor      │   │  Main Thread                │
│  (separate thread/process)  │   │                             │
│                             │   │  WebSocket send             │
│  - process() callback       │   │  UI updates                 │
│  - Downsample 48kHz→16kHz   │   │                             │
│  - Write to SharedArrayBuf  │   │  Consumes from:             │
│    ring buffer              │──→│  MessagePort events         │
│  - Porcupine WASM runs here │   │    { type: 'wakeWord',     │
│  - on detection: postMessage│   │      pretrigger: ArrayBuf } │
│                             │   │    { type: 'audio',         │
│  Invariants:                │   │      data: ArrayBuffer }    │
│  - 128-sample render quanta │   │                             │
│  - Accumulate to 512 for    │   │  Invariants:                │
│    Porcupine                │   │  - Transferable objects     │
│  - No DOM access            │   │    (zero-copy via transfer) │
│  - No blocking              │   │  - postMessage is async     │
└─────────────────────────────┘   └─────────────────────────────┘
```

**Web has no wake word (PTT only)**: The AudioWorklet processes audio only during PTT press. No Porcupine, no ring buffer. The architecture above shows the theoretical full path — in practice, the Web client's AudioWorklet just downsamples and posts audio chunks to the main thread.

**Simplified Web PTT flow**:
1. User presses PTT → `AudioContext.resume()` + create `AudioWorkletNode`
2. AudioWorklet downsamples 48kHz float32 → 16kHz int16 in `process()` callback
3. Posts `Int16Array` chunks to main thread via `MessagePort`
4. Main thread sends binary WebSocket frames
5. User releases PTT → disconnect AudioWorklet, send `audio.end`

**SharedArrayBuffer alternative** (for zero-copy): If latency between AudioWorklet and main thread is a concern, use a SharedArrayBuffer as a ring buffer with Atomics for synchronization. Overkill for PTT — `postMessage` with `Transferable` is sufficient.

### Sub-Tasks Identified

From this decomposition, the following concrete work items emerge:

1. **Android ring buffer + pipeline PoC** (already in task queue as `android-client-audio-pipeline`)
2. **iOS ring buffer + pipeline PoC** (not yet in queue — needs TPCircularBuffer + Porcupine + AVAudioEngine integration test)
3. **Web AudioWorklet PTT PoC** (already in queue as `web-client-ptt-audio`)
4. **Gateway pre-trigger handling test** (covered by `provider-integration-bun-ws`)
5. **Cross-platform wire format validation** — ensure all three clients produce byte-identical PCM for the same audio input (manual verification during integration)

### Porcupine/Opus Frame Mismatch (Flagged in android-client decompose task)

Porcupine requires 512-sample frames (32ms at 16kHz). Opus uses 960-sample frames (20ms at 48kHz) or 320-sample frames (20ms at 16kHz). These don't align.

**Resolution**: Porcupine and Opus operate on independent frame boundaries. Audio capture produces a continuous PCM stream. Two independent consumers accumulate to their own frame sizes:
- Porcupine accumulator: collects 512 samples, processes, resets
- Opus encoder (when added): collects 320 samples, encodes, resets
- Ring buffer: stores raw PCM continuously, frame-boundary-agnostic

No synchronization needed between Porcupine and Opus — they're independent read-only consumers of the same PCM stream.

## Open Questions

1. **Porcupine pricing for personal use**: Free tier covers 3 active users/month. Family of 5 may need paid tier. Need to contact Picovoice for current personal/home pricing.
2. **Custom wake word selection**: What phrase? Should be 3+ syllables, 6+ phonemes. Family could vote on a name. Needs testing for false-positive rate in home environment.
3. **Multiple wake words**: Could different family members have different wake words? Porcupine supports multiple keywords simultaneously — worth exploring for personalization.
4. **iOS Guided Access mode**: Could lock the device to the assistant app on a dedicated iPad, preventing backgrounding entirely. Worth testing.
