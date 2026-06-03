// ---------------------------------------------------------------------------
// PlatformBundle.ios — iOS actual for createPlatformBundle().
//
// Constructs the Darwin-backed WS engine + Keychain token store +
// NSUserDefaults session-id store directly (no Context needed on iOS). The
// capture adapter is the AVAudioEngine-backed E1 actual; playback is null until
// E2. The Clock uses NSDate epoch ms.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.IosAudioCaptureAdapter
import io.sentient.mobilesdk.secure.IosSecureTokenStore
import io.sentient.mobilesdk.secure.IosSessionIdStore
import io.sentient.mobilesdk.transport.IosWebSocketEngine
import io.sentient.mobilesdk.util.Clock
import platform.Foundation.NSDate
import platform.Foundation.timeIntervalSince1970

private const val MS_PER_SECOND = 1_000.0

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = IosWebSocketEngine(),
    tokenStore = IosSecureTokenStore(),
    sessionIdStore = IosSessionIdStore(),
    clock = Clock { (NSDate().timeIntervalSince1970 * MS_PER_SECOND).toLong() },
    capture = IosAudioCaptureAdapter(), // E1: AVAudioEngine voice-processing capture
    playback = null, // E2 supplies the AVAudioEngine-backed playback adapter
)
