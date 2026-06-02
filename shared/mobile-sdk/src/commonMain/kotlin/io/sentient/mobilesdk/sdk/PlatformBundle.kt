// ---------------------------------------------------------------------------
// PlatformBundle — the platform-capability set the orchestrator needs.
//
// commonMain owns the bundle SHAPE (only commonMain interfaces, no platform
// types); each target supplies the wiring via the `actual fun
// createPlatformBundle()`. Tests construct the bundle directly with fakes
// (FakeWebSocketEngine / InMemoryTokenStore / InMemorySessionIdStore /
// FixedClock), so the orchestrator runs with zero platform / hardware.
//
// Audio adapters are NULLABLE for the P-text path: E1 (capture) and E2
// (playback) supply the real `actual` adapters later. Until then the
// androidMain/iosMain actuals pass null and the orchestrator wires the text
// path without touching audio hardware. startMic/stopMic still flip voiceMode
// + send audio.start/audio.end control frames (the capture→gate→uplink Flow is
// E3) — they no-op the (absent) capture adapter for now.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AudioCaptureAdapter
import io.sentient.mobilesdk.audioio.AudioPlaybackAdapter
import io.sentient.mobilesdk.secure.SecureTokenStore
import io.sentient.mobilesdk.secure.SessionIdStore
import io.sentient.mobilesdk.transport.WebSocketEngine
import io.sentient.mobilesdk.util.Clock

/**
 * The platform capabilities [SentientSdk] depends on, all behind commonMain
 * boundary interfaces.
 *
 * @param engine WS transport factory (B2 actuals: OkHttp / Darwin).
 * @param tokenStore Encrypted auth-token store (B3 actuals: Keystore / Keychain).
 * @param sessionIdStore Session-resume pointer store (B3 actuals).
 * @param clock Injected wall-clock (B1). Tests pass FixedClock.
 * @param capture Mic capture adapter. NULL until E1 — text path does not need it.
 * @param playback Audio playback adapter. NULL until E2 — text path does not need it.
 */
data class PlatformBundle(
    val engine: WebSocketEngine,
    val tokenStore: SecureTokenStore,
    val sessionIdStore: SessionIdStore,
    val clock: Clock,
    val capture: AudioCaptureAdapter? = null,
    val playback: AudioPlaybackAdapter? = null,
)

/**
 * Construct the platform-specific [PlatformBundle].
 *
 * androidMain reads the application Context from AndroidContextHolder (set via
 * `MobileSdk.initAndroid(context)`); iosMain constructs the actuals directly.
 * Both pass `capture = null` / `playback = null` for the P-text path — E1/E2
 * will supply the real audio adapters.
 */
expect fun createPlatformBundle(): PlatformBundle
