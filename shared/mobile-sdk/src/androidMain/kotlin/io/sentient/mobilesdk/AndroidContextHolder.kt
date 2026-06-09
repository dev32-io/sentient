// ---------------------------------------------------------------------------
// AndroidContextHolder — minimal application Context holder for androidMain actuals.
//
// Usage: call MobileSdk.initAndroid(applicationContext) from Application.onCreate().
// Task C7 (platform bundle) will wire this into the full SDK init sequence.
//
// Only the Android actuals (SecureTokenStore, audio adapters, etc.) read from
// this holder — they call requireContext() which throws a clear error at
// construction time if initAndroid was never called.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk

import android.content.Context

/**
 * Internal holder for the Android application [Context].
 *
 * Call [setContext] exactly once from `Application.onCreate()` via
 * `MobileSdk.initAndroid(applicationContext)`.
 *
 * C7 (platform bundle) will route the full SDK initialisation through
 * `MobileSdk.initAndroid` — this holder is the minimal stub so B3 actuals
 * are constructible without waiting for C7.
 */
internal object AndroidContextHolder {

    @Volatile
    private var appContext: Context? = null

    internal fun setContext(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Returns the stored [Context].
     *
     * @throws IllegalStateException if [setContext] has not been called.
     */
    internal fun requireContext(): Context =
        appContext
            ?: error(
                "MobileSdk.initAndroid(context) must be called from Application.onCreate() " +
                    "before using SecureTokenStore or the audio adapters.",
            )
}
