# Android Client — Kotlin + Jetpack Compose

## Decision Area
Native Android client with wake word, continuous recording, and voice UI.

## Key Questions
- Audio capture: `AudioRecord` API with circular buffer via Kotlin coroutines?
- Foreground service: persistent notification for always-on mic (Android requirement)?
- Wake word: Porcupine Android SDK integration within foreground service?
- WebSocket client: OkHttp vs Ktor for WebSocket to gateway?
- Audio codec: Opus encoding on-device or raw PCM passthrough?
- UI: Compose conversation view, voice activity indicator, tool confirmation dialogs?
- Battery optimization: keep always-on mic without excessive drain?
- Android 14+ permissions: microphone, foreground service type declarations?
- Reconnection: session resumption on network changes, WiFi<->cellular handoff?
- Background restrictions: Android 14+ limitations on background audio?

## Prior Research
- Kotlin + Jetpack Compose is a hard constraint
- Porcupine Android SDK is the specified wake word solution
- Wake word exploration (wake-word-audio-buffering.md) established: Porcupine v4.0.2, 16kHz/mono/16-bit PCM, 512-sample frames, 2-second ring buffer (64KB), foreground service with `microphone` type required
- Client-gateway protocol exploration pending but WebSocket-only with binary audio frames + JSON control is established

## Findings

### Audio Capture Pipeline

#### AudioRecord Configuration
```
AudioSource: VOICE_RECOGNITION (not MIC)
Sample rate: 16000 Hz
Channel: CHANNEL_IN_MONO
Encoding: ENCODING_PCM_16BIT
Buffer size: getMinBufferSize() * 4 (avoid overruns; ~160-400ms headroom)
```

**Why VOICE_RECOGNITION over MIC:**
- AGC disabled by spec — predictable signal levels for VAD and Opus encoding
- No OEM noise suppression — avoids double-processing if STT does its own
- Android CDD requires "near-flat amplitude vs frequency" response — consistent across devices
- If preprocessing desired, Android 12+ allows attaching `AudioEffect` explicitly

#### Threading Model: Dedicated Thread, Not Coroutine Dispatcher
`AudioRecord.read()` is a blocking JNI call. Running on `Dispatchers.IO` ties up the shared pool. Use a dedicated thread with `THREAD_PRIORITY_URGENT_AUDIO`:

```kotlin
class AudioCaptureThread(
    private val audioRecord: AudioRecord,
    private val onAudioData: (ByteArray, Int) -> Unit
) : Thread("AudioCapture") {
    @Volatile private var isRecording = true

    init { priority = Thread.MAX_PRIORITY }

    override fun run() {
        android.os.Process.setThreadPriority(
            android.os.Process.THREAD_PRIORITY_URGENT_AUDIO
        )
        val buffer = ByteArray(1024) // 512 samples * 2 bytes = 32ms at 16kHz
        audioRecord.startRecording()
        while (isRecording) {
            val bytesRead = audioRecord.read(buffer, 0, buffer.size)
            if (bytesRead > 0) onAudioData(buffer, bytesRead)
        }
        audioRecord.stop()
    }

    fun stopRecording() { isRecording = false }
}
```

Bridge to coroutines via `Channel<ByteArray>` for downstream processing (WebSocket send, Opus encode).

#### Ring Buffer for Pre-Trigger Audio
Simple `ByteArray`-based circular buffer, 64KB (2 seconds at 16kHz/16-bit/mono). Synchronized for thread safety between audio capture thread and WebSocket send coroutine. On wake word detection: drain buffer as pre-trigger audio, send over WebSocket, then continue forwarding live frames.

### Android 14/15 Foreground Service Requirements

#### Manifest Declaration
```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />

<service
    android:name=".VoiceAssistantService"
    android:foregroundServiceType="microphone"
    android:exported="false" />
```

Must specify type at `startForeground()` time:
```kotlin
ServiceCompat.startForeground(
    this, NOTIFICATION_ID, notification,
    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
)
```

