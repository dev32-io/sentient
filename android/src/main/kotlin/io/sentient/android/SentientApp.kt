// ---------------------------------------------------------------------------
// SentientApp — the Application entry point.
//
// Calls MobileSdk.initAndroid(applicationContext) BEFORE any SDK access so the
// secure stores (SecureTokenStore / SessionIdStore) and the platform bundle can
// resolve the Android Context, then starts the Koin DI graph. UserSessionManager
// builds the SentientSdk lazily on first chat entry — always after onCreate — so
// the Context is guaranteed present.
// ---------------------------------------------------------------------------
package io.sentient.android

import android.app.Application
import io.sentient.android.di.appModule
import io.sentient.mobilesdk.MobileSdk
import io.sentient.mobilesdk.initAndroid
import io.sentient.mobilesdk.log.createLogger
import org.koin.android.ext.koin.androidContext
import org.koin.core.context.startKoin

class SentientApp : Application() {
    private val log = createLogger("android", "app")

    override fun onCreate() {
        super.onCreate()
        MobileSdk.initAndroid(applicationContext)
        io.sentient.android.backend.BackendConfigHolder.init(applicationContext)
        io.sentient.android.sdk.DisplayNameHolder.init(applicationContext)
        // Koin DI graph: UserSessionManager (User/Connection scope) + per-screen VMs.
        startKoin {
            androidContext(this@SentientApp)
            modules(appModule)
        }
        log.info("onCreate", mapOf("sdkInit" to true, "koin" to true))
    }
}
