// ---------------------------------------------------------------------------
// PlatformBundle.android — Android actual for createPlatformBundle().
//
// Resolves the application Context from AndroidContextHolder (populated by
// `MobileSdk.initAndroid(context)` in Application.onCreate()). The capture
// adapter is the AudioRecord-backed E1 actual; playback is the AudioTrack-backed
// E2 actual.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AndroidAudioCaptureAdapter
import io.sentient.mobilesdk.audioio.AndroidAudioPlaybackAdapter
import io.sentient.mobilesdk.secure.AndroidDeviceIdStore
import io.sentient.mobilesdk.secure.AndroidSecureTokenStore
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.AndroidMicSource

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = AndroidWebSocketEngine(),
    tokenStore = AndroidSecureTokenStore(),
    deviceIdStore = AndroidDeviceIdStore(),
    clock = Clock { System.currentTimeMillis() },
    capture = AndroidAudioCaptureAdapter(), // E1: AudioRecord VOICE_COMMUNICATION + AEC
    playback = AndroidAudioPlaybackAdapter(), // E2: AudioTrack VOICE_COMMUNICATION streaming
    mic = AndroidMicSource(), // Task 7: real-time voice-uplink mic on a realtime thread
)
