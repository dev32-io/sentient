// ---------------------------------------------------------------------------
// PlatformBundle.android — Android actual for createPlatformBundle().
//
// Resolves the application Context from AndroidContextHolder (populated by
// `MobileSdk.initAndroid(context)` in Application.onCreate()). The capture
// adapter is the AudioRecord-backed E1 actual; playback is null until E2.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AndroidAudioCaptureAdapter
import io.sentient.mobilesdk.secure.AndroidSecureTokenStore
import io.sentient.mobilesdk.secure.AndroidSessionIdStore
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.util.Clock

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = AndroidWebSocketEngine(),
    tokenStore = AndroidSecureTokenStore(),
    sessionIdStore = AndroidSessionIdStore(),
    clock = Clock { System.currentTimeMillis() },
    capture = AndroidAudioCaptureAdapter(), // E1: AudioRecord VOICE_COMMUNICATION + AEC
    playback = null, // E2 supplies the AudioTrack-backed playback adapter
)
