// ---------------------------------------------------------------------------
// PlatformBundle — the platform-capability set the orchestrator needs.
//
// commonMain owns the bundle SHAPE (only commonMain interfaces, no platform
// types); each target supplies the wiring via the `actual fun
// createPlatformBundle()`. Tests construct the bundle directly with fakes
// (FakeWebSocketEngine / InMemoryTokenStore / FixedClock), so the orchestrator
// runs with zero platform / hardware.
//
// Audio engine is NULLABLE for the text path. The androidMain/iosMain actuals
// supply the real VoiceAudio (mic + playback on a single platform engine); tests
// pass null and the orchestrator wires the text path without touching audio
// hardware. When [voiceAudio] is null, startMic/stopMic still flip voiceMode +
// send audio.start/audio.end control frames with NO uplink — the
// VoiceUplinkPipeline (Task 9) only runs when a real VoiceAudio is wired.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.secure.DeviceIdStore
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.util.Clock
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
 * @param voiceAudio Single platform audio engine (mic + playback on one full-duplex
 *   device engine — Task 1–10 refactor). The orchestrator builds the
 *   VoiceUplinkPipeline + AudioPipeline only when this is non-null; NULL on the
 *   text/test path leaves startMic/stopMic as audio.start/audio.end with no uplink
 *   and no downlink playback.
 */
data class PlatformBundle(
    val engine: WebSocketEngine,
    val tokenStore: SecureTokenStore,
    val deviceIdStore: DeviceIdStore,
    val clock: Clock,
    val voiceAudio: VoiceAudio? = null,
)

/**
 * Construct the platform-specific [PlatformBundle].
 *
 * androidMain reads the application Context from AndroidContextHolder (set via
 * `MobileSdk.initAndroid(context)`); iosMain constructs the actuals directly.
 * Both wire the real VoiceAudio engine; only tests pass null.
 */
expect fun createPlatformBundle(): PlatformBundle
