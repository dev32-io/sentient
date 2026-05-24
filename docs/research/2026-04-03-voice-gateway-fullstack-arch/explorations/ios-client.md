# iOS Client — Swift/SwiftUI

## Decision Area
Native iOS client with wake word detection, continuous recording, and voice UI for a family AI assistant.

## Key Questions
- Audio capture: AVAudioEngine with input tap for 16kHz mono PCM?
- Circular buffer: TPCircularBuffer for pre-trigger audio?
- Wake word: Porcupine iOS SDK integration with AVAudioEngine?
- Background recording: what's actually possible on iOS for third-party apps?
- WebSocket: URLSessionWebSocketTask vs Starscream?
- Audio session: category, mode, interruption handling, route changes?
- Distribution: TestFlight vs Ad Hoc vs personal provisioning?
- SwiftUI: @Observable, conversation UI, voice state indicators?
- Battery: always-on mic impact on iPhone?

## Prior Research
- Swift + SwiftUI is a hard constraint
- Porcupine iOS SDK is the specified wake word solution
- Wake word exploration (wake-word-audio-buffering.md) established: Porcupine v4.0.2, 16kHz/mono/16-bit PCM, 512-sample frames, 2-second ring buffer (64KB), iOS background recording is severely limited
- TPCircularBuffer identified as the iOS ring buffer solution (VM-mapped, lock-free SPSC)
- Android client exploration provides parallel architecture reference
- Sources already cataloged: Starscream, URLSessionWebSocketTask comparison, TPCircularBuffer

## Findings

### Audio Capture Pipeline

#### AVAudioEngine Configuration
```swift
let audioEngine = AVAudioEngine()
let inputNode = audioEngine.inputNode

// Request 16kHz mono 16-bit PCM — AVAudioEngine handles conversion from hardware native (44.1/48kHz float32)
let desiredFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16000,
    channels: 1,
    interleaved: true
)!

inputNode.installTap(onBus: 0, bufferSize: 512, format: desiredFormat) { buffer, time in
    // Runs on real-time audio thread
    // Feed to Porcupine, write to ring buffer
}

try audioEngine.start()
```

**Important caveats:**
- `bufferSize` is a *hint* — iOS may deliver buffers of varying sizes. Must accumulate to exactly 512 samples for Porcupine.
- On some devices/OS versions, requesting `pcmFormatInt16` directly may fail. Safer fallback: install tap with `pcmFormatFloat32` at 16kHz mono, then convert to Int16 manually (`sample * 32767`).
- When audio route changes (Bluetooth connect/disconnect), `inputNode` format changes. Must stop engine, remove tap, reinstall tap, restart. This is a critical pitfall.

#### Threading Model: Real-Time Audio Thread
The `installTap` callback runs on a real-time audio thread managed by CoreAudio. **Do not** allocate memory, take locks, or perform blocking work in this callback.

Safe operations in the callback:
- Writing to TPCircularBuffer (lock-free)
- Calling `porcupine.process()` (no allocations)
- Appending to a pre-allocated accumulation buffer

To bridge to Swift concurrency, use `AsyncStream`:
```swift
let audioStream = AsyncStream<AVAudioPCMBuffer> { continuation in
    inputNode.installTap(onBus: 0, bufferSize: 512, format: format) { buffer, _ in
        continuation.yield(buffer)  // Non-blocking, thread-safe
    }
}

Task {
    for await buffer in audioStream {
        await audioPipeline.processBuffer(buffer)
    }
}
```

