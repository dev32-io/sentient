# Mobile Client — Conversational Client (SDK core + text + voice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `@sentient/web-sdk` to KMP `shared/mobile-sdk` (transport, auth, reconnect/resume, status FSM, all connectors, gates, codec, logger) and build both native UIs (SwiftUI + Compose) on top — delivering a working **text + voice** chat app on iOS simulator and Android emulator/device, reaching the local macOS gateway.

**Architecture:** The SDK is a fat KMP module mirroring web-sdk 1:1. Pure logic (codec, EchoGate, SpeechGate, AudioPreRollRing, IdleDetector, status FSM, reconnect backoff, message models, connectors) lives in `commonMain` and is unit-tested in `commonTest` with NO platform. Platform capability (WS engine, secure store, log sink, mic capture, audio playback) enters via `expect`/`actual` or injected interfaces, each with an in-memory fake for tests. The SDK exposes ONE observable `StateFlow<SdkState>` plus suspend/Flow commands; SKIE bridges these to Swift `async`/`AsyncSequence`/enums. Native apps are dumb consumers — UI binds to `SdkState`, calls commands, never touches protocol. **Android and iOS UI tracks run fully in parallel against the same SDK surface.**

**Tech Stack:** Kotlin 2.3.10, AGP 8.13.2, Gradle 8.13, SKIE 0.10.11, Ktor client 3.5.0 (OkHttp/Darwin/websockets), kotlinx-coroutines 1.11.0, kotlinx-serialization 1.8.x, Compose BOM 2026.05.01, SwiftUI (iOS 17+), Xcode 26.5. Dev-driving: `android` CLI + emulator, Maestro (XCUITest/WDA) + iPhone 14 Pro/iOS 26.5 sim, gateway `wss://localhost:8888`.

**Spec:** `docs/superpowers/specs/2026-06-01-mobile-client-design.md`. **This is Plan 2 of 4** (Plan 1 Foundation = done). Plan 3 = push plumbing (new gateway `/push/register` + `PushSender`); Plan 4 = deployment doc + polish. Push + deploy are out of THIS plan's scope.

**Reference maps (verbatim source semantics this plan ports — verify against source if a detail is unclear):**
- web-sdk source: `shared/web-sdk/src/` — orchestrator `sentient-sdk.ts`, `connector-types.ts`, `sdk-reconnect.ts`, `echo-gate.ts`, `speech-gate.ts`, `audio-pre-roll-ring.ts`, `presence/idle-detector.ts`, `audio-codec.ts`, `logger.ts`, `event-emitter.ts`, `connectors/*.ts`.
- wire protocol: `shared/protocol/src/messages.ts`, `shared/protocol/src/sessions.ts`, `shared/protocol/src/conversation.ts`; gateway `gateway/src/session-handlers/ws-auth-gate.ts`, `gateway/src/api/handlers/ws-session-configure.ts`, `gateway/src/api/handlers/auth.ts`.
- design tokens: `gateway/webui/src/styles/tokens/*.css`; UI structure `gateway/webui/src/components/**`, `gateway/webui/src/hooks/voice-status.ts`.

---

## Resolved design decisions (baked into this plan)

| # | Decision | Why / flag |
|---|----------|-----------|
| R1 | **`clientType: "webui"`** in `session.configure` (gateway enum is `["webui","cube"]`). | Zero gateway change. Mobile inherits webui playback config. A dedicated `"mobile"` clientType is a future gateway enhancement — flag, do not block. |
| R2 | **Uplink = PCM16 LE @ `inputSampleRate` (16000)**, downlink decoded per `connector.audio.start.encoding`/`sampleRate`. v1 asserts the local stack emits `encoding == "pcm16"`; **Opus downlink is deferred** (P-voice flags it if the stack returns opus). | webui uses Opus at its app layer (WebCodecs); the SDK contract is PCM16. Mobile v1 stays PCM16 end-to-end (no opus dependency). |
| R3 | **Auth HTTP client lives in `shared/mobile-sdk` commonMain** (Ktor), unlike webui (app-layer `auth-api.ts`). | Native apps must not each reimplement auth HTTP. Keeps the app dumb. |
| R4 | **Design tokens are commonMain Kotlin constants** (`io.sentient.mobilesdk.design`), exact values from webui `tokens/*.css`. Compose maps them into a `MaterialTheme`; SwiftUI reads the SKIE-exposed constants. | Single source of truth → visual parity without a shared renderer (spec §6). |
| R5 | **The SDK derives the single `SdkState`** (status + messages + cognition + voiceMode + prefs + tasks + transcript + inflight + connectionLost/authExpired), mirroring webui's `useVoiceClient` derivation — but inside the SDK so both UIs share it. | coroutines-flow-surface rule: ONE state surface. Native UIs don't re-derive. |
| R6 | **`message.delta`/`message.done` drive the inflight connector** (not present in some web-sdk docs as separate — they exist in the gateway protocol). CognitionState is driven by `cycle.started→thinking`, `cycle.completed→idle`, `cycle.aborted→idle` (mirror web-sdk `cognition-status-connector.ts` exactly, NOT the gateway's separate `cognition.status` frame). | Port web-sdk transition tables verbatim (web-sdk-mirror-contract rule). |

---

## File Structure

**SDK — `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/`**
```
protocol/
  ClientMessage.kt          ← sealed c→s frames (serialization)
  ServerMessage.kt          ← sealed s→c frames (serialization)
  ConversationFeedItem.kt   ← sealed feed item (user/trigger/assistant/tool)
  AudioPreferences.kt       ← prefs + patch
  WireJson.kt               ← Json config (class discriminator "type")
audio/
  AudioCodec.kt             ← pcm16<->float32 + computeRms
  EchoGate.kt               ← baseline/playback/tail FSM
  SpeechGate.kt             ← closed/open FSM
  AudioPreRollRing.kt       ← idle/active ring
log/
  Log.kt                    ← Log interface + createLogger + loggerTag
  LogSanitizer.kt           ← redact PASETO/tokens
  LogSink.kt                ← expect interface (actual: logcat/os_log)
util/
  EventEmitter.kt           ← typed emitter
  Clock.kt                  ← expect monotonic clock (injectable)
presence/
  IdleDetector.kt           ← active/warning/idle FSM
transport/
  WebSocketEngine.kt        ← expect WS engine interface
  SdkStatus.kt              ← status enum + transitions
  ReconnectConfig.kt        ← config + computeBackoffMs
  ReconnectController.kt    ← backoff loop
  SessionResume.kt          ← buildConnectUrl/setCurrentSessionId/pendingResume
  WsTransport.kt            ← connect/send/receive/close
  MessageRouter.kt          ← dispatch ServerMessage to connectors
secure/
  SecureTokenStore.kt       ← expect interface (actual: Keychain/EncryptedPrefs)
auth/
  AuthClient.kt             ← Ktor: /auth/users, /auth/login, /auth/me
  AuthModels.kt             ← request/response DTOs
connectors/
  Connector.kt              ← base interface
  UserTextInputConnector.kt
  UserAudioInputConnector.kt
  AssistantAudioResponseConnector.kt
  PreferencesConnector.kt
  CognitionStatusConnector.kt
  ConversationHistoryConnector.kt
  InFlightMessageConnector.kt
  TaskStatusConnector.kt
  SessionsConnector.kt
sdk/
  SentientSdk.kt            ← orchestrator + connect/disconnect/commands
  SdkConfig.kt              ← config
  SdkState.kt               ← the single observable state + derivation
design/
  DesignTokens.kt           ← colors/spacing/type/radius/motion constants
audioio/
  AudioCaptureAdapter.kt    ← expect (P-voice; AudioRecord/AVAudioEngine)
  AudioPlaybackAdapter.kt   ← expect (P-voice; AudioTrack/AVAudioEngine)
  AudioPipeline.kt          ← capture->gate->uplink ; downlink->gate->playback (P-voice)
```
`androidMain/…` / `iosMain/…` carry the `actual`s. `commonTest/…` carries ports of web-sdk tests + fakes.

**Android — `android/src/main/kotlin/io/sentient/android/`**
```
SentientApp.kt (Application)  MainActivity.kt
theme/Theme.kt  theme/Tokens.kt
sdk/SdkHolder.kt (DI singleton)  sdk/SdkViewModel.kt (StateFlow bridge)
auth/LoginScreen.kt  auth/AvatarTile.kt  auth/PinPad.kt  auth/AuthViewModel.kt
chat/ChatScreen.kt  chat/MessageList.kt  chat/MessageBubble.kt  chat/Composer.kt  chat/SentientMark.kt
history/HistoryDrawer.kt
settings/SettingsScreen.kt
nav/AppNav.kt (typed routes)
```

**iOS — `ios/App/`**
```
SentientApp.swift  RootView.swift
Theme/Tokens.swift  Theme/Colors.swift
SDK/SdkStore.swift (ObservableObject over SdkState AsyncSequence)
Auth/LoginView.swift  Auth/AvatarTile.swift  Auth/PinPad.swift
Chat/ChatView.swift  Chat/MessageList.swift  Chat/MessageBubble.swift  Chat/Composer.swift  Chat/SentientMark.swift
History/HistorySheet.swift
Settings/SettingsView.swift
Nav/AppRoute.swift
```

**E2E — `qa/mobile/`**: `text-matrix.md`, `voice-matrix.md`, `text-ios.yaml` (Maestro), `voice-ios.yaml`, android-CLI flows documented in `README.md`.

---

# PHASE 1 — SDK core + text round-trip

> Produces a fully ported SDK validated by contract tests (mock exact gateway frames) plus an optional `@live` text round-trip against the local stack. No UI yet. **Tasks A1–A9 are mutually independent pure units → parallelizable.** Tasks B/C depend on A.

## Task A1: Wire message models + JSON discriminator

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/WireJson.kt`, `ClientMessage.kt`, `ServerMessage.kt`, `ConversationFeedItem.kt`, `AudioPreferences.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/WireSerializationTest.kt`
- Modify: `shared/mobile-sdk/build.gradle.kts` (add serialization plugin + dep), `gradle/libs.versions.toml` (already has serialization)

- [ ] **Step 1: Add serialization to the module**

In `shared/mobile-sdk/build.gradle.kts` add `alias(libs.plugins.kotlin.serialization)` to the `plugins {}` block and `implementation(libs.kotlinx.serialization.json)` to `commonMain.dependencies`.

- [ ] **Step 2: Write the failing serialization test**

`WireSerializationTest.kt`:
```kotlin
package io.sentient.mobilesdk.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WireSerializationTest {
    @Test fun auth_frame_encodes_with_type_discriminator() {
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), ClientMessage.Auth("tok123"))
        assertTrue(json.contains("\"type\":\"auth\""))
        assertTrue(json.contains("\"token\":\"tok123\""))
    }

    @Test fun text_input_round_trips() {
        val msg: ClientMessage = ClientMessage.TextInput("hi")
        val s = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        val back = WireJson.instance.decodeFromString(ClientMessage.serializer(), s)
        assertEquals(msg, back)
    }

    @Test fun session_ready_decodes_with_rates() {
        val s = """{"type":"session.ready","sessionId":"s1","audioEncoding":"pcm16","inputSampleRate":16000,"outputSampleRate":48000}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.SessionReady
        assertEquals("s1", msg.sessionId)
        assertEquals(16000, msg.inputSampleRate)
        assertEquals(48000, msg.outputSampleRate)
    }

    @Test fun unknown_server_type_decodes_to_unknown() {
        val s = """{"type":"some.future.frame","x":1}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s)
        assertTrue(msg is ServerMessage.Unknown)
    }

    @Test fun conversation_entry_assistant_with_cutoff() {
        val s = """{"type":"conversation.entry","item":{"ts":1,"kind":"assistant","content":"hello","cutoff":{"kind":"interrupt","cancelledTaskIds":["t1"]}}}"""
        val msg = WireJson.instance.decodeFromString(ServerMessage.serializer(), s) as ServerMessage.ConversationEntry
        val item = msg.item as ConversationFeedItem.Assistant
        assertEquals("hello", item.content)
        assertEquals("interrupt", item.cutoff?.kind)
    }
}
```

- [ ] **Step 3: Run test, verify it fails (unresolved references)**

Run: `./gradlew :shared:mobile-sdk:compileTestKotlinIosSimulatorArm64` → FAIL (ClientMessage etc. undefined).

- [ ] **Step 4: Write `WireJson.kt`**

```kotlin
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.json.Json

