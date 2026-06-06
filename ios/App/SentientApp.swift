import SwiftUI
import MobileData

@main
struct SentientApp: App {
    // AppConfig owns backend configuration + auth stores for the app lifetime.
    // NO SDK/MobileSession here — the session is chat-scoped and lives in ChatViewModel.
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