#### Ring Buffer: TPCircularBuffer
[TPCircularBuffer](https://github.com/michaeltyson/TPCircularBuffer) uses a virtual memory mapping trick — two adjacent VM pages mapped to the same physical memory — eliminating wrap-around pointer arithmetic. Lock-free for single-producer/single-consumer.

```
Initialize: 64KB = 2 seconds at 16kHz/16-bit/mono
Producer: audio tap callback writes PCM frames
Consumer: wake word handler drains pre-trigger audio

On wake word detection:
  1. Read all available bytes (contiguous thanks to VM trick)
  2. Send as pre-trigger binary WebSocket frame
  3. Continue forwarding live frames
```

TPCircularBuffer is a C library (just two files: `.c` + `.h`). Add directly to Xcode project or wrap in a local Swift package. No official SPM package but community forks exist.

#### Porcupine Frame Accumulation
Since AVAudioEngine may deliver variable-size buffers, accumulate to 512-sample frames:

```swift
var sampleAccumulator = [Int16]()  // Pre-allocated capacity of 1024+

// In tap callback:
let frameCount = Int(buffer.frameLength)
let channelData = buffer.int16ChannelData![0]

for i in 0..<frameCount {
    sampleAccumulator.append(channelData[i])
}

while sampleAccumulator.count >= 512 {
    let frame = Array(sampleAccumulator.prefix(512))
    sampleAccumulator.removeFirst(512)
    
    let keywordIndex = try? porcupine.process(frame)
    if let index = keywordIndex, index >= 0 {
        // Wake word detected — drain ring buffer, start streaming
    }
}

// Simultaneously write to TPCircularBuffer
TPCircularBufferProduceBytes(&circularBuffer, channelData, UInt32(frameCount * 2))
```

**Note**: The `append`/`removeFirst` pattern involves allocations on the audio thread. For production, use a fixed-size array with read/write indices. Acceptable for prototyping.

### AVAudioSession Configuration

```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(
    .playAndRecord,          // Simultaneous input + output (mic + TTS playback)
    mode: .voiceChat,        // Echo cancellation + AGC enabled
    options: [
        .defaultToSpeaker,   // Output to speaker, not earpiece
        .allowBluetooth,     // Bluetooth headsets
        .allowBluetoothA2DP  // Bluetooth speakers for TTS output
    ]
)
try session.setPreferredSampleRate(16000)  // Hint only; hardware may not honor
try session.setActive(true, options: .notifyOthersOnDeactivation)
```

**Why `.playAndRecord` + `.voiceChat`:**
- `.playAndRecord` required for simultaneous mic capture and TTS playback
- `.voiceChat` mode enables system echo cancellation (critical when TTS audio is playing and user speaks)
- `.defaultToSpeaker` overrides voiceChat's default earpiece routing

#### Interruption Handling (Phone Calls, Siri)
```
AVAudioSession.interruptionNotification:
  .began → AVAudioEngine auto-paused, stop Porcupine processing, update UI
  .ended + .shouldResume → restart audioEngine, resume Porcupine
```

AVAudioEngine is automatically paused when iOS interrupts the audio session. Must explicitly restart after interruption ends.

#### Audio Route Changes (Bluetooth, Headphones)
```
AVAudioSession.routeChangeNotification:
  .oldDeviceUnavailable → Bluetooth disconnected, headphones unplugged
  .newDeviceAvailable → New device connected
```

**Critical**: After route change, `inputNode.inputFormat(forBus: 0)` may return a different format. Must stop engine → remove tap → reinstall tap with new format → restart. Failure to do this causes crashes or silent failures.

### Background Recording — The Hard Constraint

**iOS does NOT support true always-on background mic recording for third-party apps.**

| Mode | What It Actually Does |
|------|----------------------|
| `UIBackgroundModes: ["audio"]` | Keeps app alive for audio *playback* and VoIP, not passive listening |
| Pure listening app | Suspended within seconds of backgrounding |
| Silent audio workaround | Play inaudible audio to keep background mode active — works for sideloaded apps, Apple rejects from App Store |

**iOS 17/18 status**: The silent-audio workaround still works for personal distribution as of iOS 18. iOS 17+ added more aggressive background app termination for resource-heavy apps, but low-power audio processing stays within bounds.

**Practical modes for this project:**

1. **Dedicated device (iPad in kitchen)**: Keep app foregrounded. Use Guided Access mode to lock to the app. Always-on wake word works perfectly. This is the primary use case.

2. **Personal phone, app foregrounded**: Wake word works. Orange mic indicator dot visible (acceptable for family use, actually a transparency feature).

3. **Personal phone, app backgrounded**: Wake word stops. Degrade to push-to-talk via notification action or re-opening the app.

4. **Silent audio workaround** (optional): Play inaudible audio loop to keep background mode active. Viable for personal distribution (no App Store review). Adds complexity, uncertain reliability across iOS updates. Battery impact minimal. Worth implementing as an opt-in setting.

**This is a platform limitation, not a technical one. The architecture must accept foreground-first wake word with graceful degradation.**

### WebSocket Client: URLSessionWebSocketTask vs Starscream

| Feature | URLSessionWebSocketTask | Starscream 4.x |
|---------|------------------------|-----------------|
| Dependency | Built-in (Foundation) | Third-party (~50KB) |
| Async/await | Native (iOS 15+) | No (callback-based, wrap in AsyncStream) |
| Binary frames | `.send(.data(Data))` | `.write(data: Data)` |
| Reconnection | Manual (~20 lines) | Configurable built-in |
| Ping/pong | Manual `sendPing()` | Built-in |
| TLS/proxy | Via URLSession delegate | Custom settings |
| Compression | No permessage-deflate | Yes |
| Maturity | iOS 13+ (5 years) | 10+ years, 7k GitHub stars |

**Recommendation: URLSessionWebSocketTask**
- Zero dependency — consistent with SwiftUI-native philosophy
- Native async/await fits Swift concurrency model used throughout the app
- Binary frame support is equivalent
- Reconnection is straightforward:
```swift
func receiveLoop(_ task: URLSessionWebSocketTask) {
    Task {
        do {
            while task.state == .running {
                let message = try await task.receive()
                handleMessage(message)
            }
        } catch {
            try await Task.sleep(for: .seconds(reconnectDelay))
            connect()  // Exponential backoff with jitter
        }
    }
}
```
- If Starscream were needed for permessage-deflate or advanced features, it's easy to swap in later

### Audio Codec: Opus vs Raw PCM

Same analysis as Android client. At 16kHz mono:
- Raw PCM: 256 kbps — fine on WiFi
- Opus 24kbps: 10.6x compression — needed for cellular

**iOS Opus options:**
1. **AVAudioConverter** (built-in): Can encode to Opus via AudioToolbox on iOS 16+. Availability not guaranteed on all configurations.
2. **libopus via C interop**: Bring libopus source into Xcode project. Swift can call C directly — no bridging header complexity with SPM. Most reliable.
3. **Raw PCM passthrough**: Simplest for prototyping. Fine for WiFi-primary home use.

**Recommendation**: Start with raw PCM. Add Opus via libopus C interop for v1 if cellular use is needed. At home on WiFi, raw PCM is perfectly adequate.

### SwiftUI Architecture

#### State Management: @Observable (iOS 17+)
```swift
@Observable
class ConversationViewModel {
    var messages: [Message] = []
    var voiceState: VoiceState = .idle    // .idle/.listening/.processing/.speaking
    var connectionState: ConnectionState = .disconnected
    var audioLevel: Float = 0.0           // For voice activity indicator
}

// No @Published, @ObservedObject wrappers needed
// @Observable tracks property access automatically
```

For iOS 16 support, fall back to `ObservableObject` + `@Published`.

#### Key UI Components

1. **Conversation View**: `LazyVStack` inside `ScrollView` (not `List` — chat bubbles need custom styling that fights List's opinions). `ScrollViewReader` + `.scrollTo()` for auto-scroll on new messages.

```swift
ScrollViewReader { proxy in
    ScrollView {
        LazyVStack(spacing: 12) {
            ForEach(viewModel.messages) { message in
                MessageBubbleView(message: message)
                    .id(message.id)
            }
        }
    }
    .onChange(of: viewModel.messages.count) {
        withAnimation {
            proxy.scrollTo(viewModel.messages.last?.id, anchor: .bottom)
        }
    }
}
```

2. **Voice Activity Indicator**: Pulsing circle with `withAnimation(.easeInOut.repeatForever())`. Audio level drives ring scale via `scaleEffect()` bound to `audioLevel`.

3. **Tool Confirmation**: `.sheet` or `.confirmationDialog` — shows tool name, parameters, Allow/Deny. Non-modal preferred (user can see conversation behind).

4. **Connection Status**: `.toolbar` item showing connected/reconnecting/disconnected with SF Symbol icons.

#### Concurrency: Actors for Thread Safety
```swift
actor AudioPipeline {
    private var audioEngine: AVAudioEngine?
    private var porcupine: Porcupine?
    private var circularBuffer: TPCircularBuffer
    
    func start() async throws { /* setup */ }
    func stop() async { /* cleanup */ }
    func handleWakeWord() async { /* drain buffer, start streaming */ }
}
```

Bridge from real-time audio thread via `AsyncStream` (as shown above). Actor serializes all state mutations safely.

#### Haptic Feedback for Voice States
```swift
// Wake word detected → medium impact
UIImpactFeedbackGenerator(style: .medium).impactOccurred()

// End of speech → light impact
UIImpactFeedbackGenerator(style: .light).impactOccurred()

// Response starting → success notification
UINotificationFeedbackGenerator().notificationOccurred(.success)
```

Prepare generators in advance via `.prepare()` for lower latency.

### Battery Impact

| Scenario | Drain/hr (iPhone 15, ~3,349mAh) |
|----------|----------------------------------|
| AVAudioEngine 16kHz, screen off | ~1-2% |
| + Porcupine processing | ~1.5-2.5% |
| + WebSocket streaming (WiFi) | ~2.5-4% |
| + WebSocket streaming (cellular) | ~5-10% |

**Key difference from Android**: iOS does not expose the low-power audio coprocessor to third-party apps. Android devices with Qualcomm Hexagon DSP can offload always-on audio to dedicated hardware (<0.5%/hr). On iOS, all processing runs on the main A-series chip. Result: ~2-4%/hr vs Android's potential ~1-2%/hr with DSP offload.

**Mitigation**: For personal phones, battery drain is only during foreground use (background mic stops). For dedicated iPad plugged in, battery is irrelevant.

### App Distribution

| Method | Device Limit | Build Expiry | Review | Best For |
|--------|-------------|-------------|--------|----------|
| TestFlight (internal) | 25 testers | 90 days | None | Family use |
| TestFlight (external) | 10,000 | 90 days | Beta review | Wider testing |
| Ad Hoc | 100/year per type | ~1 year (profile) | None | Permanent install |
| Personal team (free) | 3 apps | 7 days | None | Quick testing |
| Direct Xcode | 100 dev devices | ~1 year | None | Development |

**Recommendation: TestFlight internal testing**
- No UDID registration needed (family installs via TestFlight app)
- 25 internal testers is more than enough for family of 5 + guests
- No beta review for internal testers
- $99/year Apple Developer Program required (already needed for any distribution)
- 90-day build expiry manageable with monthly CI uploads (Fastlane or Xcode Cloud)
- **Background audio capabilities identical across all distribution methods** — restrictions are OS-level

### Network Reconnection

Same strategy as Android client (exponential backoff with full jitter), adapted for iOS:

#### Network Change Detection
Use `NWPathMonitor` (Network framework, iOS 12+):
```swift
let monitor = NWPathMonitor()
monitor.pathUpdateHandler = { path in
    if path.status == .satisfied {
        // Network available — reconnect if needed
    } else {
        // Network lost — update UI, stop streaming
    }
    // Check path.usesInterfaceType(.wifi) vs .cellular for transport changes
}
monitor.start(queue: .global())
```

When transport changes (WiFi → cellular), proactively close and reopen WebSocket — the underlying TCP connection is broken even if `NWPathMonitor` doesn't report `unsatisfied`.

#### Session Resumption
Same protocol as Android:
- Server assigns `session_id` on first connect
- Client stores `session_id` + `last_seq`
- On reconnect, send as query params
- Server replays missed events or sends `session_expired` (2-5 min timeout)

### App Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  VoiceAssistantApp (SwiftUI)                    │
│  ┌─────────────────────────────────────────────┐│
│  │ ConversationViewModel (@Observable)         ││
│  │  - messages, voiceState, connectionState    ││
│  │  - handleToolConfirm/Deny                   ││
│  └──────────────┬──────────────────────────────┘│
│                 │                                │
│  ┌──────────────┴──────────────────────────────┐│
│  │ WebSocketManager (actor)                    ││
│  │  - URLSessionWebSocketTask                  ││
│  │  - Send binary (audio) / text (JSON control)││
│  │  - Receive events → AsyncStream             ││
│  │  - Reconnection with exponential backoff    ││
│  └──────────────┬──────────────────────────────┘│
│                 │                                │
│  ┌──────────────┴──────────────────────────────┐│
│  │ AudioPipeline (actor)                       ││
│  │  ┌─────────────────────────────────────┐    ││
│  │  │ AVAudioEngine + inputNode tap       │    ││
│  │  │  - 16kHz mono 16-bit PCM            │    ││
│  │  │  - Accumulate → 512-sample frames   │    ││
│  │  │  → Porcupine.process() per frame    │    ││
│  │  │  → TPCircularBuffer.write()         │    ││
│  │  │  → On detection: drain + stream     │    ││
│  │  └─────────────────────────────────────┘    ││
│  │  ┌─────────────────────────────────────┐    ││
│  │  │ TTS Playback (AVAudioPlayerNode)    │    ││
│  │  │  - Stream decoded PCM from gateway  │    ││
│  │  │  - Barge-in: stop on new detection  │    ││
│  │  └─────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────┘│
│                                                  │
│  ┌─────────────────────────────────────────────┐│
│  │ NetworkMonitor (NWPathMonitor)              ││
│  │  - WiFi↔cellular detection                 ││
│  │  - Proactive reconnect on transport change  ││
│  └─────────────────────────────────────────────┘│
└──────────────────────────────────────────────────┘
```

### TTS Audio Playback

Two options:

1. **AVAudioPlayerNode** (within AVAudioEngine): Schedule buffers for playback as they arrive from gateway. Low-latency streaming. Shares the same AVAudioEngine instance as input — simplifies audio session management. Supports barge-in via `stop()`.

2. **AVAudioPlayer**: Higher-level, but requires complete audio data (not streaming-friendly). Not suitable.

**Recommendation**: `AVAudioPlayerNode` attached to the same `AVAudioEngine` used for capture. Schedule decoded PCM buffers as they arrive from gateway. On barge-in (new wake word while TTS is playing), call `stop()`, send `barge_in` control message, drain ring buffer, start new session.

### iOS-Specific Considerations vs Android

| Aspect | iOS | Android |
|--------|-----|---------|
| Audio capture | AVAudioEngine + installTap | AudioRecord + dedicated thread |
| Ring buffer | TPCircularBuffer (VM-mapped) | Simple ByteArray (trivial at 64KB) |
| Background mic | **Not supported** (foreground only) | Foreground service with persistent notification |
| Wake word background | Only when foregrounded | Always-on via foreground service |
| Mic indicator | Orange dot (always visible) | Green dot (Android 12+) |
| Distribution | TestFlight 90-day builds | APK sideload |
| WebSocket | URLSessionWebSocketTask | OkHttp WebSocket |
| State management | @Observable + actors | ViewModel + StateFlow |
| Network monitor | NWPathMonitor | ConnectivityManager.NetworkCallback |
| Audio DSP offload | Reserved for Siri only | Available via SoundTrigger HAL (system apps only) |

**The fundamental iOS limitation**: no background wake word detection for third-party apps. This means the iOS client is a **foreground-first voice assistant** that degrades to PTT when backgrounded. On a dedicated iPad, this is fine. On a personal phone, it's a UX compromise that the architecture must accept.

## Approaches

### Approach A: URLSession + AVAudioEngine + Porcupine + Raw PCM (Simple)

**Description**: Straightforward architecture using all Apple-native APIs plus Porcupine for wake word. Raw PCM over WebSocket. Minimal external dependencies.

**Stack**:
- URLSessionWebSocketTask for WebSocket
- AVAudioEngine with input tap for capture
- Porcupine iOS SDK (SPM) for wake word
- TPCircularBuffer for pre-trigger audio
- Raw PCM 16-bit 16kHz mono over WebSocket
- AVAudioPlayerNode for TTS playback
- SwiftUI + @Observable for UI (iOS 17+)

**Pros**:
- Minimal dependencies — only Porcupine and TPCircularBuffer are external
- All Apple-native APIs — best platform integration
- Native async/await throughout (URLSessionWebSocketTask, Swift concurrency)
- Easy to debug audio pipeline (PCM is inspectable)
- Fastest time to working prototype
- Actors provide clean thread safety model

**Cons**:
- 256kbps bandwidth on cellular is wasteful
- No FEC — packet loss = audio gaps
- iOS 17+ required for @Observable (fallback to ObservableObject for iOS 16)
- May need Opus later for cellular

**Best for**: Prototyping, WiFi-primary home use

### Approach B: URLSession + AVAudioEngine + Porcupine + Opus (Production)

**Description**: Same as Approach A but with Opus encoding via libopus C interop. Suitable for production use on both WiFi and cellular.

**Stack**:
- URLSessionWebSocketTask for WebSocket
- AVAudioEngine with input tap
- Porcupine iOS SDK for wake word
- TPCircularBuffer for pre-trigger audio
- libopus via C interop (Swift can call C directly)
- Opus 24kbps, 20ms frames
- AVAudioPlayerNode + Opus decoder for TTS playback
- SwiftUI + @Observable for UI

**Pros**:
- 10x bandwidth reduction (24kbps vs 256kbps)
- Forward error correction for packet loss
- Works well on cellular networks
- Swift-C interop is straightforward — no bridging header complexity with SPM
- Same dependencies as Approach A plus libopus source

**Cons**:
- Must build libopus from source in Xcode (or use a pre-built xcframework)
- Additional codec complexity (encode on send, decode on receive)
- Must handle Opus frame boundaries correctly (20ms frames)
- Slightly more battery from encoding (minimal at voice rates)

**Best for**: Production deployment, mixed WiFi/cellular usage

### Approach C: Starscream + AVAudioEngine + Porcupine + Background Audio (Full-Featured)

**Description**: Uses Starscream for WebSocket (built-in reconnection, ping/pong), adds silent-audio background workaround for always-on wake word when backgrounded.

**Stack**:
- Starscream 4.x for WebSocket (built-in reconnect, compression)
- AVAudioEngine with input tap
- Porcupine iOS SDK for wake word
- TPCircularBuffer + silent audio playback for background mode
- Opus via libopus
- SwiftUI + @Observable for UI

**Pros**:
- Starscream's built-in reconnection simplifies network handling
- Silent audio workaround enables background wake word (for personal distribution)
- permessage-deflate compression for text frames
- Most feature-complete option

**Cons**:
- Third-party WebSocket dependency
- Starscream lacks async/await — requires wrapper
- Silent audio workaround is a hack that may break across iOS updates
- More complex audio session management (simultaneous playback + recording + silent audio)
- Apple could further restrict background audio in future iOS versions
- Battery drain increases with continuous background operation

**Best for**: If always-on background wake word is a hard requirement and reliability risk is accepted

## Recommended Progression

1. **Start with Approach A** (Raw PCM) for rapid prototyping and end-to-end validation
2. **Evolve to Approach B** (Opus) once the pipeline works and cellular use is needed
3. **Optionally add background audio** from Approach C as an experimental opt-in setting — but design the core UX around foreground-first
4. **Skip Starscream** — URLSessionWebSocketTask with manual reconnection is simpler and sufficient

## Decomposition

### Sub-Area 1: Audio Pipeline

The iOS audio pipeline mirrors the Android pipeline's architecture but uses platform-specific APIs. Core components:

#### AVAudioEngine + installTap (Capture)

Already detailed in Findings. Key design decisions:

- **Format**: Request `pcmFormatInt16` at 16kHz mono. Fallback: capture as `pcmFormatFloat32` at 16kHz mono and convert (`sample * 32767`).
- **Buffer size hint**: 512 — but iOS may deliver variable sizes. Must accumulate.
- **Route change handling**: Stop engine → remove tap → reinstall tap → restart. This is the #1 crash source in iOS audio apps.

#### TPCircularBuffer (Ring Buffer)

**SPM Integration Strategy** (see Sub-Area 3 for details):
- 64,000 bytes capacity (2 seconds at 16kHz/16-bit/mono)
- Lock-free SPSC: producer = audio tap thread, consumer = actor (drains on wake word)
- VM-mapped trick eliminates wrap-around arithmetic

#### Porcupine Frame Accumulator

Must run on the real-time audio thread. **Production implementation** uses pre-allocated fixed-size buffer (NOT dynamic Array):

```swift
// Pre-allocated accumulator — no allocations on audio thread
final class FrameAccumulator {
    private let frameSize: Int          // 512 for Porcupine
    private let buffer: UnsafeMutableBufferPointer<Int16>
    private var writeIndex: Int = 0
    
    init(frameSize: Int) {
        self.frameSize = frameSize
        self.buffer = .allocate(capacity: frameSize * 2)  // 2x headroom
    }
    
    /// Feed samples from audio tap. Calls onFrame for each complete 512-sample frame.
    /// MUST be called from a single thread (audio thread).
    func feed(_ samples: UnsafeBufferPointer<Int16>, onFrame: (UnsafeBufferPointer<Int16>) -> Void) {
        var readIndex = 0
        while readIndex < samples.count {
            let remaining = frameSize - writeIndex
            let available = samples.count - readIndex
            let toCopy = min(remaining, available)
            
            for i in 0..<toCopy {
                buffer[writeIndex + i] = samples[readIndex + i]
            }
            writeIndex += toCopy
            readIndex += toCopy
            
            if writeIndex == frameSize {
                onFrame(UnsafeBufferPointer(start: buffer.baseAddress, count: frameSize))
                writeIndex = 0
            }
        }
    }
    
    deinit { buffer.deallocate() }
}
```

**Why `UnsafeMutableBufferPointer` over `[Int16]`**: Swift Array's `append`/`removeFirst` can trigger COW copies and heap allocations. `UnsafeMutableBufferPointer` with manual index is allocation-free — required for real-time audio thread safety.

#### Pipeline State Machine

Same lifecycle as Android (validated in PoC 115/115), adapted for iOS:

```
IDLE ──(wake word detected)──→ DRAINING ──(buffer sent)──→ STREAMING ──(silence/audio.end)──→ IDLE
                                                              │
                                                    (barge-in detected)
                                                              │
                                                              v
                                                         Stop TTS → send barge_in → DRAINING
```

- **Debounce**: 500ms after detection before accepting another (prevents double-trigger)
- **Pre-trigger cap**: max 2000ms / 64,000 bytes
- **Barge-in**: Stop `AVAudioPlayerNode`, send `barge_in` control message, drain ring buffer, start new session

#### Production Mapping (Exploration Concepts → Swift Implementation)

| Concept | Swift Implementation |
|---------|---------------------|
| Ring buffer | `TPCircularBuffer` (C, via local SPM package) |
| Frame accumulator | `FrameAccumulator` (UnsafeMutableBufferPointer, pre-allocated) |
| Audio capture | `AVAudioEngine.inputNode.installTap()` on real-time thread |
| Wake word | `Porcupine` SDK (SPM: `PvPorcupine`) |
| Pipeline state | `AudioPipeline` actor with `AsyncStream<AudioEvent>` bridge |
| TTS playback | `AVAudioPlayerNode` on same `AVAudioEngine` instance |
| WebSocket | `URLSessionWebSocketTask` with async/await |

### Sub-Area 2: TPCircularBuffer SPM Integration

TPCircularBuffer is a 2-file C library (`TPCircularBuffer.c` + `TPCircularBuffer.h`). It has no official Swift Package. Integration options:

#### Option A: Local Package (Recommended)

Create a local Swift package within the Xcode project:

```
VoiceAssistant/
├── VoiceAssistant.xcodeproj
├── Packages/
│   └── TPCircularBuffer/
│       ├── Package.swift
│       ├── Sources/
│       │   └── TPCircularBuffer/
│       │       ├── include/
│       │       │   └── TPCircularBuffer.h
│       │       ├── TPCircularBuffer.c
│       │       └── TPCircularBuffer+Swift.swift   # Swift convenience wrapper
│       └── Tests/
│           └── TPCircularBufferTests/
│               └── TPCircularBufferTests.swift
└── Sources/
    └── ...
```

**Package.swift**:
```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TPCircularBuffer",
    products: [.library(name: "TPCircularBuffer", targets: ["TPCircularBuffer"])],
    targets: [
        .target(
            name: "TPCircularBuffer",
            path: "Sources/TPCircularBuffer",
            publicHeadersPath: "include",
            cSettings: [.headerSearchPath("include")]
        ),
        .testTarget(name: "TPCircularBufferTests", dependencies: ["TPCircularBuffer"])
    ]
)
```

**Swift convenience wrapper** (`TPCircularBuffer+Swift.swift`):
```swift
import Foundation

public final class CircularAudioBuffer {
    private var buffer = TPCircularBuffer()
    
    public init(capacity: UInt32) {
        _TPCircularBufferInit(&buffer, capacity, MemoryLayout<TPCircularBuffer>.size)
    }
    
    /// Write bytes. Safe to call from real-time audio thread (lock-free).
    public func produce(_ data: UnsafeRawPointer, count: UInt32) -> Bool {
        TPCircularBufferProduceBytes(&buffer, data, count)
    }
    
    /// Read all available bytes (contiguous thanks to VM mapping). Returns Data.
    /// NOT for real-time thread — allocates Data.
    public func drainAll() -> Data {
        var availableBytes: UInt32 = 0
        guard let tail = TPCircularBufferTail(&buffer, &availableBytes),
              availableBytes > 0 else {
            return Data()
        }
        let data = Data(bytes: tail, count: Int(availableBytes))
        TPCircularBufferConsume(&buffer, availableBytes)
        return data
    }
    
    /// Available bytes without consuming.
    public var availableBytes: UInt32 {
        var available: UInt32 = 0
        _ = TPCircularBufferTail(&buffer, &available)
        return available
    }
    
    public func clear() {
        TPCircularBufferClear(&buffer)
    }
    
    deinit {
        TPCircularBufferCleanup(&buffer)
    }
}
```

**Pros**: Version-controlled, testable, no network dependency, clean Swift API.
**Cons**: Must manually update if upstream changes (upstream is stable — last meaningful change was years ago).

#### Option B: Community SPM Fork

Several community forks provide SPM manifests (e.g., `nicklama/TPCircularBuffer`). Risk: unmaintained forks, version drift, potential build issues with newer Xcode.

**Verdict**: Option A (local package). TPCircularBuffer is 2 files and essentially frozen. Wrapping it locally is trivial and avoids dependency risk.

#### Option C: Drop-In Source Files

Add `TPCircularBuffer.c` and `TPCircularBuffer.h` directly to the Xcode project (no package). Simplest, but loses testability isolation and package boundary.

**Verdict**: Use Option A for clean architecture, fall back to Option C for quick prototyping.

### Sub-Area 3: Auth Token Keychain Storage

iOS Keychain is the correct storage for PASETO tokens — hardware-encrypted on devices with Secure Enclave, persists across app updates and reinstalls (unless explicitly deleted).

#### Implementation

```swift
import Security

actor TokenStore {
    private let service = "com.family.voiceassistant"
    
    func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        
        // Delete existing first (SecItemUpdate is unreliable across OS versions)
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "paseto_token"
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "paseto_token",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }
    
    func getToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "paseto_token",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    
    func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "paseto_token"
        ]
        SecItemDelete(query as CFDictionary)
    }
    
    func hasToken() -> Bool { getToken() != nil }
    
    enum KeychainError: Error {
        case saveFailed(OSStatus)
    }
}
```

**Key decisions:**
- **`kSecAttrAccessibleAfterFirstUnlock`**: Token available whenever device has been unlocked at least once since boot. Allows background access (if service running) without requiring device to be currently unlocked. More permissive than `kSecAttrAccessibleWhenUnlocked` but still encrypted at rest.
- **Actor isolation**: Keychain operations are thread-safe (Security framework handles locking), but wrapping in an actor keeps the Swift concurrency model consistent — all state access serialized.
- **Delete-then-add pattern**: `SecItemUpdate` has historically been buggy across iOS versions. Delete + add is more reliable for overwrite.
- **No biometric protection**: Family tokens are long-lived and need to be accessible without FaceID/TouchID prompt on every WebSocket reconnect. Biometric lock would be appropriate for admin-level operations (token generation, user management).

**Token lifecycle on iOS:**
- **Family member**: Token saved on first auth (QR scan or manual entry). Persists across app restarts and updates. Keychain survives app deletion only if `kSecAttrAccessGroup` is set with a shared group — for this project, token should be deleted on uninstall (default behavior without shared group).
- **Guest**: Token held in-memory only (`var guestToken: String?` on the actor, never written to Keychain). Discarded when app closes or session ends. Guest tokens have 4-hour TTL, no refresh.

**First-run auth flow** (mirrors Android):
1. App launches → `TokenStore.hasToken()` returns false
2. Show onboarding: enter gateway address (Bonjour/mDNS discovery or manual IP)
3. Admin generates token: `./gateway token create --user kevin --role adult`
4. Display QR on admin device → user scans with camera → token extracted → `TokenStore.saveToken()`
5. WebSocket connects with token → `auth.ok` → main UI

### Sub-Area 4: AsyncStream Backpressure Handling

The bridge between the real-time audio thread and the Swift concurrency world is `AsyncStream`. Backpressure handling is critical — if the consumer (actor/WebSocket) can't keep up, the audio thread must not block.

#### The Problem

```swift
// Naive approach — continuation.yield() can exert backpressure
let stream = AsyncStream<AudioEvent> { continuation in
    inputNode.installTap(...) { buffer, _ in
        continuation.yield(.audioFrame(buffer))  // What if consumer is slow?
    }
}
```

`AsyncStream.Continuation.yield()` is non-blocking and thread-safe, BUT the internal buffer grows unboundedly if the consumer is slow. In practice, this is fine for short voice sessions (5-30 seconds of audio), but a stuck consumer could accumulate memory.

#### Solution: Bounded Buffer with Drop Policy

```swift
let (stream, continuation) = AsyncStream<AudioEvent>.makeStream(
    of: AudioEvent.self,
    bufferingPolicy: .bufferingNewest(64)  // Keep latest 64 events, drop oldest
)

