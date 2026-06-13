// ---------------------------------------------------------------------------
// UserSessionHost — the authed root. Owns the User/Connection-scoped UserSession
// (@StateObject, built once on entry into the authed branch) and a NavigationStack
// whose ROOT is the chat surface keyed `.id(activeSessionId)`.
//
// Swift mirror of Android's AppNavHost chat gating:
//   - The SDK + socket live in UserSession ABOVE the stack, so opening history /
//     settings / switching conversation never drops the connection.
//   - Changing `activeSessionId` rebuilds the root ChatView via `.id(...)` → a
//     fresh thin ChatViewModel (route-recreates-VM analogue). History select sets
//     `activeSessionId = id`; new chat sets it nil (cold-start mirrors Android:
//     chat(nil) → a fresh conversation).
//   - Logout calls userSession.shutdown() + clears the token; RootView's auth
//     gate then routes to login (the UserSession @StateObject deinits here).
//
// Presence: scenePhase drives userSession.pause()/resume() with a cold-start-skip
// (init already connected) — the first .active after launch is skipped.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct UserSessionHost: View {
    /// User/Connection scope: the SDK + ChatComponent live here, above the stack.
    @StateObject private var userSession: UserSession

    let userName: String
    /// Clears the token via AppConfig → RootView re-routes to login.
    let onLogout: () -> Void

    /// The active conversation id; nil = new chat. Changing it rebuilds the root
    /// ChatView (and its thin VM) via `.id(chatIdentity)`.
    @State private var activeSessionId: String?
    /// Monotonic new-chat nonce. `activeSessionId` never advances off nil for a
    /// gate-minted chat (the mint re-anchors INSIDE the VM's cache, not here), so
    /// `onNewChat` setting nil→nil was a SwiftUI `.id` no-op — "+" did nothing from a
    /// fresh chat. Bumping this on every new-chat forces a distinct identity → a real
    /// rebuild → a clean nil-route VM, even when already on a new chat.
    @State private var newChatEpoch = 0
    @State private var path: [Route] = []

    /// Root ChatView identity: the conversation id when one is selected (history),
    /// else a per-new-chat nonce so each "+" rebuilds a fresh nil-route VM.
    private var chatIdentity: String { activeSessionId ?? "new-\(newChatEpoch)" }

    @Environment(\.scenePhase) private var scenePhase
    /// Cold-start-skip: only resume after a REAL background. The init-connect
    /// already brought the socket up, so the first .active is a no-op.
    @State private var hasBackgrounded = false
    private let sceneLog = AppLog("nav", "scene")

    init(appConfig: AppConfig) {
        userName = appConfig.displayName
        onLogout = { appConfig.logout() }
        _userSession = StateObject(wrappedValue: UserSession(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost
        ))
        // Cold start mirrors Android's CURRENT behavior: enter at chat(nil) → a new
        // conversation. (A resume-vs-new refinement is a separate follow-up.)
        _activeSessionId = State(initialValue: nil)
    }

    var body: some View {
        NavigationStack(path: $path) {
            // VM factories (NOT prebuilt VMs): ChatView wraps them in @StateObject so
            // each instance owns its VM for its lifetime. `.id(chatIdentity)` makes
            // SwiftUI build a FRESH ChatView (hence a fresh @StateObject ChatViewModel)
            // whenever the identity changes — a selected id, or a new-chat nonce bump.
            ChatView(
                makeVM: { userSession.makeChatVM(sessionId: activeSessionId) },
                makeHistoryVM: { userSession.makeHistoryVM() },
                userName: userName,
                onSelectSession: { id in
                    activeSessionId = id
                    path.removeAll()
                },
                onNewChat: {
                    activeSessionId = nil
                    newChatEpoch += 1
                    path.removeAll()
                },
                onOpenSettings: { path = [.settings] },
                onLogout: logout
            )
            .id(chatIdentity)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .settings:
                    SettingsSheet(
                        onLogout: logout,
                        onDismiss: { path.removeAll() }
                    )
                    .navigationBarBackButtonHidden(true)
                case .history:
                    // History is presented as the in-chat keeper drawer, not a
                    // stack page; this case exists for the typed graph completeness.
                    EmptyView()
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                hasBackgrounded = true
                sceneLog.info("background")
                userSession.pause()
                // Flush the diagnostic ring to the current session file on background
                // (the app-global vitals facade; same instance as init / Settings).
                VitalsHolder.shared.onAppBackground()
            case .active:
                if hasBackgrounded {
                    sceneLog.info("foreground")
                    userSession.resume()
                } else {
                    sceneLog.info("cold-start-skip")
                }
            default: break
            }
        }
    }

    /// Logout: tear down the SDK session, then clear the auth gate so RootView
    /// routes back to login (this view leaves the authed branch → @StateObject deinits).
    private func logout() {
        userSession.shutdown()
        onLogout()
    }
}
