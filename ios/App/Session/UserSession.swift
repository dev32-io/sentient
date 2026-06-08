// ---------------------------------------------------------------------------
// UserSession — the User/Connection scope (held as @StateObject at the authed
// root). Swift mirror of Android's UserSessionManager.
//
// Owns ONE KMP IosUserSession (SDK + ChatComponent + session scope), built once
// when the user is authed and surviving navigation: switching conversation,
// opening history, opening settings never drop the socket because the SDK lives
// HERE, above the NavigationStack. init() background-connects (open()); shutdown()
// (logout) tears it down.
//
// makeChatVM(sessionId:) builds a THIN per-conversation ChatViewModel over the
// shared ChatComponent — the route-keyed root ChatView (.id(activeSessionId))
// asks for a fresh VM each time the active conversation changes, the SwiftUI
// analogue of Android's route-recreates-VM.
//
// Presence: pause()/resume() forward background/foreground to the KMP session
// (drop socket / re-arm reconnect). The owning view drives these from scenePhase
// with a cold-start-skip (init already connected).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class UserSession: ObservableObject {
    /// The KMP User-scope holder: SDK + ChatComponent + session scope.
    private let inner: IosUserSession
    private let log = AppLog("user-session")

    /// The shared usecase layer for this login. Chat + history VMs resolve their
    /// usecases / passthroughs from here — never the SDK directly.
    var component: ChatComponent { inner.component }

    /// Build the User session from a resolved backend (gateway URL + dev-TLS
    /// posture). FaultHooks are armed in debug builds (no adb-equivalent arming
    /// channel on iOS yet — fault flows stay Android-only; see ios-testing rule).
    init(gatewayWsUrl: String, allowSelfSignedDevHost: Bool) {
        self.inner = createUserSession(
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost,
            capabilities: [],
            devFaultsEnabled: {
                #if DEBUG
                return true
                #else
                return false
                #endif
            }()
        )
        log.info("init — open")
        // Background connect: the chat UI is usable immediately; reconnect is the SDK's.
        inner.open()
    }

    /// Build a thin per-conversation ChatViewModel over the shared ChatComponent.
    /// Called by the route-keyed root ChatView; a new VM per active conversation.
    func makeChatVM(sessionId: String?) -> ChatViewModel {
        log.info("makeChatVM sessionId=\(sessionId ?? "<new>")")
        return ChatViewModel(component: component, sessionId: sessionId)
    }

    /// Build the history VM over the shared ChatComponent (reads + rename/delete).
    func makeHistoryVM() -> HistoryViewModel {
        HistoryViewModel(component: component)
    }

    // ── Presence (scenePhase) ───────────────────────────────────────────────────

    /// App background → drop the socket but stay in session.
    func pause() {
        log.info("pause")
        inner.pause()
    }

    /// App foreground → re-arm reconnect.
    func resume() {
        log.info("resume")
        inner.resume()
    }

    // ── Teardown ────────────────────────────────────────────────────────────────

    /// Logout teardown: disconnect (clearSession=true) + cancel the session scope.
    func shutdown() {
        log.info("shutdown")
        inner.close()
    }
}
