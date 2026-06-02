// ---------------------------------------------------------------------------
// SentientApp — the Application entry point.
//
// Calls MobileSdk.initAndroid(applicationContext) BEFORE any SDK access so the
// secure stores (SecureTokenStore / SessionIdStore) and the platform bundle can
// resolve the Android Context. SdkHolder builds the SentientSdk lazily on first
// ViewModel access — which always happens after onCreate — so the Context is
// guaranteed present.
// ---------------------------------------------------------------------------
package io.sentient.android

import android.app.Application
import io.sentient.mobilesdk.MobileSdk
import io.sentient.mobilesdk.initAndroid
import io.sentient.mobilesdk.log.createLogger

class SentientApp : Application() {
    private val log = createLogger("android", "app")

    override fun onCreate() {
        super.onCreate()
        MobileSdk.initAndroid(applicationContext)
        log.info("onCreate", mapOf("sdkInit" to true))
    }
}