/** Wire JSON: lenient on unknown server fields, discriminator key is "type" (matches gateway). */
object WireJson {
    val instance: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }
}
```

- [ ] **Step 5: Write `ClientMessage.kt` (c→s frames)**

Mirror `shared/protocol/src/messages.ts` + `sessions.ts` exactly. `@SerialName` value = the wire `type` string.
```kotlin
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed class ClientMessage {
    @Serializable @SerialName("auth")
    data class Auth(val token: String) : ClientMessage()

    @Serializable @SerialName("session.configure")
    data class SessionConfigure(
        val language: String = "en",
        val capabilities: Capabilities,
        val clientType: String, // "webui" for mobile v1 (R1)
    ) : ClientMessage()

    @Serializable @SerialName("audio.start")
    data object AudioStart : ClientMessage()

    @Serializable @SerialName("audio.end")
    data object AudioEnd : ClientMessage()

    @Serializable @SerialName("text.input")
    data class TextInput(val text: String) : ClientMessage()

    @Serializable @SerialName("tool.confirm")
    data class ToolConfirm(val toolCallId: String, val approved: Boolean) : ClientMessage()

    @Serializable @SerialName("session.end")
    data object SessionEnd : ClientMessage()

    @Serializable @SerialName("ping")
    data object Ping : ClientMessage()

    @Serializable @SerialName("interrupt")
    data object Interrupt : ClientMessage()

    @Serializable @SerialName("user.preferences.patch")
    data class UserPreferencesPatch(
        val ttsEnabled: Boolean? = null,
        val channel: String? = null,
    ) : ClientMessage()

    @Serializable @SerialName("sessions.list")
    data class SessionsList(val requestId: String, val limit: Int, val offset: Int) : ClientMessage()

    @Serializable @SerialName("sessions.search")
    data class SessionsSearch(val requestId: String, val q: String, val limit: Int) : ClientMessage()

    @Serializable @SerialName("sessions.delete")
    data class SessionsDelete(val requestId: String, val sessionId: String) : ClientMessage()

    @Serializable @SerialName("sessions.rename")
    data class SessionsRename(val requestId: String, val sessionId: String, val title: String) : ClientMessage()

    @Serializable @SerialName("session.new")
    data class SessionNew(val requestId: String) : ClientMessage()

    @Serializable @SerialName("session.switch")
    data class SessionSwitch(val requestId: String, val sessionId: String) : ClientMessage()
}

@Serializable
data class Capabilities(val supports: List<String>)
```

- [ ] **Step 6: Write `ConversationFeedItem.kt`**

Mirror `shared/protocol/src/conversation.ts` (kinds user/trigger/assistant/tool). Discriminator key is `kind`, so this nested hierarchy needs its own Json context — use a separate discriminator. Implement as a sealed class with `@JsonClassDiscriminator("kind")`:
```kotlin
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ConversationFeedItem {
    abstract val ts: Long

    @Serializable @SerialName("user")
    data class User(override val ts: Long, val channel: String, val content: String) : ConversationFeedItem()

    @Serializable @SerialName("trigger")
    data class Trigger(override val ts: Long, val source: String, val summary: String) : ConversationFeedItem()

    @Serializable @SerialName("assistant")
    data class Assistant(override val ts: Long, val content: String, val cutoff: Cutoff? = null) : ConversationFeedItem()

    @Serializable @SerialName("tool")
    data class Tool(override val ts: Long, val toolName: String, val status: String, val summary: String) : ConversationFeedItem()
}

@Serializable
data class Cutoff(val kind: String, val cancelledTaskIds: List<String> = emptyList())
```
> NOTE: the parent `ServerMessage` uses discriminator `type`; `ConversationFeedItem` uses `kind`. kotlinx.serialization supports per-hierarchy discriminators via `@JsonClassDiscriminator`. Keep `WireJson` global discriminator `type`; the `@JsonClassDiscriminator("kind")` annotation overrides it for this hierarchy.

- [ ] **Step 7: Write `AudioPreferences.kt`**

```kotlin
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.Serializable

@Serializable
data class AudioPreferences(val ttsEnabled: Boolean = true, val channel: String = "voice") {
    companion object { val DEFAULT = AudioPreferences(ttsEnabled = true, channel = "voice") }
}

data class AudioPreferencesPatch(val ttsEnabled: Boolean? = null, val channel: String? = null)
```

- [ ] **Step 8: Write `ServerMessage.kt` (s→c frames)**

Mirror every s→c `type` from the protocol map. Include an `Unknown` fallback for forward-compat (gateway may add frames). Split into one file if under 300 lines; else split sessions results into `ServerSessionsMessages.kt`. Key members:
```kotlin
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
sealed class ServerMessage {
    @Serializable @SerialName("auth.ok")
    data class AuthOk(val user: AuthUser) : ServerMessage()

    @Serializable @SerialName("auth.error")
    data class AuthError(val code: String, val message: String) : ServerMessage()

    @Serializable @SerialName("session.ready")
    data class SessionReady(
        val sessionId: String,
        val audioEncoding: String,
        val inputSampleRate: Int,
        val outputSampleRate: Int,
    ) : ServerMessage()

    @Serializable @SerialName("pong") data object Pong : ServerMessage()

    @Serializable @SerialName("error")
    data class Error(val code: String, val message: String) : ServerMessage()

    @Serializable @SerialName("session.expired")
    data class SessionExpired(val reason: String) : ServerMessage()

    @Serializable @SerialName("session.preferences.changed")
    data class SessionPreferencesChanged(val preferences: AudioPreferences) : ServerMessage()

    @Serializable @SerialName("conversation.snapshot")
    data class ConversationSnapshot(val items: List<ConversationFeedItem> = emptyList()) : ServerMessage()

    @Serializable @SerialName("conversation.entry")
    data class ConversationEntry(val item: ConversationFeedItem) : ServerMessage()

    @Serializable @SerialName("cycle.started")
    data class CycleStarted(val cycleId: String, val triggerKind: String? = null, val triggerSource: String? = null) : ServerMessage()

    @Serializable @SerialName("cycle.aborted")
    data class CycleAborted(val cycleId: String, val reason: String? = null) : ServerMessage()

    @Serializable @SerialName("cycle.completed")
    data class CycleCompleted(val cycleId: String) : ServerMessage()

    @Serializable @SerialName("connector.transcript.final")
    data class ConnectorTranscriptFinal(val text: String, val language: String? = null) : ServerMessage()

    @Serializable @SerialName("connector.audio.start")
    data class ConnectorAudioStart(val cycleId: String? = null, val taskId: String? = null, val encoding: String? = null, val sampleRate: Int? = null) : ServerMessage()

    @Serializable @SerialName("connector.audio.done")
    data class ConnectorAudioDone(val cycleId: String? = null, val taskId: String? = null) : ServerMessage()

    @Serializable @SerialName("message.delta")
    data class MessageDelta(val cycleId: String? = null, val delta: String? = null) : ServerMessage()

    @Serializable @SerialName("message.done")
    data class MessageDone(val cycleId: String? = null) : ServerMessage()

    @Serializable @SerialName("task.update")
    data class TaskUpdate(
        val taskId: String, val toolName: String, val cycleId: String, val status: String,
        val argsPreview: String, val startedAtMs: Long, val endedAtMs: Long? = null,
    ) : ServerMessage()

    @Serializable @SerialName("playback.stop")
    data class PlaybackStop(val cycleId: String? = null, val reason: String? = null) : ServerMessage()

    @Serializable @SerialName("sessions.list.result")
    data class SessionsListResult(val requestId: String, val items: List<SessionRow>, val total: Int, val hasMore: Boolean) : ServerMessage()

    @Serializable @SerialName("sessions.search.result")
    data class SessionsSearchResult(val requestId: String, val items: List<SessionRow>) : ServerMessage()

    @Serializable @SerialName("sessions.delete.result")
    data class SessionsDeleteResult(val requestId: String, val sessionId: String) : ServerMessage()

    @Serializable @SerialName("sessions.deleted")
    data class SessionsDeleted(val sessionId: String) : ServerMessage()

    @Serializable @SerialName("sessions.rename.result")
    data class SessionsRenameResult(val requestId: String, val sessionId: String, val title: String) : ServerMessage()

    @Serializable @SerialName("sessions.renamed")
    data class SessionsRenamed(val sessionId: String, val title: String) : ServerMessage()

    @Serializable @SerialName("session.created")
    data class SessionCreated(val sessionId: String, val title: String? = null, val ts: Long) : ServerMessage()

    @Serializable @SerialName("session.switched")
    data class SessionSwitched(val sessionId: String, val title: String? = null, val ts: Long) : ServerMessage()

    @Serializable @SerialName("sessions.error")
    data class SessionsError(val requestId: String, val code: String, val message: String) : ServerMessage()

    /** Forward-compat catch-all for frames mobile v1 ignores (tool.confirm_request, cognition.status, commands.available, connector.cancelled, …). */
    @Serializable
    data class Unknown(val raw: JsonObject? = null) : ServerMessage()
}

