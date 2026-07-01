// ---------------------------------------------------------------------------
// PlatformBundle — the platform-capability set the orchestrator needs.
//
// commonMain owns the bundle SHAPE (only commonMain interfaces, no platform
// types); each target supplies the wiring via the `actual fun
// createPlatformBundle()`. Tests construct the bundle directly with fakes
// (FakeWebSocketEngine / InMemoryTokenStore / FixedClock), so the orchestrator
// runs with zero platform / hardware.
//
// Audio adapters are NULLABLE for the P-text path. The androidMain/iosMain
// actuals supply the real playback/mic adapters; tests pass null and the
// orchestrator wires the text path without touching audio hardware. When [mic] is
// null, startMic/stopMic still flip voiceMode + send audio.start/audio.end control
// frames with NO uplink — the VoiceUplinkPipeline (Task 9) only runs when a real
// MicSource is wired.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AudioPlaybackAdapter
import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.MicSource
import io.sentient.mobilesdk.voice.io.VoiceAudio

/**
 * The platform capabilities [SentientSdk] depends on, all behind commonMain
 * boundary interfaces.
 *
 * @param engine WS transport factory (B2 actuals: OkHttp / Darwin).
 * @param tokenStore Encrypted auth-token store (B3 actuals: Keystore / Keychain).
 * @param deviceIdStore Stable per-install device-id store (Task 3.10 actuals:
 *   SharedPreferences / NSUserDefaults). Tests pass an in-memory fake.
 * @param clock Injected wall-clock (B1). Tests pass FixedClock.
 * @param playback Audio playback adapter. NULL on the text path.
 * @param mic Real-time voice-uplink mic primitive (Task 7). The orchestrator builds
 *   the VoiceUplinkPipeline only when this is non-null; NULL on the text/test path
 *   leaves startMic/stopMic as audio.start/audio.end with no uplink.
 */
data class PlatformBundle(
    val engine: WebSocketEngine,
    val tokenStore: SecureTokenStore,
    val deviceIdStore: DeviceIdStore,
    val clock: Clock,
    val voiceAudio: VoiceAudio? = null,
    val playback: AudioPlaybackAdapter? = null,
    val mic: MicSource? = null,
)

/**
 * Construct the platform-specific [PlatformBundle].
 *
 * androidMain reads the application Context from AndroidContextHolder (set via
 * `MobileSdk.initAndroid(context)`); iosMain constructs the actuals directly.
 * Both wire the real capture/playback/mic adapters; only tests pass null.
 */
expect fun createPlatformBundle(): PlatformBundle
