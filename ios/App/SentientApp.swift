import SwiftUI
import MobileData

@main
struct SentientApp: App {
    // The app owns the one SdkStore for its lifetime (@StateObject) and injects
    // it into the view tree. The store builds the process SDK on first init.
    @StateObject private var store = SdkStore()

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
                .environmentObject(store)
        }
    }
}