@Serializable
data class AuthUser(val userId: String, val displayName: String, val isAdmin: Boolean = false, val avatarTint: String = "")

@Serializable
data class SessionRow(
    val sessionId: String, val rootId: String? = null, val title: String,
    val startedAt: Long, val lastActiveAt: Long, val messageCount: Int, val isActive: Boolean,
)
```
> For `Unknown` to be the default fallback, register it as the polymorphic default. In `WireJson` add: `serializersModule = SerializersModule { polymorphicDefaultDeserializer(ServerMessage::class) { ServerMessage.Unknown.serializer() } }`. Add the `import kotlinx.serialization.modules.*` and update `WireJson.kt` accordingly.

- [ ] **Step 9: Update `WireJson.kt` for the Unknown fallback, run the test green**

Run: `./gradlew :shared:mobile-sdk:allTests` → `WireSerializationTest` 5 tests PASS.

- [ ] **Step 10: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol shared/mobile-sdk/src/commonTest shared/mobile-sdk/build.gradle.kts
git commit -m "feat(mobile-sdk): wire message models (client/server/feed) + serialization"
```

---

## Task A2: Audio codec + RMS  ‖

**Files:**
- Create: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audio/AudioCodec.kt`
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/audio/AudioCodecTest.kt`

- [ ] **Step 1: Write the failing test (port `audio-codec.test.ts`)**

```kotlin
package io.sentient.mobilesdk.audio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AudioCodecTest {
    @Test fun pcm16_to_float_normalizes() {
        val bytes = shortsToLeBytes(shortArrayOf(0, 16384, -16384))
        val f = pcm16ToFloat32(bytes)
        assertEquals(0f, f[0])
        assertTrue(kotlin.math.abs(f[1] - 0.5f) < 1e-3)
        assertTrue(kotlin.math.abs(f[2] + 0.5f) < 1e-3)
    }
    @Test fun float_to_pcm16_clamps() {
        val out = float32ToPcm16(floatArrayOf(2.0f, -2.0f))
        val s = leBytesToShorts(out)
        assertEquals(32767, s[0].toInt())
        assertEquals(-32768, s[1].toInt())
    }
    @Test fun rms_of_silence_is_zero() {
        assertEquals(0.0, computeRms(ShortArray(64)))
    }
}
```
Add small test helpers `shortsToLeBytes`/`leBytesToShorts` in the test file.

- [ ] **Step 2: Run, verify fail.** `./gradlew :shared:mobile-sdk:compileTestKotlinIosSimulatorArm64` → FAIL.

- [ ] **Step 3: Write `AudioCodec.kt`** (port `audio-codec.ts` + `computeRms` from `echo-gate.ts`)

```kotlin
package io.sentient.mobilesdk.audio

private const val INT16_MAX = 32767
private const val INT16_MIN_MAGNITUDE = 32768
private const val PCM16_SCALE = 32768.0

/** Little-endian PCM16 bytes → Float32 in [-1,1). Mirrors web-sdk pcm16ToFloat32. */
fun pcm16ToFloat32(bytes: ByteArray): FloatArray {
    val n = bytes.size / 2
    val out = FloatArray(n)
    for (i in 0 until n) {
        val lo = bytes[i * 2].toInt() and 0xFF
        val hi = bytes[i * 2 + 1].toInt()
        val sample = (hi shl 8) or lo // sign-extends via hi (Byte) shl 8
        out[i] = sample / INT16_MIN_MAGNITUDE.toFloat()
    }
    return out
}

/** Float32 → little-endian PCM16 bytes. Mirrors web-sdk float32ToPcm16. */
fun float32ToPcm16(samples: FloatArray): ByteArray {
    val out = ByteArray(samples.size * 2)
    for (i in samples.indices) {
        val s = samples[i].coerceIn(-1f, 1f)
        val v = if (s < 0) (s * INT16_MIN_MAGNITUDE).toInt() else (s * INT16_MAX).toInt()
        out[i * 2] = (v and 0xFF).toByte()
        out[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }
    return out
}

/** RMS of PCM16 samples normalized to [0,1]. Mirrors web-sdk computeRms. */
fun computeRms(pcm: ShortArray): Double {
    if (pcm.isEmpty()) return 0.0
    var sumSq = 0.0
    for (s in pcm) { val v = s / PCM16_SCALE; sumSq += v * v }
    return kotlin.math.sqrt(sumSq / pcm.size)
}
```

- [ ] **Step 4: Run green.** `./gradlew :shared:mobile-sdk:allTests` → AudioCodecTest PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(mobile-sdk): PCM16<->Float32 codec + RMS (port web-sdk audio-codec)"`

---

## Task A3: Logger + sanitizer + LogSink expect  ‖

**Files:**
- Create: `log/Log.kt`, `log/LogSanitizer.kt`, `log/LogSink.kt` (expect), androidMain/iosMain `LogSink` actuals
- Test: `commonTest/.../log/LogSanitizerTest.kt`

- [ ] **Step 1: Write failing sanitizer test** (security boundary — keep this test)

```kotlin
package io.sentient.mobilesdk.log
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
class LogSanitizerTest {
    @Test fun redacts_paseto_v4_local() {
        val msg = "auth token v4.local.AAAAAAAAAAAAAAAAAAAAAAAAAA done"
        val out = sanitizeLog(msg)
        assertFalse(out.contains("v4.local.AAAA"))
        assertTrue(out.contains("[redacted]"))
    }
    @Test fun truncates_long_previews() {
        assertTrue(truncatePreview("x".repeat(500)).length <= 123)
    }
}
```

- [ ] **Step 2: Run fail. Step 3: implement.**

`LogSink.kt`:
```kotlin
package io.sentient.mobilesdk.log
enum class LogLevel { DEBUG, INFO, WARN, ERROR }
expect fun platformLogSink(tag: String, level: LogLevel, message: String)
```
`LogSanitizer.kt` (port gateway redaction intent — PASETO `v4.local.*`/`v4.public.*`, bearer tokens; preview cap 120):
```kotlin
package io.sentient.mobilesdk.log
private val PASETO = Regex("""v4\.(local|public)\.[A-Za-z0-9_\-]+""")
private val BEARER = Regex("""(?i)bearer\s+[A-Za-z0-9._\-]+""")
private const val MAX_PREVIEW = 120
fun sanitizeLog(s: String): String = s.replace(PASETO, "[redacted]").replace(BEARER, "[redacted]")
fun truncatePreview(s: String): String = if (s.length <= MAX_PREVIEW) s else s.take(MAX_PREVIEW) + "…"
```
`Log.kt`:
```kotlin
package io.sentient.mobilesdk.log
interface Log {
    fun debug(message: String, props: Map<String, Any?> = emptyMap())
    fun info(message: String, props: Map<String, Any?> = emptyMap())
    fun warn(message: String, props: Map<String, Any?> = emptyMap())
    fun error(message: String, props: Map<String, Any?> = emptyMap())
}
fun loggerTag(vararg tags: String): String = (listOf("sentient", "mobile-sdk") + tags).joinToString(".")
fun createLogger(vararg tags: String): Log {
    val tag = loggerTag(*tags)
    return object : Log {
        private fun emit(level: LogLevel, m: String, p: Map<String, Any?>) {
            val props = if (p.isEmpty()) "" else " " + p.entries.joinToString(" ") { "${it.key}=${truncatePreview(it.value.toString())}" }
            platformLogSink(tag, level, sanitizeLog(m + props))
        }
        override fun debug(message: String, props: Map<String, Any?>) = emit(LogLevel.DEBUG, message, props)
        override fun info(message: String, props: Map<String, Any?>) = emit(LogLevel.INFO, message, props)
        override fun warn(message: String, props: Map<String, Any?>) = emit(LogLevel.WARN, message, props)
        override fun error(message: String, props: Map<String, Any?>) = emit(LogLevel.ERROR, message, props)
    }
}
```
androidMain `LogSink.android.kt`:
```kotlin
package io.sentient.mobilesdk.log
import android.util.Log as AndroidLog
actual fun platformLogSink(tag: String, level: LogLevel, message: String) {
    when (level) {
        LogLevel.DEBUG -> AndroidLog.d(tag, message)
        LogLevel.INFO -> AndroidLog.i(tag, message)
        LogLevel.WARN -> AndroidLog.w(tag, message)
        LogLevel.ERROR -> AndroidLog.e(tag, message)
    }
}
```
iosMain `LogSink.ios.kt` (os_log; subsystem = "io.sentient.app", category = tag):
```kotlin
package io.sentient.mobilesdk.log
import platform.darwin.*
actual fun platformLogSink(tag: String, level: LogLevel, message: String) {
    val log = os_log_create("io.sentient.app", tag)
    val osType = when (level) {
        LogLevel.DEBUG -> OS_LOG_TYPE_DEBUG
        LogLevel.INFO -> OS_LOG_TYPE_INFO
        LogLevel.WARN -> OS_LOG_TYPE_DEFAULT
        LogLevel.ERROR -> OS_LOG_TYPE_ERROR
    }
    _os_log_internal(__dso_handle.ptr, log, osType, message)
}
```
> NOTE: the iOS `_os_log_internal` interop signature can be finicky in Kotlin/Native. If it fails to compile, fall back to `platform.Foundation.NSLog(message)` for v1 (os_log subsystem filtering is a nice-to-have, NSLog still reaches `log stream`). Record which path was used in `agents/docs/mobile-sdk/*-details.md`.

- [ ] **Step 4: Run green. Step 5: commit** `git commit -am "feat(mobile-sdk): tagged logger + sanitizer + LogSink expect/actual"`

---

## Task A4: Typed EventEmitter  ‖

**Files:** `util/EventEmitter.kt` + `commonTest/.../util/EventEmitterTest.kt`

- [ ] **Step 1: failing test** — register handler, emit, assert called; unsubscribe stops calls; `removeAll` clears.
- [ ] **Step 2: fail. Step 3: implement** (port `event-emitter.ts`):
```kotlin
package io.sentient.mobilesdk.util
class EventEmitter<T> {
    private val handlers = mutableSetOf<(T) -> Unit>()
    fun on(handler: (T) -> Unit): () -> Unit { handlers.add(handler); return { handlers.remove(handler) } }
    fun emit(value: T) { handlers.toList().forEach { it(value) } }
    fun removeAll() = handlers.clear()
}
```
- [ ] **Step 4: green. Step 5: commit.**

---

## Task A5: EchoGate  ‖

**Files:** `audio/EchoGate.kt` + `commonTest/.../audio/EchoGateTest.kt`

EchoGate is pure but uses a timer for the `tail` hold. To keep it testable without a real clock, inject `nowMs` into `onPlaybackDrain` and check expiry in `acceptFrame(pcm, nowMs)` — deviation from the JS timer-callback design, equivalent semantics, deterministic. Document the deviation in details.

