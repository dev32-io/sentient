// ---------------------------------------------------------------------------
// ChatRoot — builds a chat-scoped MobileSession + ChatViewModel, renders
// ChatView. Extracted to keep RootView under the 40-line function limit.
//
// The @StateObject ChatViewModel is created ONCE per composition entry into
// this branch. Exiting the branch (hasToken=false on logout) deinits the
// StateObject → ChatViewModel.deinit fires → session.close(). That is the
// SINGLE teardown path. No DisposableEffect / onDisappear close needed.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

// ChatSessionConfig bundles the immutable backend params so ChatRoot doesn't
// re-create sessions on recomposition (the @StateObject autoclosure is still
// called on every ChatRoot.init, but the VM/session is the first one only).
private struct ChatSessionConfig {
    let gatewayWsUrl: String
    let allowSelfSignedDevHost: Bool
}

struct ChatRoot: View {
    private let config: ChatSessionConfig
    let userName: String
    let onLogout: () -> Void

    // @StateObject ensures ChatViewModel (and the MobileSession inside it) is
    // created exactly ONCE per composition lifetime of this view branch.
    // The wrappedValue autoclosure is only kept on the first init; subsequent
    // ChatRoot struct inits (parent recompose) are ignored by SwiftUI.
    @StateObject private var vm: ChatViewModel

    init(appConfig: AppConfig) {
        config = ChatSessionConfig(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost
        )
        userName = appConfig.displayName
        onLogout = { appConfig.logout() }
        _vm = StateObject(wrappedValue: ChatViewModel(
            session: createMobileSession(
                gatewayWsUrl: appConfig.gatewayWsUrl,
                allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost,
                capabilities: [],
                // Enable FaultHooks in debug builds for E2E fault-injection flows.
                // NOTE: iOS has no broadcast-receiver arming channel; arm faults
                // from the app code or via a future debug UI. FLAG: iOS fault
                // injection is a follow-up (no adb-equivalent simple arming channel).
                devFaultsEnabled: { () -> Bool in
                    #if DEBUG
                    return true
                    #else
                    return false
                    #endif
                }()
            )
        ))
    }

    var body: some View {
        ChatView(vm: vm, userName: userName, onLogout: onLogout)
    }
}
