// ---------------------------------------------------------------------------
// PlatformBundle.ios — iOS actual for createPlatformBundle().
//
// Constructs the Darwin-backed WS engine + Keychain token store directly (no
// Context needed on iOS). Playback is the AVAudioPlayerNode-backed E2 actual; the
// mic is the AVAudioEngine-backed voice-uplink actual (both on the shared engine).
// The Clock uses NSDate epoch ms.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.IosAudioPlaybackAdapter
import io.sentient.mobilesdk.secure.IosDeviceIdStore
import io.sentient.mobilesdk.secure.IosSecureTokenStore
import io.sentient.mobilesdk.transport.IosWebSocketEngine
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.IosMicSource
import io.sentient.mobilesdk.voice.io.IosVoiceAudio
import platform.Foundation.NSDate
import platform.Foundation.timeIntervalSince1970

private const val MS_PER_SECOND = 1_000.0

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = IosWebSocketEngine(),
    tokenStore = IosSecureTokenStore(),
    deviceIdStore = IosDeviceIdStore(),
    clock = Clock { (NSDate().timeIntervalSince1970 * MS_PER_SECOND).toLong() },
    voiceAudio = IosVoiceAudio(),
    playback = IosAudioPlaybackAdapter(), // E2: AVAudioPlayerNode on the shared engine
    mic = IosMicSource(), // Task 7: real-time voice-uplink mic on the shared engine
)