- [ ] **Step 1: failing test (port `echo-gate` behavior)**
```kotlin
package io.sentient.mobilesdk.audio
import kotlin.test.*
class EchoGateTest {
    private val cfg = EchoGateConfig(baselineThreshold = 0.03, playbackThreshold = 0.2, tailHoldMs = 800)
    @Test fun baseline_accepts_above_baseline_threshold() {
        val g = EchoGate(cfg)
        val loud = ShortArray(64) { 4000 } // rms ~0.12 > 0.03
        assertTrue(g.acceptFrame(loud, nowMs = 0))
    }
    @Test fun playback_raises_threshold() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1")
        val mid = ShortArray(64) { 2000 } // rms ~0.06 < 0.2
        assertFalse(g.acceptFrame(mid, nowMs = 10))
    }
    @Test fun tail_holds_then_returns_to_baseline() {
        val g = EchoGate(cfg)
        g.onPlaybackStart("c1"); g.onPlaybackDrain("c1", nowMs = 100)
        val mid = ShortArray(64) { 2000 }
        assertFalse(g.acceptFrame(mid, nowMs = 200))            // still in tail (200<100+800)
        assertTrue(g.acceptFrame(mid, nowMs = 1000))            // tail expired → baseline, 0.06>0.03
    }
    @Test fun cancel_returns_to_baseline_immediately() {
        val g = EchoGate(cfg); g.onPlaybackStart("c1"); g.onPlaybackCancel("c1")
        assertEquals(EchoGateState.BASELINE, g.state(nowMs = 5))
    }
}
```
- [ ] **Step 2: fail. Step 3: implement** `audio/EchoGate.kt`:
```kotlin
package io.sentient.mobilesdk.audio
enum class EchoGateState { BASELINE, PLAYBACK, TAIL }
data class EchoGateConfig(val baselineThreshold: Double, val playbackThreshold: Double, val tailHoldMs: Long)

class EchoGate(private val cfg: EchoGateConfig) {
    private var rawState = EchoGateState.BASELINE
    private var tailExpiresAtMs = 0L
    fun state(nowMs: Long): EchoGateState {
        if (rawState == EchoGateState.TAIL && nowMs >= tailExpiresAtMs) rawState = EchoGateState.BASELINE
        return rawState
    }
    private fun thresholdFor(s: EchoGateState) = if (s == EchoGateState.BASELINE) cfg.baselineThreshold else cfg.playbackThreshold
    fun acceptFrame(pcm: ShortArray, nowMs: Long): Boolean {
        if (pcm.isEmpty()) return false
        return computeRms(pcm) >= thresholdFor(state(nowMs))
    }
    fun onPlaybackStart(cycleId: String) { rawState = EchoGateState.PLAYBACK }
    fun onPlaybackDrain(cycleId: String, nowMs: Long) {
        if (rawState == EchoGateState.PLAYBACK) { rawState = EchoGateState.TAIL; tailExpiresAtMs = nowMs + cfg.tailHoldMs }
    }
    fun onPlaybackCancel(cycleId: String) { rawState = EchoGateState.BASELINE }
}
```
- [ ] **Step 4: green. Step 5: commit.**

---

## Task A6: AudioPreRollRing  ‖

**Files:** `audio/AudioPreRollRing.kt` + test (port `audio-pre-roll-ring.test.ts`).

- [ ] **Step 1: failing test** covering: idle buffers + trims to `preRollFrames`; first accepted frame flushes ring + frame; hangover emits N rejected frames then goes idle; `reset()` clears.
```kotlin
package io.sentient.mobilesdk.audio
import kotlin.test.*
class AudioPreRollRingTest {
    @Test fun onset_flushes_preroll_then_frame() {
        val r = AudioPreRollRing<Int>(preRollFrames = 2, hangoverFrames = 1)
        assertEquals(emptyList(), r.push(1, accepted = false))
        assertEquals(emptyList(), r.push(2, accepted = false))
        assertEquals(emptyList(), r.push(3, accepted = false)) // ring trims to [2,3]
        assertEquals(listOf(2, 3, 4), r.push(4, accepted = true))
    }
    @Test fun hangover_emits_then_idles() {
        val r = AudioPreRollRing<Int>(preRollFrames = 0, hangoverFrames = 1)
        assertEquals(listOf(10), r.push(10, accepted = true))
        assertEquals(listOf(11), r.push(11, accepted = false)) // hangover emits 1
        assertEquals(emptyList(), r.push(12, accepted = false)) // idle now
    }
}
```
- [ ] **Step 2: fail. Step 3: implement** (port the exact logic block from `audio-pre-roll-ring.ts`):
```kotlin
package io.sentient.mobilesdk.audio
class AudioPreRollRing<T>(private val preRollFrames: Int, private val hangoverFrames: Int) {
    private val ring = ArrayDeque<T>()
    private var active = false
    private var hangoverRemaining = 0
    fun push(frame: T, accepted: Boolean): List<T> {
        if (accepted) {
            if (!active) {
                val flush = ring.toMutableList(); ring.clear(); flush.add(frame)
                active = true; hangoverRemaining = hangoverFrames; return flush
            }
            hangoverRemaining = hangoverFrames; return listOf(frame)
        }
        if (active) {
            if (hangoverRemaining > 0) { hangoverRemaining--; if (hangoverRemaining == 0) active = false; return listOf(frame) }
            active = false
        }
        if (preRollFrames == 0) return emptyList()
        ring.addLast(frame); while (ring.size > preRollFrames) ring.removeFirst(); return emptyList()
    }
    fun reset() { ring.clear(); active = false; hangoverRemaining = 0 }
}
```
- [ ] **Step 4: green. Step 5: commit.**

---

## Task A7: SpeechGate  ‖

**Files:** `audio/SpeechGate.kt` + test (port `speech-gate.test.ts`). Composes `AudioPreRollRing` with `hangoverFrames = 0`.

- [ ] **Step 1: failing test** — sustained `isSpeech` for ≥`openDebounceMs` opens and emits pre-roll + frame; gap beyond tolerance resets; `close()` returns to closed; `maxOpenMs` failsafe closes.
- [ ] **Step 2: fail. Step 3: implement** porting `speech-gate.ts` (states `closed`/`open`, `process(frame, isSpeech, nowMs): SpeechGateResult(forward, opened)`). Use config `SpeechGateConfig(openDebounceMs, frameDurationMs, gapToleranceFrames, preRollFrames, maxOpenMs)`. Track sustained-speech ms in closed state with `gapToleranceFrames` tolerance; on open, forward every frame via the ring until `close()` or `nowMs - openedAtMs >= maxOpenMs`.
- [ ] **Step 4: green. Step 5: commit.**
> The exact closed-state counting logic must match `speech-gate.ts` — read it line-by-line during implementation; this test pins parity (FSM invariant, keep the test).

---

## Task A8: IdleDetector  ‖

**Files:** `presence/IdleDetector.kt` + test (port `presence/idle-detector.test.ts`).

- [ ] **Step 1: failing test** — `active→warning→idle` by elapsed; `cycleActive`/`ttsActive`/`demandStay` suppress idle (clamp to warning); `interaction`/`cycle.*`/`tts.*` reset timer; `MINIMUM_IDLE_THRESHOLD_MS = 30_000`, `DEFAULT_WARNING_FRACTION = 0.9`.
- [ ] **Step 2: fail. Step 3: implement** porting `idle-detector.ts` — `IdleDetectorState { ACTIVE, WARNING, IDLE }`, sealed `IdleDetectorEvent`, `handle(event): IdleDetectorState`, `acquireDemandStay(): () -> Unit`, `snapshot()`. Suppression flags clamp natural `IDLE` to `WARNING`.
- [ ] **Step 4: green. Step 5: commit.**

---

## Task A9: Status FSM + reconnect backoff  ‖

**Files:** `transport/SdkStatus.kt`, `transport/ReconnectConfig.kt` + `commonTest/.../transport/ReconnectBackoffTest.kt`

- [ ] **Step 1: failing test** (port `sdk-reconnect.test.ts` backoff portion)
```kotlin
package io.sentient.mobilesdk.transport
import kotlin.test.*
class ReconnectBackoffTest {
    private val cfg = ReconnectConfig() // defaults
    @Test fun backoff_is_exponential_capped() {
        // attempt 1 → 1000..1500 ; attempt 3 → 4000..4500 ; large attempt capped at maxMs+jitter
        assertTrue(computeBackoffMs(1, cfg, jitter = 0.0) == 1000L)
        assertTrue(computeBackoffMs(3, cfg, jitter = 0.0) == 4000L)
        assertTrue(computeBackoffMs(20, cfg, jitter = 0.0) == 30_000L)
    }
}
```
- [ ] **Step 2: fail. Step 3: implement**
```kotlin
// SdkStatus.kt
package io.sentient.mobilesdk.transport
enum class SdkStatus { DISCONNECTED, CONNECTING, AUTHENTICATING, READY, RECONNECTING, ERROR }
enum class LastErrorKind { NONE, AUTH, TIMEOUT, NETWORK }

// ReconnectConfig.kt
package io.sentient.mobilesdk.transport
data class ReconnectConfig(
    val baseMs: Long = 1_000, val maxMs: Long = 30_000, val jitterMs: Long = 500,
    val maxAttempts: Int = 5, val probePingTimeoutMs: Long = 2_000,
)
/** jitter param injectable for deterministic tests (prod passes Random). */
fun computeBackoffMs(attempt: Int, cfg: ReconnectConfig, jitter: Double): Long {
    val exp = cfg.baseMs * (1L shl (attempt - 1).coerceIn(0, 30))
    val capped = minOf(exp, cfg.maxMs)
    return capped + (jitter * cfg.jitterMs).toLong()
}
```
Also define constants `WS_NORMAL_CLOSURE=1000`, `WS_AUTH_TIMEOUT_CODE=4001`, `WS_READY_TIMEOUT_CODE=4002`, `STALE_RESUME_CHECK_MS=200L`, `AUTH_TIMEOUT_MS=10_000L`, `READY_TIMEOUT_MS=10_000L` in `SdkStatus.kt`.
- [ ] **Step 4: green. Step 5: commit.**

---

## Task B1: Platform shim interfaces + commonTest fakes

**Files:** `transport/WebSocketEngine.kt`, `secure/SecureTokenStore.kt`, `util/Clock.kt` (expect) + `commonTest/.../fakes/`

