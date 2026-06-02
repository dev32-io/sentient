// ---------------------------------------------------------------------------
// RootView — event-driven nav switch between login and chat.
//
// Mirrors the Android MainActivity: login-vs-chat is DERIVED from the SDK's
// single state surface (status == .ready), not modelled as explicit nav state.
// LoginView shows whenever the SDK is not READY; once a successful login saves
// the token + calls connect() and the SDK reaches READY, RootView swaps to
// ChatView (D-I2 placeholder; D-I3 builds the real chat). Disconnect drops the
// status below READY and the UI swaps back to login automatically.
//
// LoginView receives the app-level SdkStore.connect via a closure so the single
// SDK store stays the only transport owner (no per-screen SdkStore).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct RootView: View {
    @EnvironmentObject private var store: SdkStore

    var body: some View {
        Group {
            if store.state.status == .ready {
                ChatView()
            } else {
                LoginView(onConnect: { store.connect() })
            }
        }
    }
}
