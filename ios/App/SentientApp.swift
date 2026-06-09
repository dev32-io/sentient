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
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appConfig)
        }
    }
}