- [ ] **Step 1: define expect/interface surfaces** (data in/out only — no platform types):
```kotlin
// WebSocketEngine.kt — commonMain
package io.sentient.mobilesdk.transport
import kotlinx.coroutines.flow.Flow
sealed class WsIncoming {
    data class Text(val data: String) : WsIncoming()
    data class Binary(val data: ByteArray) : WsIncoming()
    data class Closed(val code: Int, val reason: String) : WsIncoming()
    data class Failure(val error: String) : WsIncoming()
}
interface WebSocketSession {
    val incoming: Flow<WsIncoming>
    suspend fun sendText(text: String)
    suspend fun sendBinary(bytes: ByteArray)
    suspend fun close(code: Int, reason: String)
}
interface WebSocketEngine {
    /** Opens a WS to [url]. allowSelfSigned scopes the dev-host TLS bypass (debug only). */
    suspend fun open(url: String, allowSelfSignedDevHost: Boolean): WebSocketSession
}
```
```kotlin
// SecureTokenStore.kt — commonMain
package io.sentient.mobilesdk.secure
interface SecureTokenStore {
    fun save(token: String)
    fun load(): String?
    fun clear()
}
```
```kotlin
// Clock.kt — commonMain
package io.sentient.mobilesdk.util
fun interface Clock { fun nowMs(): Long }
```
- [ ] **Step 2: commonTest fakes** — `FakeWebSocketEngine` (scriptable incoming queue + records sent frames), `InMemoryTokenStore`, `FixedClock`. These let the orchestrator + connectors be tested with NO platform.
- [ ] **Step 3: commit** `git commit -am "feat(mobile-sdk): platform shim interfaces (WS engine, token store, clock) + test fakes"`

---

## Task B2: Ktor WebSocket engine actuals + dev TLS bypass

**Files:** `androidMain/.../transport/WebSocketEngine.android.kt` (OkHttp), `iosMain/.../transport/WebSocketEngine.ios.kt` (Darwin); build deps already present.