#### Key Restrictions
- **Cannot start from background** on Android 12+. Must start from a visible Activity, high-priority FCM push (~10s window), or overlay permission.
- **No time limit** on microphone foreground services (unlike `mediaProcessing` which caps at 6 hours).
- **Continues recording when app backgrounded** — this is the intended behavior. Persistent notification tells user mic is active.
- **Android 12+ shows mic indicator** (green dot) in status bar. Android 14+ shows a chip users can tap to see which app and revoke permission.
- **Boot-start workaround**: Show notification from background service → user taps notification → Activity opens → starts foreground service.

#### Wake Lock
Foreground service alone doesn't prevent CPU sleep during Doze. Need a `PARTIAL_WAKE_LOCK`:
```kotlin
val wakeLock = powerManager.newWakeLock(
    PowerManager.PARTIAL_WAKE_LOCK, "VoiceAssistant::Mic"
)
wakeLock.acquire()
```

**Do NOT request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** — Google Play restricts this. Foreground service + wake lock is sufficient.

### WebSocket Client: OkHttp vs Ktor

| Feature | OkHttp 4.12.x | Ktor 3.1.x |
|---------|---------------|-------------|
| Binary frames | `ws.send(ByteString.of(...))` | `send(Frame.Binary(...))` |
| Coroutine integration | Callback-based (wrap manually) | Native `suspend` + `Flow` |
| Reconnection | Manual | Manual |
| Memory model | `ByteString` immutable (safe cross-thread) | `ByteReadChannel` streaming |
| Size | ~400KB (OkHttp + Okio) | ~2MB (Ktor + CIO engine) |
| Maturity | 10+ years, battle-tested | Stable since 3.x, growing |
| KMP support | No | Yes |

**Recommendation: OkHttp** for this project:
- Lighter footprint, universally understood
- Likely already present if using Retrofit for any REST calls
- `ByteString` immutability is an advantage for passing audio chunks between threads
- Callback wrapping is one-time setup cost
- KMP not needed (iOS is Swift-native, not shared Kotlin)

If KMP were in play for shared networking logic, Ktor would be the choice.

### Audio Codec: Opus vs Raw PCM

| Format | Bitrate (16kHz mono) | Notes |
|--------|---------------------|-------|
| Raw PCM 16-bit | 256 kbps | Simple, no encoding overhead |
| Opus 24kbps | 24 kbps | 10.6x compression, FEC for packet loss |
| Opus 16kbps | 16 kbps | 16x compression, still good for voice |

#### Encoding Options on Android

1. **MediaCodec API** (API 21+): Built-in Opus encoder, but availability not guaranteed on all devices. Outputs raw Opus frames suitable for WebSocket streaming.

2. **libopus JNI** (NDK build): Most reliable. ~200KB per ABI. Used by Signal, Telegram. Full control over frame size, bitrate, complexity.

3. **Concentus** (pure Java): `org.concentus:concentus:1.0.2`. No JNI, simple. 3-5x slower than native libopus — still negligible at 16kHz voice.

4. **Raw PCM passthrough**: No encoding. Fine on WiFi (256kbps is nothing). Problematic on cellular.

**Recommendation**: Start with raw PCM for prototyping. Move to Opus via Concentus (pure Java, simple integration) for v1. If CPU or bandwidth becomes an issue, upgrade to libopus JNI. At 16kHz mono voice, Concentus is adequate — the 3-5x overhead is still microseconds per frame.

### Jetpack Compose UI Architecture

#### State Management: ViewModel + StateFlow
```
VoiceAssistantViewModel
├── messages: StateFlow<List<Message>>      — conversation history
├── connectionState: StateFlow<ConnectionState>  — WS status
├── voiceState: StateFlow<VoiceState>       — IDLE/LISTENING/PROCESSING/SPEAKING
├── audioLevel: StateFlow<Float>            — mic level for UI indicator
└── uiState: StateFlow<AssistantUiState>    — combined derived state
```

Compose collects via `collectAsStateWithLifecycle()` (from `androidx.lifecycle:lifecycle-runtime-compose:2.8.x`) — stops collection when lifecycle drops below STARTED.

#### Key UI Components

