import SwiftUI
import MobileData

@main
struct SentientApp: App {
    // AppConfig owns backend configuration + auth stores for the app lifetime.
    // NO SDK here — the SDK is User/Connection-scoped and lives in UserSession
    // (built once at the authed root, above the NavigationStack).
    @StateObject private var appConfig = AppConfig()

    init() {
        // Drop high-volume DEBUG tracing in prod (Release); keep it in dev.
        #if DEBUG
        MobileData.LogConfig.shared.minLevel = .debug
        #else
        MobileData.LogConfig.shared.minLevel = .info
        #endif

        // Start the diagnostic subsystem from the EARLIEST point — before login,
        // before any connection scope — so crash capture + file rotation are live
        // from launch and survive logout→login. The uploader is built only if a
        // backend is already configured (else a prior crash auto-uploads next
        // launch). Mirrors Android's VitalsHolder.init in SentientApp.onCreate.
        VitalsHolder.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appConfig)
        }
    }
}
