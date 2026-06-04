// ---------------------------------------------------------------------------
// RootView — 3-way gate: unconfigured → setup, configured+not-ready → login,
//             configured+ready → chat.
//
// Config is checked FIRST so store.state is never evaluated while unconfigured.
// showSetupOverride lets the gear button on LoginView re-open setup at any time
// (without clearing the persisted config); after save, the override is cleared
// and the SDK-status gate resumes normal routing.
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
            } else if store.state.status == .ready {
                ChatView()
            } else {
                LoginView(
                    onConnect: { store.connect() },
                    onOpenBackendSetup: { showSetupOverride = true }
                )
            }
        }
    }
}