1. **ConversationView**: `LazyColumn` with stable `key = { it.id }` for efficient diffing. Auto-scroll via `LaunchedEffect(messages.size)`. For streaming responses, update last message's content via StateFlow — recomposition updates just that bubble.

2. **Voice Activity Indicator**: Pulsing circle animation with `rememberInfiniteTransition`. Audio level drives outer ring size via `animateFloatAsState` with spring physics.

3. **Tool Confirmation**: `ModalBottomSheet` (Material 3) — shows tool name, description, parameters, with Allow/Deny buttons. Non-blocking — user can still see conversation behind the sheet.

4. **Connection Status**: Top bar chip showing connected/reconnecting/disconnected state.

### Battery Impact

| Scenario | Power Draw | Drain/hr (3500mAh) |
|----------|-----------|---------------------|
| AudioRecord 16kHz, screen off | ~30-50 mW | ~1-1.5% |
| + Opus encoding (Concentus) | ~50-80 mW | ~1.5-2.3% |
| + WebSocket streaming (WiFi) | ~80-150 mW | ~2.5-4% |
| + WebSocket streaming (cellular) | ~200-400 mW | ~6-11% |

**Mitigation strategies:**
1. **Don't stream silence**: Use energy-based VAD to detect speech. Only transmit when user is speaking. Reduces network usage 80-90% in typical use.
2. **Batch network sends**: Accumulate 3-5 Opus frames (60-100ms) per WebSocket message. Reduces radio wakeups on cellular.
3. **Context-aware power**: At home on WiFi (primary use case), drain is ~2-4%/hr — very acceptable for a plugged-in or charging device. On cellular, degrade to PTT-only.
4. **OEM battery killers**: Xiaomi, Huawei, Samsung have proprietary battery management that kills foreground services. Guide users to disable via in-app prompt. Reference: dontkillmyapp.com

**Note**: Audio hardware offload via `SoundTrigger` HAL exists on many SoCs but is **not available to third-party apps** — reserved for system voice assistant.

### Network Reconnection

#### Transport Change Detection
Use `ConnectivityManager.NetworkCallback` to detect WiFi<->cellular handoffs via `onCapabilitiesChanged`. When transport changes, the underlying TCP connection is broken even if `onLost` doesn't fire immediately. **Proactively close and reopen WebSocket** on transport change.

#### Reconnection Strategy
- Exponential backoff with full jitter (AWS-recommended pattern)
- Base delay 1s, max 60s, cap exponent at 2^6=64s
- Full jitter: `Random.nextLong(0, calculatedDelay)` — lowest total completion time under contention
- Reset attempt counter on successful connection

#### Session Resumption
- Server assigns `session_id` on first connect
- Client stores `session_id` + `last_seq` (sequence number of last received event)
- On reconnect, client sends `session_id` + `last_seq` as query params
- Server replays missed events or sends `session_expired` if too old (2-5 min timeout)
- Modeled after Discord/Slack WebSocket resumption patterns

### App Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  VoiceAssistantActivity (Compose)               │
│  ┌─────────────────────────────────────────────┐│
│  │ VoiceAssistantViewModel                     ││
│  │  - messages, voiceState, connectionState    ││
│  │  - handleToolConfirm/Deny                   ││
│  └──────────────┬──────────────────────────────┘│
│                 │                                │
│  ┌──────────────┴──────────────────────────────┐│
│  │ WebSocketRepository                         ││
│  │  - OkHttp WebSocket                         ││
│  │  - Send binary (audio) / text (JSON control)││
│  │  - Receive events → SharedFlow              ││
│  │  - Reconnection with backoff                ││
│  └──────────────┬──────────────────────────────┘│
└─────────────────┼────────────────────────────────┘
                  │ binds