// Audio thread produces:
inputNode.installTap(...) { buffer, _ in
    let result = continuation.yield(.audioFrame(processedData))
    // result is .enqueued, .dropped, or .terminated — never blocks
}

// Actor consumes:
actor AudioPipeline {
    func startProcessing() async {
        for await event in stream {
            switch event {
            case .wakeWord(let preTriggerData):
                await webSocket.sendSessionStart(preTriggerData: preTriggerData)
            case .audioFrame(let data):
                await webSocket.sendBinary(data)
            case .silenceDetected:
                await webSocket.sendAudioEnd()
            }
        }
    }
}
```

**Why `.bufferingNewest(64)`:**
- At 16kHz/16-bit/mono, audio tap fires ~31x/sec (512-sample frames). 64 events = ~2 seconds of buffer.
- If consumer falls behind by >2 seconds, oldest frames are silently dropped — acceptable because STT can handle gaps better than latency accumulation.
- 64 events × ~1KB per event = ~64KB max memory — negligible.
- `.bufferingOldest` would preserve order but create growing latency — worse for real-time audio.

#### Event Types

```swift
enum AudioEvent: Sendable {
    case wakeWord(preTriggerData: Data)     // Ring buffer drain
    case audioFrame(Data)                    // Live PCM frame
    case silenceDetected                     // VAD end-of-speech
    case bargeIn                             // Wake word during TTS
}
```

All cases carry `Sendable` data (`Data` is `Sendable`). No reference types cross the thread boundary.

#### Alternative: Custom Channel (Not Recommended)

Could build a custom lock-free ring buffer for events (like Android's `Channel<AudioEvent>`). Unnecessary — `AsyncStream` with bounded buffering policy is the idiomatic Swift solution and is well-tested in the runtime. Only consider a custom channel if profiling shows `AsyncStream` overhead is measurable (unlikely).

#### Timing Considerations

The audio tap callback and AsyncStream consumer run at different cadences:
- **Producer**: Fires every ~32ms (hardware-driven, jittery ±5ms)
- **Consumer**: Processes as fast as `await webSocket.sendBinary()` allows (~1-5ms on WiFi)

Under normal conditions, the consumer is faster than the producer — no backpressure. Backpressure occurs during:
1. **WebSocket reconnection**: Consumer blocks on reconnect. Buffered events accumulate. After 2 seconds, oldest frames drop. On reconnect, consumer resumes with latest audio — acceptable gap.
2. **Network congestion**: `sendBinary` takes longer. Same behavior as #1.
3. **App suspension (iOS)**: Audio engine stops → no production. On resume, engine restarts fresh.

### Sub-Area 5: Test Strategy

#### Unit Tests (XCTest — run on macOS, no simulator)

| Component | Tests | Notes |
|-----------|-------|-------|
| `CircularAudioBuffer` (TPCircularBuffer wrapper) | 9 tests from wake-word decomposition matrix (capacity, wrap, drain, byte order, empty drain, double drain) | C library + Swift wrapper, runs on macOS |
| `FrameAccumulator` | Variable buffer sizes → exact 512-sample frames, partial buffering, empty input, large input (>1024 samples) | Pure Swift, UnsafeMutableBufferPointer, no framework dependency |
| `TokenStore` | Save/get/delete/has token | Requires Keychain entitlement — run as XCTest on macOS or simulator |
| `MessageSerializer` | JSON control message encode/decode, all protocol message types | Pure Swift, Codable |
| `ReconnectionStrategy` | Exponential backoff timing, jitter bounds, max cap, attempt counter reset | Pure Swift |
| `AudioEventMapper` | Wake word event → wire protocol messages (session.start + binary + audio.end) | Pure Swift |

#### Mock AVAudioEngine Strategy

AVAudioEngine cannot be easily mocked (concrete class, no protocol). Strategy:

1. **Protocol extraction**: Define `AudioCaptureProvider` protocol:
```swift
protocol AudioCaptureProvider {
    func installTap(bufferSize: UInt32, format: AVAudioFormat, block: @escaping (AVAudioPCMBuffer, AVAudioTime) -> Void)
    func removeTap()
    func start() throws
    func stop()
    var inputFormat: AVAudioFormat { get }
}
```

2. **Production conformance**: `AVAudioEngine` extension conforms (thin wrapper over `inputNode.installTap`, etc.)

3. **Test conformance**: `MockAudioCaptureProvider` that:
   - Accepts pre-recorded PCM data (loaded from test fixture `.pcm` files)
   - Delivers buffers on a test scheduler at configurable intervals
   - Simulates variable buffer sizes (128, 256, 512, 1024 samples)
   - Simulates route changes (call block with different format)
   - Simulates interruptions (stop delivering buffers, then resume)

4. **Test fixture audio**: Short `.pcm` files (16kHz/16-bit/mono):
   - `silence_1s.pcm` — 32,000 bytes of zeros
   - `speech_2s.pcm` — 2 seconds of recorded speech
   - `wake_word.pcm` — recording of the wake word for Porcupine integration tests

#### Integration Tests (XCTest — run on simulator or device)

| Component | Tests | Notes |
|-----------|-------|-------|
| `AudioPipeline` (actor) | Start → mock audio → wake word → drain → stream → silence lifecycle | Uses `MockAudioCaptureProvider` + mock `Porcupine` |
| `AVAudioSession` configuration | Category set to `.playAndRecord`, mode `.voiceChat`, options correct | Simulator (no real mic) |
| Interruption handling | Simulate interruption notification → engine stops → resume notification → engine restarts | Post `AVAudioSession.interruptionNotification` |
| Route change | Simulate route change → tap reinstalled with new format | Post `AVAudioSession.routeChangeNotification` |
| `WebSocketManager` + pipeline | Mock URLSession → auth handshake → send binary → receive transcript | `URLProtocol` mock or local test server |
| `NWPathMonitor` reconnection | Simulate network loss → reconnect attempt → backoff timing | Mock `NWPathMonitor` via protocol |

#### Mock Porcupine Strategy

Porcupine SDK exposes `Porcupine` class with `process(_ pcm: [Int16]) -> Int32`. Extract a protocol:

```swift
protocol WakeWordDetector {
    func process(_ pcm: [Int16]) throws -> Int32   // >= 0 means detected
    func delete()                                   // cleanup
}

