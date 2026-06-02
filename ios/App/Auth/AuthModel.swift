// ---------------------------------------------------------------------------
// AuthModel — login-scoped state owner for the avatar-grid → PIN-pad flow.
//
// Mirrors the Android AuthViewModel role: one observable state struct, one
// action surface. This owns UI state ONLY (users / selected user / pin / error)
// — NOT the SDK state surface. Navigation to chat is NOT modelled here:
// RootView derives login-vs-chat from the injected SdkStore's single state
// surface (status == .ready), matching the codebase's event-driven UX
// inference. On a successful login we save the token to the same Keychain store
// the SDK reads, then call sdkStore.connect(); the SDK reaches .ready and
// RootView swaps to chat.
//
// PIN is NEVER logged. Auto-submit fires once 4 digits are entered.
//
// Legacy ObservableObject (not @Observable): the app's SdkStore is also an
// ObservableObject injected via .environmentObject, and the login state is
// short-lived UI state owned by the screen — @StateObject keeps it scoped to
// the login view's lifetime.
// ---------------------------------------------------------------------------
import Foundation
import MobileSdk

/// PIN length the gateway expects (auth.ts: 4-digit numeric PIN).
let pinLength = 4

/// Which login sub-screen is showing.
enum AuthPhase {
    case pickUser
    case enterPin
}

@MainActor
final class AuthModel: ObservableObject {
    /// Avatar-grid entries from GET /auth/users.
    @Published private(set) var users: [AuthUserLite] = []
    /// True while the initial list is in flight.
    @Published private(set) var isLoadingUsers = false
    /// The user whose PIN is being entered (nil in pickUser).
    @Published private(set) var selectedUser: AuthUserLite?
    /// Digits entered so far (length 0...pinLength). NEVER logged.
    @Published private(set) var pin = ""
    /// User-facing error message, or nil. Drives the `login-error` text.
    @Published private(set) var error: String?
    /// True while a login round-trip + connect is in flight.
    @Published private(set) var isSubmitting = false

    var phase: AuthPhase { selectedUser == nil ? .pickUser : .enterPin }

    private let authClient: AuthClient
    private let tokenStore: SecureTokenStore
    private let connect: () -> Void
    private let log = AppLog("auth", "model")

    /// - Parameters:
    ///   - connect: called after a successful login + token save; wires to the
    ///     app-level SdkStore.connect() so the single SDK store stays the only
    ///     transport owner.
    ///   - authClient: REST client built via the iOS createAuthClient factory.
    ///   - tokenStore: the same Keychain store the SDK reads on connect.
    init(
        connect: @escaping () -> Void,
        authClient: AuthClient = AuthModel.makeAuthClient(),
        tokenStore: SecureTokenStore = createTokenStore()
    ) {
        self.connect = connect
        self.authClient = authClient
        self.tokenStore = tokenStore
    }

    // ── User actions ────────────────────────────────────────────────────────

    func loadUsers() async {
        log.info("loadUsers.start")
        isLoadingUsers = true
        error = nil
        do {
            let result = try await authClient.listUsers()
            switch onEnum(of: result) {
            case .success(let success):
                let list = success.value as? [AuthUserLite] ?? []
                log.info("loadUsers.ok count=\(list.count)")
                users = list
            case .failure(let failure):
                log.warn("loadUsers.failed")
                error = message(for: failure.error)
            }
        } catch {
            log.warn("loadUsers.threw: \(error)")
            self.error = "Can't reach the server. Check your connection."
        }
        isLoadingUsers = false
    }

    func select(_ user: AuthUserLite) {
        selectedUser = user
        pin = ""
        error = nil
    }

    func back() {
        selectedUser = nil
        pin = ""
        error = nil
    }

    func appendDigit(_ digit: Character) {
        guard !isSubmitting, pin.count < pinLength else { return }
        pin.append(digit)
        error = nil
        if pin.count == pinLength { submit() }
    }

    func deleteDigit() {
        guard !isSubmitting, !pin.isEmpty else { return }
        pin.removeLast()
        error = nil
    }

    // ── Submit ──────────────────────────────────────────────────────────────

    private func submit() {
        guard let user = selectedUser else { return }
        let attemptPin = pin // PIN intentionally not logged
        log.info("login.start userId=\(user.userId)")
        isSubmitting = true
        error = nil
        Task { await self.performLogin(user: user, pin: attemptPin) }
    }

    private func performLogin(user: AuthUserLite, pin: String) async {
        do {
            let result = try await authClient.login(userId: user.userId, pin: pin)
            switch onEnum(of: result) {
            case .success(let success):
                log.info("login.ok userId=\(user.userId)")
                if let token = success.value?.token { tokenStore.save(token: token) }
                isSubmitting = false
                connect()
            case .failure(let failure):
                log.warn("login.failed userId=\(user.userId)")
                isSubmitting = false
                self.pin = ""
                error = message(for: failure.error)
            }
        } catch {
            log.warn("login.threw: \(error)")
            isSubmitting = false
            self.pin = ""
            self.error = "Something went wrong. Please try again."
        }
    }

    private func message(for error: AuthError) -> String {
        switch onEnum(of: error) {
        case .invalidCredentials: return "Incorrect PIN. Try again."
        case .network: return "Can't reach the server. Check your connection."
        case .server: return "Server error. Please try again."
        case .unknown: return "Something went wrong. Please try again."
        }
    }

    // ── AuthClient construction ───────────────────────────────────────────────

    /// Build the REST AuthClient via the iOS factory (Darwin engine + debug-only
    /// self-signed TLS bypass), against the same gateway endpoint as the SDK.
    /// `nonisolated` so it can serve as a default-argument expression (mirrors
    /// SdkStore.makeSdk()).
    nonisolated static func makeAuthClient() -> AuthClient {
        createAuthClient(
            gatewayWsUrl: gatewayWsUrl,
            allowSelfSignedDevHost: allowSelfSignedDevHost
        )
    }

    /// Gateway WS endpoint. iOS simulator shares the host loopback, so localhost
    /// reaches the dev gateway directly. (Matches SdkStore.gatewayWsUrl.)
    nonisolated private static let gatewayWsUrl = "wss://localhost:8888/api/v1/ws"

    /// Trust the self-signed dev cert only in debug builds; release must verify.
    nonisolated private static var allowSelfSignedDevHost: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}
