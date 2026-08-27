import SwiftUI
import MobileData

@main
struct SentientApp: App {
    private let visualCaptureMode: Bool

    init() {
        #if DEBUG
        let requestURL = URL(fileURLWithPath: "/tmp/sentient-visual-diff-request")
        let attributes = try? FileManager.default.attributesOfItem(atPath: requestURL.path)
        let modified = attributes?[.modificationDate] as? Date
        visualCaptureMode = (modified?.timeIntervalSinceNow ?? -.infinity) > -1800
        #else
        visualCaptureMode = false
        #endif

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
        if !visualCaptureMode {
            VitalsHolder.shared.start()
        }
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if visualCaptureMode {
                Color.clear
            } else if ProcessInfo.processInfo.arguments.contains("--qa-foundation-catalog") {
                QAFoundationCatalog()
            } else if ProcessInfo.processInfo.arguments.contains("--qa-visual-review") {
                QAVisualReviewCatalog()
            } else {
                ProductionAppRoot()
            }
            #else
            ProductionAppRoot()
            #endif
        }
    }
}

/// Owns app-scoped configuration only when the production root is mounted.
/// Keeping it below the debug visual-capture branch prevents screenshot tests
/// from reading or clearing persisted authentication state.
private struct ProductionAppRoot: View {
    // NO SDK here — the SDK is User/Connection-scoped and lives in UserSession
    // (built once at the authed root, above the NavigationStack).
    @StateObject private var appConfig = AppConfig()

    var body: some View {
        RootView()
            .environmentObject(appConfig)
    }
}
