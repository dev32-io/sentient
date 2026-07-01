// ---------------------------------------------------------------------------
// PlatformBundle.android — Android actual for createPlatformBundle().
//
// Resolves the application Context from AndroidContextHolder (populated by
// `MobileSdk.initAndroid(context)` in Application.onCreate()). Playback is the
// AudioTrack-backed E2 actual; the mic is the AudioRecord-backed voice-uplink actual.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.audioio.AndroidAudioPlaybackAdapter
import io.sentient.mobilesdk.secure.AndroidDeviceIdStore
import io.sentient.mobilesdk.secure.AndroidSecureTokenStore
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.util.Clock
import io.sentient.mobilesdk.voice.io.AndroidMicSource
import io.sentient.mobilesdk.voice.io.AndroidVoiceAudio

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = AndroidWebSocketEngine(),
    tokenStore = AndroidSecureTokenStore(),
    deviceIdStore = AndroidDeviceIdStore(),
    clock = Clock { System.currentTimeMillis() },
    voiceAudio = AndroidVoiceAudio(),
    playback = AndroidAudioPlaybackAdapter(), // E2: AudioTrack VOICE_COMMUNICATION streaming
    mic = AndroidMicSource(), // Task 7: real-time voice-uplink mic on a realtime thread
)
