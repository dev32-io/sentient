import SwiftUI

@main
struct SentientApp: App {
    // The app owns the one SdkStore for its lifetime (@StateObject) and injects
    // it into the view tree. The store builds the process SDK on first init.
    @StateObject private var store = SdkStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
        }
    }
}