extension Porcupine: WakeWordDetector {}

class MockWakeWordDetector: WakeWordDetector {
    var triggerOnFrameIndex: Int? = nil
    private var frameCount = 0
    
    func process(_ pcm: [Int16]) throws -> Int32 {
        defer { frameCount += 1 }
        return frameCount == triggerOnFrameIndex ? 0 : -1
    }
    
    func delete() {}
}
```

#### UI Tests (XCTest UI / SwiftUI Preview Tests)

| Screen | Tests |
|--------|-------|
| Conversation view | Messages render in LazyVStack, auto-scroll on new message, streaming text updates last bubble |
| Voice indicator | Correct visual state for idle/listening/processing/speaking |
| Tool confirmation | Sheet appears with tool details, Allow/Deny buttons trigger correct callbacks |
| Connection status | Toolbar shows correct icon for connected/reconnecting/disconnected |
| Onboarding | Gateway address entry → QR scan → token saved → navigate to conversation |

#### End-to-End Tests

| Scenario | Setup | Assertion |
|----------|-------|-----------|
| Full voice pipeline | Test audio fixture → mock capture → mock Porcupine → mock WebSocket | Correct wire messages: session.start, pre-trigger binary, live frames, audio.end |
| Barge-in | AVAudioPlayerNode playing + wake word detected | Playback stops, barge_in sent, new session starts |
| Reconnection | Mock server drops WebSocket | Client reconnects with session_id + last_seq |
| Route change recovery | Simulate Bluetooth disconnect during streaming | Engine restarts, tap reinstalled, streaming resumes |
| Interruption recovery | Simulate phone call during listening | Engine pauses, UI updates, engine restarts after call |

### Sub-Area 6: Opus/Porcupine Frame Mismatch (RESOLVED)

Same resolution as Android (resolved in wake-word-audio-buffering decomposition). Independent consumers of the same PCM stream:
- Porcupine accumulator: 512 samples (32ms) → `porcupine.process()`
- Opus encoder accumulator: 320 samples (20ms) → `OpusEncoder.encode()` (when added)
- TPCircularBuffer: continuous raw PCM, frame-boundary-agnostic

On iOS, both accumulators are `FrameAccumulator` instances with different `frameSize` parameters, both called sequentially in the `installTap` callback on the same real-time audio thread.

### Package Structure

```
VoiceAssistant/
├── VoiceAssistant.xcodeproj
├── Packages/
│   └── TPCircularBuffer/              # Local SPM package (Sub-Area 2)
│       ├── Package.swift
│       ├── Sources/TPCircularBuffer/
│       │   ├── include/TPCircularBuffer.h
│       │   ├── TPCircularBuffer.c
│       │   └── CircularAudioBuffer.swift     # Swift wrapper
│       └── Tests/TPCircularBufferTests/
│           └── CircularAudioBufferTests.swift
├── Sources/
│   ├── App/
│   │   └── VoiceAssistantApp.swift
│   ├── Audio/
│   │   ├── AudioPipeline.swift              # Actor: orchestrates capture + wake word + streaming
│   │   ├── AudioCaptureProvider.swift        # Protocol for AVAudioEngine abstraction
│   │   ├── AVAudioEngineCaptureProvider.swift # Production implementation
│   │   ├── FrameAccumulator.swift           # Pre-allocated 512-sample accumulator
│   │   ├── AudioEvent.swift                 # enum: wakeWord, audioFrame, silenceDetected, bargeIn
│   │   ├── TTSPlayer.swift                  # AVAudioPlayerNode streaming playback
│   │   └── AudioSessionManager.swift        # AVAudioSession config, interruption, route changes
│   ├── WakeWord/
│   │   ├── WakeWordDetector.swift           # Protocol
│   │   └── PorcupineDetector.swift          # Porcupine SDK conformance
│   ├── Network/
│   │   ├── WebSocketManager.swift           # Actor: URLSessionWebSocketTask, send/receive
│   │   ├── MessageSerializer.swift          # JSON ↔ control messages (Codable)
│   │   ├── ReconnectionStrategy.swift       # Exp backoff + jitter
│   │   └── NetworkMonitor.swift             # NWPathMonitor wrapper
│   ├── Auth/
│   │   └── TokenStore.swift                 # Keychain PASETO storage (actor)
│   ├── Model/
│   │   ├── Message.swift                    # Conversation message
│   │   ├── ConnectionState.swift            # Connected/Reconnecting/Disconnected
│   │   ├── VoiceState.swift                 # Idle/Listening/Processing/Speaking
│   │   └── ControlMessage.swift             # Codable protocol message types
│   └── UI/
│       ├── ConversationView.swift
│       ├── ConversationViewModel.swift      # @Observable
│       ├── OnboardingView.swift
│       ├── SettingsView.swift
│       └── Components/
│           ├── MessageBubbleView.swift
│           ├── VoiceIndicatorView.swift
│           ├── ToolConfirmationSheet.swift
│           └── ConnectionStatusView.swift
├── Tests/
│   ├── UnitTests/
│   │   ├── FrameAccumulatorTests.swift
│   │   ├── TokenStoreTests.swift
│   │   ├── MessageSerializerTests.swift
│   │   ├── ReconnectionStrategyTests.swift
│   │   └── AudioEventMapperTests.swift
│   ├── IntegrationTests/
│   │   ├── AudioPipelineTests.swift
│   │   ├── AudioSessionTests.swift
│   │   ├── WebSocketManagerTests.swift
│   │   └── InterruptionHandlingTests.swift
│   └── UITests/
│       ├── ConversationViewTests.swift
│       └── OnboardingFlowTests.swift
└── Resources/
    ├── wake_word.ppn                        # Porcupine custom wake word model
    └── TestFixtures/
        ├── silence_1s.pcm
        ├── speech_2s.pcm
        └── wake_word_audio.pcm