- [ ] **Step 1** Implement `WebSocketEngine` on each platform using Ktor `HttpClient(OkHttp){ install(WebSockets) }` / `HttpClient(Darwin){…}`. Map Ktor frames → `WsIncoming`. Expose `incoming` as a `Flow` (channelFlow over the session's `incoming` channel). `binaryType` = arraybuffer equivalent (Ktor gives `Frame.Binary`).
- [ ] **Step 2: dev TLS bypass, scoped (debug + dev host only)** — Android OkHttp engine: when `allowSelfSignedDevHost` (true only for debug builds dialing localhost/10.0.2.2), install a debug-only trust-all `X509TrustManager` + hostname verifier. iOS Darwin engine: `#if DEBUG`-equivalent — configure the engine's URLSession delegate to trust the dev host's self-signed cert. **Release path passes `allowSelfSignedDevHost = false`** → system trust validates the pi's real cert. The flag is set by the app (debug BuildConfig / `#if DEBUG`), not hardcoded in the SDK.
- [ ] **Step 3** Add `@live`-tagged engine smoke (commonTest can't reach network on all targets; put an Android instrumented or a JVM-host quick check is out of scope) — instead verify via the orchestrator `@live` test in Task C8.
- [ ] **Step 4: commit** `git commit -m "feat(mobile-sdk): Ktor WS engine (OkHttp/Darwin) + scoped debug TLS bypass"`

---

## Task B3: SecureTokenStore actuals

**Files:** `androidMain/.../secure/SecureTokenStore.android.kt` (EncryptedSharedPreferences or, if the AndroidX Security lib is deprecated/unavailable, the Keystore-backed approach noted in details), `iosMain/.../secure/SecureTokenStore.ios.kt` (Keychain via `Security` framework).

- [ ] **Step 1** Android: store under a dedicated prefs file, key `sentient.auth.token`. iOS: Keychain `kSecClassGenericPassword`, service `io.sentient.app`, account `auth.token`.
- [ ] **Step 2** Each `actual` constructed with the platform context (Android needs `Context`; provide via the SdkConfig platform-init hook — see Task C7). Keep platform lifecycle in the actual; no business logic.
- [ ] **Step 3: commit** `git commit -m "feat(mobile-sdk): SecureTokenStore (Keychain / encrypted prefs)"`

---

## Task C1: Auth HTTP client

**Files:** `auth/AuthClient.kt`, `auth/AuthModels.kt` + `commonTest/.../auth/AuthClientTest.kt` (Ktor MockEngine — pin exact request/response shapes).

- [ ] **Step 1: failing test (contract — keep)** using Ktor `MockEngine`:
  - `listUsers()` GETs `/api/v1/auth/users` → parses `{users:[{userId,displayName,avatarTint}]}`.
  - `login(userId, pin)` POSTs `/api/v1/auth/login` body `{userId,pin}` → `{token,user}`; on 401 returns a typed `AuthError("invalid-credentials")`.
  - `me(token)` GETs `/api/v1/auth/me` with `Authorization: Bearer <token>` → `{token,user}` (refreshed).
- [ ] **Step 2: fail. Step 3: implement** with `HttpClient` + `ContentNegotiation(Json)`. DTOs in `AuthModels.kt`:
```kotlin
@Serializable data class UsersResponse(val users: List<AuthUserLite>)
@Serializable data class AuthUserLite(val userId: String, val displayName: String, val avatarTint: String = "")
@Serializable data class LoginRequest(val userId: String, val pin: String)
@Serializable data class AuthResponse(val token: String, val user: AuthUser)
```
Return a `Result`-style union (per error-handling rule — no throwing from business logic; map HTTP failures to typed results). The HTTP client is constructed with the same `WebSocketEngine`-style platform engine OR a separate Ktor `HttpClient` per platform (OkHttp/Darwin) — reuse the engine factory. Base URL derived from gateway URL (`wss://host/api/v1/ws` → `https://host/api/v1`).
- [ ] **Step 4: green. Step 5: commit.**

---

## Task C2: WS transport + reconnect controller + session-resume

**Files:** `transport/WsTransport.kt`, `transport/ReconnectController.kt`, `transport/SessionResume.kt` + tests.

- [ ] **Step 1: failing tests**
  - `SessionResume`: `buildConnectUrl(base, storedId)` appends `?session_id=`; `setCurrentSessionId` clears pending; stale-resume detection (snapshot without preceding switch within `STALE_RESUME_CHECK_MS`) clears the stored id. (Port `sdk-reconnect.test.ts` / `cross-tab-sync.test.ts` resume cases.) Storage is injected (`SecureTokenStore`-like `SessionIdStore` interface or reuse a small KV) — NOT sessionStorage. Use an injected `SessionIdStore { get/set/clear }` with an in-memory fake in tests; the actual persists to platform prefs.
  - `ReconnectController`: drives `connect` thunk with `computeBackoffMs` delays via an injected delay fn; stops after `maxAttempts`; on auth error returns immediately (no retry) and signals `onAuthExpired`; on exhaustion signals `onConnectionLost`.
- [ ] **Step 2: fail. Step 3: implement.** `WsTransport` wraps `WebSocketEngine.open(...)`, exposes `send(ClientMessage)` (encodes via `WireJson`), `sendBinary(ByteArray)`, and an incoming `Flow<ServerMessage>` (decodes Text frames; passes Binary frames separately for audio). Reconnect/resume mirror `sdk-reconnect.ts` semantics with the constants from A9. Log every transition.
- [ ] **Step 4: green. Step 5: commit.**

---

## Task C3: Message router

**Files:** `transport/MessageRouter.kt` + test.

- [ ] **Step 1: failing test** — given a list of registered connectors (fakes), routing a decoded `ServerMessage` invokes the right connector handler(s); unknown frames are ignored without error.
- [ ] **Step 2: fail. Step 3: implement** — router holds the connector list, dispatches each `ServerMessage` to connectors that handle it (each connector exposes `handle(msg: ServerMessage)`). Binary audio frames route to `AssistantAudioResponseConnector` only.
- [ ] **Step 4: green. Step 5: commit.**

---

## Task C4: Connectors — text + conversation + inflight + cognition

> Each connector mirrors its web-sdk counterpart's wire types + transition table (R6). Group these four (the text-chat-critical set) into one task with a test per connector.

**Files:** `connectors/Connector.kt`, `UserTextInputConnector.kt`, `ConversationHistoryConnector.kt`, `InFlightMessageConnector.kt`, `CognitionStatusConnector.kt` + tests.

- [ ] **Step 1: failing tests (contract — keep all)**
  - `UserTextInput`: `sendText("hi")` → transport receives `ClientMessage.TextInput("hi")`.
  - `ConversationHistory`: `conversation.snapshot` replaces mirror + fires `onSnapshot`; `conversation.entry` appends + fires `onEntry`; after `session.switched`, entries are dropped until the next snapshot (`awaitingSnapshot` gate).
  - `InFlightMessage`: `cycle.started`→empty buffer (thinking placeholder); `message.delta`→append; `message.done`→clear; `cycle.aborted`→clear.
  - `CognitionStatus`: `cycle.started`→THINKING; `cycle.completed`→IDLE; `cycle.aborted`→IDLE.
- [ ] **Step 2: fail. Step 3: implement** the `Connector` base + four connectors. `Connector`:
```kotlin
package io.sentient.mobilesdk.connectors
import io.sentient.mobilesdk.protocol.ServerMessage
interface Connector {
    val capability: String
    fun handle(msg: ServerMessage)
}
```
Each connector takes its callbacks + a `send: (ClientMessage) -> Unit` where it emits. Port transition tables verbatim from the web-sdk files.
- [ ] **Step 4: green. Step 5: commit** `git commit -m "feat(mobile-sdk): text/conversation/inflight/cognition connectors"`

---

## Task C5: Connectors — preferences + tasks + sessions

**Files:** `connectors/PreferencesConnector.kt`, `TaskStatusConnector.kt`, `SessionsConnector.kt` + tests.

- [ ] **Step 1: failing tests (contract — keep)**
  - `Preferences`: `patch({ttsEnabled:false})` → transport `UserPreferencesPatch(ttsEnabled=false)`; `session.preferences.changed` updates `current()`; `seed()` sets without emit.
  - `TaskStatus`: `task.update` registers/updates by `taskId`; `list()` sorted by `startedAtMs` ascending.
  - `Sessions`: `list/search/delete/rename/switchTo/newChat` send the right frame with a `requestId`; the matching `*.result` resolves the suspend call by `requestId`; timeout (default 5000ms, injected delay) fails the call; broadcast frames (`sessions.deleted`, `session.created`, `session.switched`) fire `onSessionsChanged`.
- [ ] **Step 2: fail. Step 3: implement.** SessionsConnector uses suspend + a requestId→CompletableDeferred map; generate requestId without `Math.random`/`Date` — use an injected id generator (a counter or UUID via `kotlin.uuid` if stable on all targets; else inject `() -> String`). Timeout via `withTimeout`.
- [ ] **Step 4: green. Step 5: commit.**

---

## Task C6: Connectors — audio input + assistant audio response (logic only)

> Audio I/O hardware is P-voice. Here, only the connector logic (wire frames + lifecycle/flags) is ported; the adapters are stubbed via the `AudioCaptureAdapter`/`AudioPlaybackAdapter` interfaces (defined now, `actual`s in P-voice).

**Files:** `connectors/UserAudioInputConnector.kt`, `connectors/AssistantAudioResponseConnector.kt`, `audioio/AudioCaptureAdapter.kt` (expect interface), `audioio/AudioPlaybackAdapter.kt` (expect interface) + tests.

- [ ] **Step 1: failing tests (contract — keep)**
  - `UserAudioInput`: `startStreaming()`→`audio.start`; `sendAudioFrame(bytes)`→transport binary; `stopStreaming()`→`audio.end`; `connector.transcript.final`→`onTranscript(text)`.
  - `AssistantAudioResponse`: `connector.audio.start`→`onAudioStart(cycleId)` + `isReceiving=true`; binary frame while receiving + !cancelled → `onAudioFrame`; `connector.audio.done`→`onAudioDone`; `playback.stop`→`onPlaybackStop(reason,cycleId)` + drops frames until next start (`isCancelled`).
- [ ] **Step 2: fail. Step 3: implement** the two connectors + the adapter interfaces:
```kotlin
// AudioCaptureAdapter.kt — commonMain interface (actual impl in P-voice)
package io.sentient.mobilesdk.audioio
import kotlinx.coroutines.flow.Flow
interface AudioCaptureAdapter {
    /** Emits PCM16 LE frames at [sampleRate] (16000) once started. */
    fun frames(sampleRate: Int): Flow<ByteArray>
    suspend fun start(sampleRate: Int)
    suspend fun stop()
}
// AudioPlaybackAdapter.kt — commonMain interface
package io.sentient.mobilesdk.audioio
interface AudioPlaybackAdapter {
    suspend fun start(sampleRate: Int)
    fun enqueue(pcm16: ByteArray)
    suspend fun stop()
    fun clear()
}
```
- [ ] **Step 4: green. Step 5: commit.**

---

## Task C7: SentientSdk orchestrator + SdkState + SdkConfig

**Files:** `sdk/SentientSdk.kt`, `sdk/SdkConfig.kt`, `sdk/SdkState.kt` + `commonTest/.../sdk/SentientSdkTest.kt`

- [ ] **Step 1: failing test (FSM/integration — keep)** using `FakeWebSocketEngine`:
  - `connect()`: status `DISCONNECTED→CONNECTING→AUTHENTICATING`; engine emits `auth.ok` then `session.ready` → status `READY`; transport sent `auth` then `session.configure(clientType="webui")`.
  - `sendText("hi")` while READY → transport `text.input`.
  - server `conversation.entry(assistant)` → `state.value.messages` contains it.
  - `message.delta`/`message.done` → inflight reflected in `state.value.messages` then committed.
  - `auth.error` → status `ERROR`, `state.value.authExpired=true`.
  - `disconnect()` → status `DISCONNECTED`, idempotent.
- [ ] **Step 2: fail. Step 3: implement.**

`SdkConfig.kt`:
```kotlin
package io.sentient.mobilesdk.sdk
import io.sentient.mobilesdk.transport.ReconnectConfig
data class SdkConfig(
    val gatewayWsUrl: String,             // wss://host/api/v1/ws
    val allowSelfSignedDevHost: Boolean,  // debug only
    val capabilities: List<String>,       // mirror webui session.configure supports
    val reconnect: ReconnectConfig = ReconnectConfig(),
)
```
`SdkState.kt` — the single observable surface (R5):
```kotlin
package io.sentient.mobilesdk.sdk
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.transport.SdkStatus

enum class CognitionState { IDLE, THINKING, ACTING }
enum class VoiceMode { OFF, ACTIVE }

data class ChatMessage(
    val ts: Long, val role: String,      // "user" | "assistant" | "tool" | "trigger"
    val content: String, val streaming: Boolean = false,
    val cutoffKind: String? = null,      // "barge-in" | "interrupt"
)

data class SdkState(
    val status: SdkStatus = SdkStatus.DISCONNECTED,
    val messages: List<ChatMessage> = emptyList(),
    val transcript: String = "",          // live STT preview
    val cognition: CognitionState = CognitionState.IDLE,
    val voiceMode: VoiceMode = VoiceMode.OFF,
    val prefs: AudioPreferences = AudioPreferences.DEFAULT,
    val tasks: List<TaskSnapshotItem> = emptyList(),
    val isSpeaking: Boolean = false,      // TTS playback active
    val connectionLost: Boolean = false,
    val authExpired: Boolean = false,
)
```
`SentientSdk.kt` exposes:
```kotlin
val state: StateFlow<SdkState>
suspend fun connect()
fun disconnect()
fun sendText(text: String)
fun interrupt()
fun startMic()    // P-voice wires the pipeline; in P-text it flips voiceMode + audio.start
fun stopMic()
suspend fun setTtsEnabled(enabled: Boolean)
// sessions passthrough
suspend fun listSessions(limit: Int, offset: Int): SessionsPage
suspend fun switchSession(sessionId: String)
suspend fun newChat()
suspend fun deleteSession(id: String); suspend fun renameSession(id: String, title: String)
```
The orchestrator owns: the coroutine scope (cancelled on `disconnect`), the connector set, the message router, the reconnect controller, and the `SdkState` derivation (mirrors webui `deriveMessages` + `voice-status.ts` — committed entries + inflight streaming + cognition + isSpeaking). Keep `SentientSdk.kt` under 300 lines — extract derivation into `sdk/StateDeriver.kt` and the auth+configure handshake into `sdk/Handshake.kt` if needed.

Platform init: a top-level `expect fun createPlatformBundle(): PlatformBundle` providing `WebSocketEngine`, `SecureTokenStore`, `SessionIdStore`, `Clock`, `AudioCaptureAdapter`, `AudioPlaybackAdapter`. Android's `actual` needs a `Context` — set it via `MobileSdk.initAndroid(context)` called from `SentientApp.onCreate` before `createPlatformBundle`. iOS needs no init.
- [ ] **Step 4: green. Step 5: commit** `git commit -m "feat(mobile-sdk): SentientSdk orchestrator + single SdkState surface"`

---

## Task C8: `@live` text round-trip + Phase-1 gate

**Files:** `commonTest`/an instrumented or host check is limited on KMP; use an Android instrumented `@live` OR a manual driver. Pragmatic: a small JVM-target `main` or an androidTest. Given KMP constraints, implement as an **androidUnitTest `@live` test** gated on an env flag, OR document a manual `adb`/sim run. Prefer: a tiny throwaway `connect→sendText("hello")→assert assistant entry` against `wss://10.0.2.2:8888` run from an Android instrumented test.

- [ ] **Step 1** Ensure local stack up: `cd deploy/macos && docker compose up -d gateway && cd ../..`; `curl -sk https://localhost:8888/api/v1/health` → `{"status":"ok"}`.
- [ ] **Step 2** Obtain a token via `AuthClient.login` against a seeded local user (use the project's free dev credentials; see e2e-testing rule). Connect the SDK, send "hello", assert a `READY` status and an assistant `ChatMessage` arrives within a timeout. Tag `@live`, keep out of the default unit run.
- [ ] **Step 3** Run `./gradlew :shared:mobile-sdk:allTests` (unit, no network) → all green. Then run the `@live` path manually, capture the log trail (gateway logs + `adb logcat`/`os_log`), confirm cycleId correlation.
- [ ] **Step 4: commit** `git commit -m "test(mobile-sdk): @live text round-trip on local stack (P1 gate)"`

**Phase-1 e2e rows** (in `qa/mobile/text-matrix.md`): S1 all unit/contract tests green; S2 `@live` text round-trip READY + assistant reply + clean log trail.

---

# PHASE 2 — Text chat UI (Android ‖ iOS)

> Both platforms consume the same `SdkState`. **The Android track (D-A*) and iOS track (D-I*) are fully independent — run them in parallel.** Each screen task ends with its e2e row green (Maestro / android CLI). Design tokens (Task D0) gate both.

## Task D0: Design tokens (commonMain constants)

**Files:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt` + (optional) split `Colors.kt`, `Spacing.kt`, `Typography.kt`.

- [ ] **Step 1** Encode the dusk palette + scales verbatim from webui `tokens/*.css`. Colors as ARGB hex longs (so both Compose `Color(0xFF…)` and Swift can read). Example:
```kotlin
package io.sentient.mobilesdk.design

object Colors {
    const val bg = 0xFF2B2621uL.toLong()
    const val bgElev = 0xFF332D28uL.toLong()
    const val bgSunk = 0xFF241F1BuL.toLong()
    const val paper = 0xFF39322CuL.toLong()
    const val line = 0xFF4A4138uL.toLong()
    const val lineSoft = 0xFF3E362FuL.toLong()
    const val ink = 0xFFF2E8D6uL.toLong()
    const val ink2 = 0xFFD7C6ABuL.toLong()
    const val ink3 = 0xFF9E907EuL.toLong()
    const val ink4 = 0xFF706456uL.toLong()
    const val accent = 0xFFF2A06AuL.toLong()
    const val accent50 = 0xFF402C22uL.toLong()
    const val amber = 0xFFE9B168uL.toLong()
    const val sage = 0xFFB9C8A6uL.toLong()
    const val sageSoft = 0xFF3A4232uL.toLong()
    const val clay = 0xFF9A5A3EuL.toLong()
    const val ok = 0xFF5F8A5BuL.toLong()
    const val warn = 0xFFC2892FuL.toLong()
    const val stop = 0xFFB8442EuL.toLong()
}
object Space { const val xs=4; const val sm=8; const val md=12; const val lg=18; const val xl=26; const val xxl=32; const val xxxl=40; const val padMsg=18; const val gapMsg=32; const val msgMax=720 }
object Radii { const val sm=8; const val md=12; const val lg=18; const val xl=26; const val pill=999 }
object TypeScale { const val xs=11.0; const val sm=12.5; const val base=15.0; const val lg=18.0; const val xl=22.0; const val display=44.0; const val lineTight=1.25; const val lineNormal=1.55; const val lineRelaxed=1.6 }
object Motion { const val fastMs=150; const val normalMs=250; const val waveMs=3400; const val cursorMs=1000 }
object Tints { // avatarTint key → bg color long
    val map = mapOf("terra" to Colors.accent50, "sage" to Colors.sageSoft, "amber" to Colors.amber, "clay" to Colors.clay)
}
```
- [ ] **Step 2** No test (pure constants — per testing rule, don't test constants). Verify it compiles into the XCFramework (constants are exposed to Swift via SKIE).
- [ ] **Step 3: commit** `git commit -m "feat(mobile-sdk): dusk design tokens as shared constants"`

---

## Task D-A1: Android theme + SDK bridge (ViewModel)

**Files:** `android/src/main/kotlin/io/sentient/android/SentientApp.kt`, `theme/Theme.kt`, `theme/Tokens.kt`, `sdk/SdkHolder.kt`, `sdk/SdkViewModel.kt`. Modify `android/build.gradle.kts` (add `androidx.lifecycle:lifecycle-viewmodel-compose`, `org.jetbrains.kotlinx:kotlinx-coroutines-android` to catalog + deps; add Material3 properly — carry-forward from P0 theme deviation).

- [ ] **Step 1** Map `DesignTokens` → a Compose `darkColorScheme` + a `SentientTheme {}` wrapper exposing `Tokens` (spacing/type/radius) via a `CompositionLocal`.
- [ ] **Step 2** `SdkHolder` — process singleton building `SentientSdk` from `SdkConfig` (gateway URL from a debug `BuildConfig` field `GATEWAY_WS_URL = "wss://10.0.2.2:8888/api/v1/ws"`, `allowSelfSignedDevHost = BuildConfig.DEBUG`). Call `MobileSdk.initAndroid(applicationContext)` in `SentientApp.onCreate`.
- [ ] **Step 3** `SdkViewModel` exposes `sdk.state` as Compose `State` via `collectAsStateWithLifecycle`; forwards commands.
- [ ] **Step 4** No unit test (DI/wiring — per testing rule). Build: `./gradlew :android:assembleDebug` → SUCCESS.
- [ ] **Step 5: commit.**

## Task D-A2: Android Login (avatar grid + PIN)

**Files:** `auth/LoginScreen.kt`, `auth/AvatarTile.kt`, `auth/PinPad.kt`, `auth/AuthViewModel.kt`. testTags: `login-avatar-<userId>`, `pin-key-<n>`, `pin-delete`, `login-error`.

- [ ] **Step 1** `AuthViewModel`: `loadUsers()` via `AuthClient.listUsers`; `login(userId, pin)` → on success save token to `SecureTokenStore` + connect SDK + navigate to chat; on 401 surface `login-error`. Auto-submit at 4 digits.
- [ ] **Step 2** UI: avatar grid (56dp circles, tint from `Tints.map`, initial letter), PIN screen = selected name + 4 dots + 3×4 numpad (keys 64×48dp). Use exact tokens. 48dp min tap targets.
- [ ] **Step 3** Build + drive: `android run` install, then a documented android-CLI flow: `android screen resolve` tap an avatar → tap pins → assert chat visible. Capture screenshot.
- [ ] **Step 4: commit.**

## Task D-A3: Android Chat (list + composer, text)

**Files:** `chat/ChatScreen.kt`, `chat/MessageList.kt`, `chat/MessageBubble.kt`, `chat/Composer.kt`, `chat/SentientMark.kt`. testTags: `chat-message-list`, `chat-input`, `chat-send`, `chat-interrupt`, `chat-tts-toggle`, `message-bubble-<index>`.

- [ ] **Step 1** Bind to `SdkState.messages`. Bubbles: assistant = `paper` bg + top-left radius 6dp; user = sage-mix bg + top-right radius 6dp; 1dp `lineSoft` border; markdown text (use a lightweight Compose markdown or plain text v1 — plain text acceptable for v1, note follow-up). Streaming message shows a pulse-dot. `imePadding()` on the composer (keyboard avoidance — spec §6.1).
- [ ] **Step 2** Composer: text field + send (disabled when empty or `status != READY`); interrupt button visible when `cognition != IDLE || isSpeaking`. Mic/TTS buttons present but mic is wired in P-voice (TTS toggle calls `setTtsEnabled`).
- [ ] **Step 3** Auto-scroll to latest. Safe-area insets (`safeDrawingPadding`). Title-only top bar (drop breadcrumbs — §6.1).
- [ ] **Step 4** e2e (android CLI): login → type "hello" in `chat-input` → tap `chat-send` → assert an assistant `message-bubble` appears. Local stack up.
- [ ] **Step 5: commit.**

## Task D-A4: Android History drawer

**Files:** `history/HistoryDrawer.kt`. testTags: `history-open`, `history-search`, `history-row-<sessionId>`, `history-new-chat`.

- [ ] **Step 1** ModalNavigationDrawer (native, replaces webui 360px drawer). List from `sdk.listSessions`; search filters; tap row → `sdk.switchSession`; long-press → rename/delete; New Chat → `sdk.newChat`. Reconnect-safe (broadcast updates via SessionsConnector).
- [ ] **Step 2** e2e: open drawer → assert ≥1 row after a prior chat → switch → assert messages reload.
- [ ] **Step 3: commit.**

## Task D-A5: Android Settings (thin)

**Files:** `settings/SettingsScreen.kt`. testTags: `settings-version`, `settings-logout`.

- [ ] **Step 1** Native push-nav list: app version (from `BuildConfig.VERSION_NAME`) + logout (clear token, `sdk.disconnect`, nav to login). Design-in a version-check hook stub (no network yet — spec §12.2 P2 carry).
- [ ] **Step 2** e2e: open settings → assert version string → logout → assert login screen.
- [ ] **Step 3: commit.**

## Task D-A6: Android text e2e matrix pass

- [ ] Run the full Android text matrix (login happy + bad-PIN sad; send/receive; reconnect by toggling gateway; history switch; settings logout) at 390-equivalent (Pixel_3a) viewport. Mark rows in `qa/mobile/text-matrix.md`. Capture screenshots under `.playwright-mcp/` equivalent `qa/mobile/screens/`. Commit.

---

## Task D-I1: iOS theme + SDK bridge (SdkStore)

**Files:** `ios/App/Theme/Tokens.swift`, `Theme/Colors.swift`, `SDK/SdkStore.swift`, update `RootView.swift`/`SentientApp.swift`. Update `ios/project.yml` if new files/config needed; ensure XCFramework path matches the built config.

- [ ] **Step 1** `Colors.swift`: map `MobileSdk`'s `Colors` constants (SKIE-exposed) → SwiftUI `Color` (ARGB long → `Color(.sRGB, red,green,blue, opacity)`). Tokens.swift mirrors Space/Radii/TypeScale.
- [ ] **Step 2** `SdkStore: ObservableObject` — subscribes to the SDK's `state` (SKIE turns `StateFlow<SdkState>` into an `AsyncSequence`; consume in a `Task` and republish `@Published var state`). Build `SentientSdk` from config (gateway `wss://localhost:8888/api/v1/ws`, `allowSelfSignedDevHost` = `#if DEBUG`).
- [ ] **Step 3** Build for the 26.5 sim: `xcodegen generate && xcodebuild -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 14 Pro (26.5)' build` → SUCCEEDED.
- [ ] **Step 4: commit.**

## Task D-I2: iOS Login (avatar grid + PIN)

**Files:** `Auth/LoginView.swift`, `Auth/AvatarTile.swift`, `Auth/PinPad.swift`. accessibilityIdentifiers mirror Android: `login-avatar-<userId>`, `pin-key-<n>`, `pin-delete`, `login-error`.

- [ ] **Step 1** Mirror D-A2 logic against `SdkStore` + `AuthClient` (SKIE async). OS-numpad-style 3×4 grid (spec D7 — native feel). Auto-submit at 4 digits.
- [ ] **Step 2** e2e (Maestro `qa/mobile/text-ios.yaml`): tap avatar id → tap pin keys → assertVisible chat. Run on iPhone 14 Pro (26.5).
- [ ] **Step 3: commit.**

## Task D-I3: iOS Chat (list + composer, text)

**Files:** `Chat/ChatView.swift`, `Chat/MessageList.swift`, `Chat/MessageBubble.swift`, `Chat/Composer.swift`, `Chat/SentientMark.swift`. ids: `chat-message-list`, `chat-input`, `chat-send`, `chat-interrupt`, `chat-tts-toggle`, `message-bubble-<index>`.

- [ ] **Step 1** Mirror D-A3 against `SdkStore.state`. Keyboard-safe composer (SwiftUI `.safeAreaInset(edge:.bottom)` + keyboard avoidance). Safe-area insets honored. Title-only nav bar. Dark status-bar content.
- [ ] **Step 2** Bubbles styled from tokens (paper / sage-mix, corner radii, border). Plain text v1 (markdown follow-up noted).
- [ ] **Step 3** e2e (Maestro): login → type "hello" → tap send → assertVisible an assistant bubble. Local stack up.
- [ ] **Step 4: commit.**

## Task D-I4: iOS History sheet

**Files:** `History/HistorySheet.swift`. ids: `history-open`, `history-search`, `history-row-<sessionId>`, `history-new-chat`.

- [ ] **Step 1** Native `.sheet` (replaces webui drawer). Same SDK session ops as D-A4.
- [ ] **Step 2** e2e: open → row present → switch → messages reload.
- [ ] **Step 3: commit.**

## Task D-I5: iOS Settings (thin)

**Files:** `Settings/SettingsView.swift`. ids: `settings-version`, `settings-logout`.

- [ ] **Step 1** Version (from bundle `CFBundleShortVersionString`) + logout. Version-check hook stub.
- [ ] **Step 2** e2e: settings → version → logout → login screen.
- [ ] **Step 3: commit.**

## Task D-I6: iOS text e2e matrix pass

- [ ] Run the iOS text matrix (mirror D-A6) on iPhone 14 Pro (26.5) via Maestro. Mark rows in `qa/mobile/text-matrix.md`. Screenshots. Commit.

**Phase-2 e2e rows** (`qa/mobile/text-matrix.md`): per platform — T1 login happy, T2 login bad-PIN, T3 send/receive text, T4 reconnect (toggle gateway container), T5 history switch, T6 settings logout. Each × {Android emu, iOS 26.5 sim}.

---

# PHASE 3 — Voice (Android ‖ iOS)

> Wires native audio through the already-ported gates/codec. SDK gate/codec logic is done (Phase 1); this phase adds the platform audio `actual`s + the pipeline + the voice UX. **Real mic / AEC / barge-in need a physical device → flagged as user-loop rows; sim rows cover UI/connect/transcript with a fake/simulated mic.**

## Task E1: AudioCaptureAdapter actuals

**Files:** `androidMain/.../audioio/AudioCaptureAdapter.android.kt` (AudioRecord, `MediaRecorder.AudioSource.VOICE_COMMUNICATION`, 16k mono PCM16, `AcousticEchoCanceler` if available), `iosMain/.../audioio/AudioCaptureAdapter.ios.kt` (AVAudioEngine input tap, voice-processing IO, 16k). Android needs `RECORD_AUDIO` permission; iOS needs `NSMicrophoneUsageDescription` + `AVAudioSession .playAndRecord` voiceChat mode.

- [ ] **Step 1** Implement capture emitting PCM16 LE frames at 16000 (resample on-device if the hardware rate is 44.1/48k — spec §4 RISK). Frame size ≈ `frameDurationMs` from SpeechGate config.
- [ ] **Step 2** Wire OS AEC: Android `AcousticEchoCanceler.create(audioSession)`; iOS `setVoiceProcessingEnabled(true)` on the input node. Log AEC availability (WARN fallback if unavailable).
- [ ] **Step 3** Add manifest permission (Android) + Info.plist usage string (iOS, debug+release). Maestro/`simctl privacy grant microphone` for sim; `android` CLI grant for emulator.
- [ ] **Step 4: commit.**

## Task E2: AudioPlaybackAdapter actuals

**Files:** `androidMain/.../audioio/AudioPlaybackAdapter.android.kt` (AudioTrack, streaming, 48k), `iosMain/.../audioio/AudioPlaybackAdapter.ios.kt` (AVAudioEngine + AVAudioPlayerNode, scheduleBuffer). Ring buffer sized like webui (~2s) — but stream by default per decorator rule.

- [ ] **Step 1** Implement `start/enqueue(pcm16)/clear/stop`. Decode downlink: read `connector.audio.start.encoding`; **assert `== "pcm16"`** for v1 (R2) — if `opus`, log a WARN and flag (opus decode deferred). Resample 48k→device rate if needed.
- [ ] **Step 2** `clear()` on barge-in/interrupt drops queued buffers immediately.
- [ ] **Step 3: commit.**

## Task E3: AudioPipeline wiring + audio FSM

**Files:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/audioio/AudioPipeline.kt`, `sdk/AudioFsm.kt` + tests (FSM/invariant — keep).

- [ ] **Step 1: failing test** for the audio FSM (`inactive→listening→user-speaking→processing→assistant-speaking→interrupting`), driven by typed inputs (mic onset, transcript final, cycle start/done, audio start/done, interrupt). Pure → testable with no device.
- [ ] **Step 2: fail. Step 3: implement.** Pipeline (uplink): `capture.frames(16000)` → per frame compute `isSpeech` (the local stack does server-side VAD/Smart-Turn, so the client SpeechGate uses RMS-energy as the `isSpeech` proxy OR forwards continuously after `audio.start` — **mirror webui**: webui streams continuously while voiceMode active and lets server VAD decide; the SpeechGate/EchoGate gate the uplink to suppress echo). Apply EchoGate (RMS vs playback threshold) → AudioPreRollRing → `UserAudioInputConnector.sendAudioFrame`. Downlink: `AssistantAudioResponseConnector.onAudioFrame` → `AudioPlaybackAdapter.enqueue`; `onAudioStart`→`echoGate.onPlaybackStart`; `onAudioDone`→`echoGate.onPlaybackDrain`; `onPlaybackStop`→`echoGate.onPlaybackCancel` + `playback.clear()`. The pipeline updates `SdkState.isSpeaking` + the audio FSM feeds `SdkState` (listening/processing/speaking) consumed by both UIs.
- [ ] **Step 4** `startMic()`/`stopMic()` on `SentientSdk` now start/stop the pipeline + capture + `audio.start`/`audio.end`. Log every gate decision + FSM transition with cycleId/utteranceId.
- [ ] **Step 5: green. Step 6: commit** `git commit -m "feat(mobile-sdk): voice pipeline (capture→gate→uplink, downlink→playback) + audio FSM"`

## Task E4: Barge-in

**Files:** modify `AudioPipeline.kt` / `SentientSdk.kt` + test.

- [ ] **Step 1: failing test** — mic-onset (gate opens) while `isSpeaking` → `interrupt()` fired (abort cycle + clear playback), but tasks not cancelled (barge-in vs UI-stop split per architecture).
- [ ] **Step 2: implement** mic-onset detection → `interrupt()` (sends `interrupt` frame; gateway responds `playback.stop reason="barge-in"`). Distinguish from UI Stop (which is `interrupt()` too but the gateway routes task-cancel) — client just calls `interrupt()`; the gateway owns the split.
- [ ] **Step 3: green. Step 4: commit.**

## Task E5: Voice UX — both platforms (‖)

**Files:** Android `chat/Composer.kt`/`SentientMark.kt`/`MessageBubble.kt`; iOS `Chat/Composer.swift`/`SentientMark.swift`/`MessageBubble.swift`.

- [ ] **Step 1 (Android ‖ iOS)** Mic button toggles `startMic`/`stopMic`; `mic-on` styling (accent bg) when `voiceMode==ACTIVE`. SentientMark avatar states (idle/listening/thinking/speaking) bound to the audio FSM / `cognition` / `isSpeaking` — port the animation intent from webui (`avatar-ripple`, nucleus pulse, speaking-wave 3.4s) using platform animation (Compose `rememberInfiniteTransition`, SwiftUI `.animation`). Live transcript preview bound to `SdkState.transcript`. Interrupt button drives `interrupt()`.
- [ ] **Step 2** Per the event-driven-UX rule: every animation/state maps to an SDK-emitted state; no free-running loops when idle.
- [ ] **Step 3** Sim e2e: enter voice mode → assert listening UI; inject a simulated transcript (or use server STT with a fed audio file on the local stack if feasible) → assert transcript preview + assistant reply. Mark sim-reachable rows.
- [ ] **Step 4: commit (one per platform).**

## Task E6: Voice device user-loop + matrix

- [ ] **Step 1** Flag device-only rows in `qa/mobile/voice-matrix.md`: real-mic capture, OS AEC effectiveness, barge-in mid-TTS, background/foreground audio-session handling. These need a physical Android device (free) + iOS device (gated on $99 enrollment — spec §9). Provide the exact manual steps for the user loop.
- [ ] **Step 2** Run all sim-reachable voice rows green (UI states, connect, simulated transcript, interrupt button). Capture evidence. Commit.

**Phase-3 e2e rows** (`qa/mobile/voice-matrix.md`): V1 enter/exit voice mode UI, V2 transcript preview renders, V3 TTS playback (assistant audio → speaker), V4 interrupt button stops playback, V5 *(device)* real barge-in, V6 *(device)* AEC suppresses echo, V7 background/foreground. V1–V4 sim; V5–V7 device user-loop.

---

# FINISH

## Task F1: Full quality gate + matrices green

- [ ] **Step 1** `./gradlew :shared:mobile-sdk:allTests` green; `:android:assembleDebug` + iOS `xcodebuild` build green; SDK ktlint/detekt if configured (else skip — note).
- [ ] **Step 2** TS monorepo unmodified: `source scripts/env.sh && bun run lint && bun run typecheck` → clean (mobile dirs excluded from Biome — verify P0's `biome.json` ignores still hold; the gateway push work is NOT in this plan so no TS changes expected).
- [ ] **Step 3** All Phase-1/2/3 sim-reachable rows ✅ in `qa/mobile/{text,voice}-matrix.md`; device rows flagged for user-loop.
- [ ] **Step 4: commit + push** `git push origin feature/mobile-client`.

## Task F2: Final review + handoff

- [ ] Dispatch a final read-only code review across the whole SDK + both apps. Confirm: SDK mirrors web-sdk surface (status FSM, connectors, gates, codec, reconnect/resume), single `SdkState` surface, dumb UIs, logging coverage (every WS msg, FSM transition, gate decision with ids), no secrets in logs (sanitizer), debug-only TLS bypass. Handoff note: Plan 3 (push) + Plan 4 (deploy) unblocked.

---

## Self-Review

**Spec coverage (P1–P3 of the conversational client):**
- P1 SDK core (transport/auth/reconnect/resume/status FSM/logger/connectors) → Tasks A1–A9, B1–B3, C1–C8 ✓
- P2 text chat UI both platforms (login→chat→history→settings) → D0, D-A1..A6, D-I1..I6 ✓
- P3 voice (capture/playback shims + gates + AEC + audio FSM + barge-in) → E1–E6 ✓
- Single state surface (R5 / coroutines-flow-surface) → SdkState (Task C7) ✓
- web-sdk mirror contract (verbatim transition tables, ported tests) → A5–A9, C4–C6 each port the web-sdk test ✓
- Dev TLS bypass scoped debug+dev-host → B2 ✓
- PCM16 path + opus-deferred flag (R2) → C6, E2 ✓
- clientType="webui" (R1) → A1 SessionConfigure, C7 handshake ✓
- Auth client in SDK (R3) → C1 ✓
- Design tokens as shared constants (R4) → D0 ✓
- Logging coverage / sanitizer (security) → A3, threaded through transport/connectors/pipeline ✓
- e2e matrices as the done-contract → text-matrix, voice-matrix; device rows flagged ✓

**Out of scope (correctly deferred):** push plumbing (Plan 3 — new gateway `/push/register` + `PushSender`, confirmed nonexistent today), deployment doc + family store (Plan 4), rich settings panes, multi-account, opus codec, on-device STT.

**Placeholder scan:** SDK ports give complete code. UI tasks provide the SDK-binding code + exact token constants + exact testIDs + e2e assertions; pixel styling against the token table is the implementer's mechanical fill (not a logic placeholder). Voice E1/E2 give complete expect/actual signatures + wiring; the only true unknowns (device AEC effectiveness, opus-if-present) are explicitly flagged, not hand-waved.

**Type consistency:** `SdkState`/`ChatMessage`/`CognitionState`/`VoiceMode` (C7) used identically by both UIs. `SdkStatus` enum (A9) ↔ orchestrator transitions (C7). Connector capability strings ↔ `session.configure.capabilities.supports` (verify against webui at impl). `EchoGate.onPlaybackDrain(cycleId, nowMs)` injected-clock signature consistent across E3 wiring. `AudioCaptureAdapter`/`AudioPlaybackAdapter` interfaces (C6) ↔ actuals (E1/E2).

**Known execution risks (flag, don't block):** (1) iOS `os_log` interop may need NSLog fallback (A3 notes it). (2) AndroidX Security `EncryptedSharedPreferences` is deprecated — details file must name the chosen replacement (B3). (3) `@JsonClassDiscriminator("kind")` nested under `type` — verify kotlinx.serialization handles dual discriminators (A6); if not, decode feed items manually. (4) Sample-rate resample on-device (E1) — garbled STT if mismatched; pin in details. (5) `kotlin.uuid`/requestId generation must avoid `Math.random`/`Date` (KMP-unavailable in some contexts) — inject id generator (C5). (6) SKIE exposure of `StateFlow<SdkState>` + nested data classes — verify the Swift surface is ergonomic; flatten if SKIE struggles (C7/D-I1).
