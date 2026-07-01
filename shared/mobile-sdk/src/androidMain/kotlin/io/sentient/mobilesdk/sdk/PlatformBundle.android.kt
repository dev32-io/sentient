// ---------------------------------------------------------------------------
// PlatformBundle.android — Android actual for createPlatformBundle().
//
// Resolves the application Context from AndroidContextHolder (populated by
// `MobileSdk.initAndroid(context)` in Application.onCreate()). VoiceAudio is the
// single audio engine: AudioRecord-backed mic uplink + AudioTrack-backed playback.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.secure.AndroidDeviceIdStore
import io.sentient.mobilesdk.secure.AndroidSecureTokenStore
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.AndroidVoiceAudio

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = AndroidWebSocketEngine(),
    tokenStore = AndroidSecureTokenStore(),
    deviceIdStore = AndroidDeviceIdStore(),
    clock = Clock { System.currentTimeMillis() },
    voiceAudio = AndroidVoiceAudio(), // Single audio engine: AudioRecord mic + AudioTrack playback
)
