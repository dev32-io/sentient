// ---------------------------------------------------------------------------
// MobileSdkAndroid — Android-only SDK initialisation entry point.
//
// Call MobileSdk.initAndroid(applicationContext) from Application.onCreate()
// BEFORE constructing any SDK object that requires a Context
// (SecureTokenStore, SessionIdStore, etc.) OR uses the opus codec.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk

import android.content.Context
import eu.buney.kopus.OpusLoader
import io.sentient.mobilesdk.log.createLogger

private val log = createLogger("android", "init")

/**
 * Initialises Android-side SDK dependencies.
 *
 * Must be called from `Application.onCreate()` with the application Context.
 * Idempotent: subsequent calls with the same context are no-ops.
 */
fun MobileSdk.initAndroid(context: Context) {
    AndroidContextHolder.setContext(context)
    loadOpusNative()
}

/**
 * Loads kopus' JNI lib (libopus_jni.so) so OpusEncoder/OpusDecoder can construct.
 *
 * On iOS, cinterop links libopus statically into the klib — nothing to load. On
 * Android the .so requires an explicit `System.loadLibrary`, which kopus exposes
 * via [OpusLoader.load] (idempotent, guarded by an internal AtomicBoolean).
 * WITHOUT this, the first OpusDecoder/OpusEncoder construction throws
 * UnsatisfiedLinkError ("No implementation found for ... nativeCreate") and TTS
 * decode / STT encode are silently broken. Failure is logged, not fatal — the app
 * still runs (text path unaffected); audio degrades with a traceable cause.
 */
private fun loadOpusNative() {
    runCatching { OpusLoader.load() }
        .onSuccess { log.info("opus-native-loaded") }
        .onFailure { log.error("opus-native-load-failed", mapOf("cause" to (it.message ?: "unknown"))) }
}
