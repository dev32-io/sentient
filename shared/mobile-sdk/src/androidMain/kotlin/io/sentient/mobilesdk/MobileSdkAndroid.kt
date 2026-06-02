// ---------------------------------------------------------------------------
// MobileSdkAndroid — Android-only SDK initialisation entry point.
//
// Call MobileSdk.initAndroid(applicationContext) from Application.onCreate()
// BEFORE constructing any SDK object that requires a Context
// (SecureTokenStore, SessionIdStore, etc.).
//
// Task C7 (platform bundle) will extend this init to wire the full
// platform-capability bundle. Until then this stub satisfies the Context
// requirement for storage actuals.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk

import android.content.Context

/**
 * Initialises Android-side SDK dependencies.
 *
 * Must be called from `Application.onCreate()` with the application Context.
 * Idempotent: subsequent calls with the same context are no-ops.
 */
fun MobileSdk.initAndroid(context: Context) {
    AndroidContextHolder.setContext(context)
}