┌─────────────────┴────────────────────────────────┐
│  VoiceAssistantService (Foreground, type=mic)    │
│  ┌─────────────────────────────────────────────┐ │
│  │ AudioCaptureThread (URGENT_AUDIO priority)  │ │
│  │  - AudioRecord (VOICE_RECOGNITION, 16kHz)   │ │
│  │  - Read 512-sample frames (32ms)            │ │
│  │  → Porcupine.process() per frame            │ │
│  │  → RingBuffer.write() per frame             │ │
│  │  → On detection: drain buffer + stream live │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ AudioPlaybackManager                        │ │
│  │  - TTS audio playback (AudioTrack or Media3)│ │
│  │  - Barge-in: stop playback on new detection │ │
│  └─────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ NetworkMonitor (ConnectivityManager)         │ │
│  │  - Detect WiFi<->cellular handoffs          │ │
│  │  - Trigger proactive reconnect              │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### TTS Audio Playback

Two options for playing TTS audio received from gateway:

1. **AudioTrack** (low-level): Direct PCM playback. Simple, low-latency. Must decode Opus frames if gateway sends Opus. Good for streaming — write decoded PCM frames as they arrive.

2. **Media3/ExoPlayer**: Higher-level, handles buffering, audio focus, Opus decoding natively. More boilerplate but handles edge cases (audio interruptions, Bluetooth routing). Overkill for simple PCM playback.

**Recommendation**: `AudioTrack` for direct streaming playback. If gateway sends raw PCM TTS audio, this is trivial. If Opus, pair with Concentus decoder or libopus JNI.

**Barge-in**: On new wake word detection while TTS is playing → immediately stop AudioTrack, send `barge_in` control message to gateway, drain ring buffer, start new session.

## Approaches

### Approach A: OkHttp + AudioRecord + Porcupine + Raw PCM (Simple)

**Description**: Straightforward architecture using proven, well-documented libraries. Raw PCM audio over WebSocket. Minimal encoding complexity.

**Stack**:
- OkHttp 4.12.x for WebSocket
- AudioRecord with dedicated thread for capture
- Porcupine Android SDK for wake word
- Raw PCM 16-bit 16kHz mono over WebSocket
- AudioTrack for TTS playback
- Jetpack Compose + Material 3 for UI
- Hilt for DI, ViewModel + StateFlow for state

**Pros**:
- Simplest implementation — no codec libraries needed
- All battle-tested, widely-used libraries
- Easy to debug audio pipeline (PCM is inspectable)
- OkHttp is lightweight (~400KB) and likely already a dependency
- Fastest time to working prototype

**Cons**:
- 256kbps bandwidth on cellular is wasteful (10x what Opus needs)
- No forward error correction — packet loss = audio gaps
- Raw PCM doesn't compress well over WebSocket (no benefit from WS compression for random-looking audio data)
- May need to add Opus later anyway for cellular use

**Best for**: Prototyping, WiFi-primary home use case

### Approach B: OkHttp + AudioRecord + Porcupine + Opus (Production)

**Description**: Same as Approach A but with Opus encoding on-device using Concentus (pure Java) or libopus JNI. Suitable for production use on both WiFi and cellular.

**Stack**:
- OkHttp 4.12.x for WebSocket
- AudioRecord with dedicated thread
- Porcupine Android SDK for wake word
- Concentus 1.0.2 (pure Java Opus) for v1, upgrade path to libopus JNI
- Opus 24kbps, 20ms frames (320 samples at 16kHz)
- AudioTrack + Opus decoder for TTS playback
- Jetpack Compose + Material 3 for UI

**Pros**:
- 10x bandwidth reduction (24kbps vs 256kbps)
- Forward error correction handles packet loss gracefully
- Works well on cellular networks
- Concentus has zero native dependencies — simple Gradle dependency
- Upgrade path to native libopus if performance matters

**Cons**:
- Additional codec complexity (encode on send, decode on receive)
- Concentus is 3-5x slower than native (still negligible for voice)
- Must handle Opus frame boundaries correctly (20ms frames)
- Slightly more battery draw from encoding (minimal)
- Gateway must decode Opus before forwarding to STT (unless STT accepts Opus)

**Best for**: Production deployment, mixed WiFi/cellular usage

### Approach C: Ktor + Oboe (NDK) + Porcupine + Opus (Low-Latency)

**Description**: Kotlin-native networking with Ktor, NDK-based audio capture with Oboe for lowest possible latency, native Opus encoding. Maximum performance at the cost of complexity.

