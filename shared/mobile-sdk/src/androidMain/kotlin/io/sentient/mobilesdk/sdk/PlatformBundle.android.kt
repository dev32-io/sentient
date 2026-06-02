// ---------------------------------------------------------------------------
// PlatformBundle.android — Android actual for createPlatformBundle().
//
// Resolves the application Context from AndroidContextHolder (populated by
// `MobileSdk.initAndroid(context)` in Application.onCreate()). Audio adapters
// are null for the P-text path — E1/E2 supply the real AudioRecord-backed
// capture + AudioTrack-backed playback actuals later.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.secure.AndroidSecureTokenStore
import io.sentient.mobilesdk.secure.AndroidSessionIdStore
import io.sentient.mobilesdk.transport.AndroidWebSocketEngine
import io.sentient.mobilesdk.util.Clock

actual fun createPlatformBundle(): PlatformBundle = PlatformBundle(
    engine = AndroidWebSocketEngine(),
    tokenStore = AndroidSecureTokenStore(),
    sessionIdStore = AndroidSessionIdStore(),
    clock = Clock { System.currentTimeMillis() },
    capture = null, // E1 supplies the AudioRecord-backed capture adapter
    playback = null, // E2 supplies the AudioTrack-backed playback adapter
)