```

## Open Questions

1. **TTS audio format from gateway**: Does gateway relay Opus directly from Fish Audio, or decode to PCM? Determines whether iOS client needs Opus decoder for playback.
2. **iOS 17 minimum or iOS 16 support?**: @Observable requires iOS 17. Falling back to ObservableObject for iOS 16 adds boilerplate but widens device support. All family devices likely on iOS 17+ already.
3. **Guided Access for dedicated iPad**: Lock the device to the assistant app, preventing backgrounding. Needs testing for audio interruption behavior (phone calls still interrupt even in Guided Access).
4. **Auth token storage**: Keychain for PASETO tokens (persistent family tokens). Keychain is the correct choice — encrypted at rest, persists across app updates.
5. **Guest mode on iOS**: How does a guest authenticate? Scan QR code displayed by a family member's device? Enter PIN? Web client may be simpler for guests.
6. **Siri Shortcuts integration**: Could expose a Siri Shortcut to activate the app's mic (brings app to foreground). "Hey Siri, open Alice" → app foregrounds → wake word active. Partial workaround for background limitation.
7. **CarPlay integration**: Similar to Android Auto — voice assistant in car. Worth exploring later.
8. **VoiceOver/accessibility**: Ensure accessibility in SwiftUI. Voice-only mode for visually impaired users — the app is already voice-first.