**Stack**:
- Ktor 3.1.x for WebSocket (native coroutine support)
- Google Oboe (C++ via NDK) for audio capture — replaces AudioRecord
- Porcupine Android SDK for wake word
- libopus via JNI for Opus encoding
- Oboe for TTS playback (low-latency path)
- Jetpack Compose + Material 3 for UI

**Pros**:
- Oboe provides lowest possible audio latency (AAudio on API 27+, OpenSL ES fallback)
- Ktor's native coroutine support simplifies async flow
- Full native Opus — maximum encoding efficiency
- KMP-ready if shared networking logic desired later
- Best possible end-to-end latency

**Cons**:
- Significant NDK complexity — C++ build system, JNI bridging
- Oboe is overkill for 16kHz mono capture (AudioRecord is fine at this sample rate)
- Ktor adds ~2MB vs OkHttp's ~400KB
- Harder to debug (native crashes, JNI issues)
- Longer development time for marginal latency gains
- AudioRecord latency at 16kHz is already <20ms — Oboe's advantage is at higher sample rates

**Best for**: If ultra-low latency is critical (it's not — gateway/STT/LLM latency dominates)

## Recommended Progression

1. **Start with Approach A** (Raw PCM) for rapid prototyping and end-to-end validation
2. **Evolve to Approach B** (Opus via Concentus) once the pipeline works
3. **Skip Approach C** unless profiling reveals audio capture latency as a bottleneck (unlikely — STT/LLM latency is 100-1000x larger)

## Decomposition

### Sub-Area 1: Audio Pipeline (VALIDATED)

The audio pipeline has been fully validated in PoC `android-client-audio-pipeline` (115/115 tests pass). This sub-area is concluded.

**Validated components:**
- `RingBuffer`: 64KB capacity, wrap-around correct, drain oldest-first, 0.098μs/write, 8.9μs/fill+drain
- `FrameAccumulator`: Variable input chunks → exact 512-sample Porcupine frames. ByteArray race condition fixed (copy-on-emit).
- `AudioPipeline`: Full detection→drain→stream→silence lifecycle, 500ms debounce, pre-trigger capped at 2000ms/64KB
- Wire protocol: `session.start` + binary pre-trigger + live binary frames + `audio.end` sequence correct

**Production mapping (PoC TypeScript → Android Kotlin):**

| PoC Component | Android Equivalent |
|---------------|-------------------|
| `RingBuffer` (Uint8Array) | `RingBuffer` (ByteArray), same algorithm |
| `FrameAccumulator` | `FrameAccumulator` (ShortArray accumulator for Porcupine Int16 input) |
| `AudioPipeline` | `AudioCaptureThread` + `Channel<AudioEvent>` bridge |
| `MockWakeWordDetector` | `Porcupine` SDK interface (`process(shortArray): Int`) |
| `buildWireMessages()` | `WebSocketRepository.sendSessionStart()` + `send(ByteString)` |

### Sub-Area 2: Service Lifecycle & Binding

**Foreground Service architecture** (from exploration findings, refined):

```
VoiceAssistantActivity (Compose)
    │
    ├── binds → VoiceAssistantService (foreground, type=microphone)
    │              │
    │              ├── AudioCaptureThread (THREAD_PRIORITY_URGENT_AUDIO)
    │              │     - AudioRecord (VOICE_RECOGNITION, 16kHz)
    │              │     - Porcupine.process() per 512-sample frame
    │              │     - RingBuffer.write() continuously
    │              │     - On detection → Channel<AudioEvent>.trySend()
    │              │
    │              ├── AudioPlaybackManager
    │              │     - AudioTrack for TTS PCM streaming
    │              │     - Barge-in: stop() on new detection
    │              │
    │              ├── NetworkMonitor
    │              │     - ConnectivityManager.NetworkCallback
    │              │     - Proactive reconnect on WiFi↔cellular
    │              │
    │              └── PARTIAL_WAKE_LOCK
    │
    └── observes ← WebSocketRepository (OkHttp, SharedFlow<ServerEvent>)
                     - Consumes Channel<AudioEvent> from service
                     - Sends binary frames + JSON control messages
                     - Reconnection with exp backoff + jitter
                     - Session resume via session_id + last_seq
```

**Service binding contract:**

1. **Activity starts service**: `startForegroundService()` from visible activity (Android 12+ requirement)
2. **Service creates notification**: Persistent "Voice Assistant listening" notification with mic icon
3. **Activity binds**: `bindService()` with `BIND_AUTO_CREATE` — gets `VoiceAssistantBinder` with access to:
   - `audioEventFlow: SharedFlow<AudioEvent>` — observe wake word detections, audio state
   - `startListening()` / `stopListening()` — control audio pipeline
   - `isListening: StateFlow<Boolean>` — current recording state
4. **Activity unbinds**: Service continues in foreground (mic stays active)
5. **User dismisses notification**: Service stops, mic released
6. **Activity rebinds**: Re-observes existing flows, no audio pipeline restart needed

**Key lifecycle edge cases:**

| Scenario | Behavior |
|----------|----------|
| App killed by system | Foreground service survives (has notification) |
| User force-stops app | Service destroyed, AudioRecord released, Porcupine deleted |
| Screen off, app in recents | Service running, wake word active, mic indicator visible |
| Configuration change (rotation) | Activity recreated, rebinds to same service instance |
| Boot completed | Cannot auto-start (Android 12+). Show "Tap to start" notification from boot receiver, user taps → activity → starts foreground service |
| OEM battery killer | User must whitelist app. Detect via `PowerManager.isIgnoringBatteryOptimizations()`, show one-time guidance to dontkillmyapp.com instructions |

**Hilt DI graph:**

```kotlin
@Module @InstallIn(SingletonComponent::class)
object AppModule {
    @Provides @Singleton fun provideOkHttpClient(): OkHttpClient
    @Provides @Singleton fun provideTokenStore(@ApplicationContext ctx: Context): TokenStore
    @Provides @Singleton fun provideGatewayConfig(): GatewayConfig  // host, port from BuildConfig
}

@Module @InstallIn(ServiceComponent::class)
object ServiceModule {
    @Provides fun providePorcupine(@ApplicationContext ctx: Context): Porcupine
    @Provides fun provideAudioRecord(): AudioRecord
    @Provides fun provideRingBuffer(): RingBuffer  // 64KB
}

@AndroidEntryPoint class VoiceAssistantService : LifecycleService() { ... }
@AndroidEntryPoint class VoiceAssistantActivity : ComponentActivity() { ... }
```

### Sub-Area 3: Auth Token Storage

**Decision: EncryptedSharedPreferences (Jetpack Security Crypto)**

| Option | Pros | Cons |
|--------|------|------|
| Android Keystore + manual encrypt | Hardware-backed on API 23+, strongest | Complex key management, hardware quirks across OEMs |
| EncryptedSharedPreferences | Uses Keystore internally, simple API, Google-maintained | Deprecated in favor of DataStore (but still works) |
| DataStore + Tink encryption | Modern replacement, proto/preferences variants | More boilerplate, Tink adds ~2MB |
| SharedPreferences (plain) | Simplest | **Insecure** — tokens readable with root |

**EncryptedSharedPreferences** is the pragmatic choice:
- Uses Android Keystore under the hood (AES-256-SIV for keys, AES-256-GCM for values)
- API 23+ (Marshmallow) — no backward-compat concern for family devices
- Google's `androidx.security:security-crypto:1.1.0-alpha06` (stable enough for personal project)
- Simple `getString`/`putString` API, no manual crypto

```kotlin
class TokenStore @Inject constructor(@ApplicationContext private val context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context, "voice_assistant_tokens",
        MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveToken(token: String) = prefs.edit().putString("paseto_token", token).apply()
    fun getToken(): String? = prefs.getString("paseto_token", null)
    fun clearToken() = prefs.edit().remove("paseto_token").apply()
    fun hasToken(): Boolean = prefs.contains("paseto_token")
}
```

**Token lifecycle on Android:**
- **Family member**: Token saved on first auth (manual entry or QR scan from admin). Persists across app restarts. Refresh token stored alongside access token. On access token expiry → auto-refresh. On refresh token expiry → re-auth required.
- **Guest**: Token received via QR/PIN flow, stored in-memory only (not in EncryptedSharedPreferences). Discarded on session end or app close. Guest tokens have 4-hour TTL, no refresh.

**First-run auth flow:**
1. App launches → `TokenStore.hasToken()` returns `false`
2. Show onboarding screen: "Enter gateway address" (mDNS discovery or manual IP)
3. Admin generates family token via gateway CLI: `./gateway token create --user kevin --role adult`
4. Display QR code on admin device / terminal
5. User scans QR → token extracted → `TokenStore.saveToken()`
6. WebSocket connects with token → `auth.ok` → proceed to main UI

### Sub-Area 4: Opus/Porcupine Frame Mismatch (RESOLVED)

Already resolved in wake-word-audio-buffering decomposition. Summary:

**Porcupine**: 512 samples (32ms at 16kHz)
**Opus**: 320 samples (20ms at 16kHz)

**Resolution**: Independent consumers of the same PCM stream. Each has its own `FrameAccumulator`:
- Porcupine accumulator: collects 512 samples → `porcupine.process()` → reset
- Opus encoder accumulator: collects 320 samples → `OpusEncoder.encode()` → reset
- Ring buffer: stores raw PCM continuously, frame-boundary-agnostic

No synchronization needed — they're independent read-only consumers. The `AudioCaptureThread` feeds raw PCM bytes to both accumulators in sequence on the same thread:

```kotlin
// In AudioCaptureThread.run() loop:
val bytesRead = audioRecord.read(buffer, 0, buffer.size)
if (bytesRead > 0) {
    ringBuffer.write(buffer, 0, bytesRead)
    porcupineAccumulator.feed(buffer, 0, bytesRead) { frame ->
        val keywordIndex = porcupine.process(frame)
        if (keywordIndex >= 0) onWakeWord()
    }
    // Only when streaming (post-wake-word):
    if (isStreaming) {
        opusAccumulator.feed(buffer, 0, bytesRead) { frame ->
            val encoded = opusEncoder.encode(frame)
            audioEventChannel.trySend(AudioEvent.OpusFrame(encoded))
        }
    }
}
```

When using raw PCM (Approach A / prototyping), skip the Opus accumulator entirely and send raw bytes directly.

### Sub-Area 5: Test Strategy

#### Unit Tests (JVM — no Android framework, run with JUnit 5)

| Component | Tests | Framework |
|-----------|-------|-----------|
| `RingBuffer` | 9 tests from wake-word decomposition matrix (capacity, wrap, drain, byte order) | JUnit 5 |
| `FrameAccumulator` | Variable chunk → exact frame emission, partial buffering, empty input | JUnit 5 |
| `TokenStore` | Save/get/clear/has token (mock EncryptedSharedPreferences via interface) | JUnit 5 + Mockk |
| `MessageSerializer` | JSON control message serialization/deserialization, all message types | JUnit 5 + kotlinx.serialization |
| `ReconnectionStrategy` | Exponential backoff timing, jitter bounds, attempt reset | JUnit 5 |
| `AudioEventMapper` | Wake word event → wire protocol messages (session.start, binary, audio.end) | JUnit 5 |

#### Integration Tests (Instrumented — run on device/emulator)

| Component | Tests | Framework |
|-----------|-------|-----------|
| `AudioCaptureThread` | Start/stop recording, thread priority set, AudioRecord lifecycle | AndroidX Test + Robolectric |
| `VoiceAssistantService` | Foreground notification created, wake lock acquired/released, bind/unbind | AndroidX Test + ServiceTestRule |
| `Porcupine integration` | Load .ppn model, process 512-sample frames, detect known keyword from test audio | AndroidX Test (real Porcupine SDK, on device) |
| `WebSocketRepository` | Connect to mock server, auth handshake, send/receive frames, reconnection | AndroidX Test + MockWebServer |
| `NetworkMonitor` | Detect connectivity changes, trigger reconnect callback | AndroidX Test + ConnectivityManager mock |

#### UI Tests (Compose)

| Screen | Tests | Framework |
|--------|-------|-----------|
| Conversation view | Messages render, auto-scroll on new message, streaming text updates | Compose UI Test |
| Voice indicator | Pulsing animation states (idle, listening, processing, speaking) | Compose UI Test |
| Tool confirmation | Bottom sheet shows tool details, allow/deny buttons work | Compose UI Test |
| Connection status | Chip shows correct state for connected/reconnecting/disconnected | Compose UI Test |
| Onboarding | QR scan → token saved → navigate to main screen | Compose UI Test + Espresso |

#### End-to-End Tests

| Scenario | Setup | Assertion |
|----------|-------|-----------|
| Full voice pipeline | Test audio file → AudioRecord mock → Porcupine → gateway mock | Correct wire messages sent, transcript received, TTS played |
| Barge-in | TTS playing + simulated wake word | Playback stops, barge_in sent, new session starts |
| Reconnection | Mock server drops connection | Client reconnects with session_id, resumes |
| Guest mode | Guest token → connect → attempt write tool | Tool blocked, no memory write |

### Package Structure

```
com.family.voiceassistant/
├── di/                          # Hilt modules
│   ├── AppModule.kt
│   └── ServiceModule.kt
├── data/
│   ├── auth/
│   │   └── TokenStore.kt       # EncryptedSharedPreferences
│   ├── network/
│   │   ├── WebSocketRepository.kt   # OkHttp WS, send/receive, reconnect
│   │   ├── MessageSerializer.kt     # JSON ↔ control messages
│   │   ├── NetworkMonitor.kt        # WiFi↔cellular detection
│   │   └── ReconnectionStrategy.kt  # Exp backoff + jitter
│   └── audio/
│       ├── RingBuffer.kt        # 64KB circular buffer
│       ├── FrameAccumulator.kt  # Variable→fixed frame size
│       └── AudioPlaybackManager.kt  # AudioTrack TTS playback
├── service/
│   ├── VoiceAssistantService.kt     # Foreground service
│   ├── AudioCaptureThread.kt        # Dedicated audio thread
│   └── AudioEvent.kt               # Sealed class: WakeWord, Frame, Silence
├── ui/
│   ├── VoiceAssistantActivity.kt
│   ├── VoiceAssistantViewModel.kt
│   ├── screens/
│   │   ├── ConversationScreen.kt
│   │   ├── OnboardingScreen.kt
│   │   └── SettingsScreen.kt
│   └── components/
│       ├── MessageBubble.kt
│       ├── VoiceIndicator.kt
│       ├── ToolConfirmationSheet.kt
│       └── ConnectionStatusChip.kt
├── model/
│   ├── Message.kt               # Conversation message
│   ├── ConnectionState.kt       # Connected/Reconnecting/Disconnected
│   ├── VoiceState.kt            # Idle/Listening/Processing/Speaking
│   └── ControlMessage.kt        # Sealed class for all protocol message types
└── util/
    └── AudioFormat.kt           # Constants: SAMPLE_RATE, CHANNELS, ENCODING
```

## Open Questions

1. **TTS audio format from gateway**: Does gateway send PCM or Opus TTS audio back? Determines whether client needs an Opus decoder. If Fish Audio outputs Opus natively, gateway could relay Opus directly to client.
2. **Guest mode on Android**: How does a guest get the app + token? APK sideload + QR code for token? Or web client for guests? (Web client is the simpler path for guests.)
3. **Multiple wake words per user**: Porcupine supports multiple simultaneous keywords. Could use different wake words to identify speakers or trigger different modes.
4. **Android Auto integration**: Worth exploring later — voice assistant in car via Android Auto's voice interaction API.
5. **Accessibility**: TalkBack compatibility for the Compose UI. Voice-only mode for visually impaired users.
6. **Gradle configuration**: Min SDK 26 (Android 8.0 — covers 95%+ of active devices), target SDK 35 (Android 15), Kotlin 2.1.x, Compose BOM 2025.x.
