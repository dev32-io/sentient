// ---------------------------------------------------------------------------
// RootView — 3-way gate: unconfigured → setup, configured+no-session → login,
//             configured+in-session → chat.
//
// Config is checked FIRST so store.state is never evaluated while unconfigured.
// showSetupOverride lets the gear button on LoginView re-open setup at any time
// (without clearing the persisted config); after save, the override is cleared
// and the session gate resumes normal routing.
//
// The session gate keys on store.state.hasSession (the SDK's auth/session
// signal), NOT transport status. Gating on status==.ready would unmount ChatView
// on every WS drop (status leaves READY) and fall back to login, which hides the
// in-chat connection-lost banner. hasSession is set on first READY and PRESERVED
// across drops / idle-disconnect / reconnect, cleared only on logout / authExpired
// — so a drop keeps the user on chat WITH the banner (the composer self-gates on
// status==.ready). Mirrors web-sdk: AUTH gates the screen, status drives the banner.
//
// LoginView receives the app-level SdkStore.connect via a closure and an
// onOpenBackendSetup closure that sets the override flag, keeping the single
// SDK store as the only transport owner.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct RootView: View {
    @EnvironmentObject private var store: SdkStore
    @State private var showSetupOverride = false

    var body: some View {
        Group {
            if !store.isConfigured || showSetupOverride {
                BackendSetupView(
                    model: BackendSetupModel(
                        existing: BackendConfigStore().load(),
                        reconfigure: { store.reconfigure($0) }
                    ),
                    onSaved: { showSetupOverride = false }
                )
            } else if store.state.hasSession {
                ChatView(store: store)
            } else {
                LoginView(
                    onConnect: { store.connect() },
                    onOpenBackendSetup: { showSetupOverride = true }
                )
            }
        }
    }
}
