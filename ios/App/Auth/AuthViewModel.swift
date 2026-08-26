// ---------------------------------------------------------------------------
// AuthViewModel — login-scoped state owner for the avatar-grid → PIN-pad flow.
//
// Mirrors the Android AuthViewModel role: one observable state struct, one
// action surface. This owns UI state ONLY (users / selected user / pin / error)
// — NOT the SDK state surface. Navigation to chat is NOT modelled here:
// RootView derives login-vs-chat from AppConfig; the chat-scoped session owns
// connect() and reaches status == .ready, matching the codebase's event-driven UX
// inference. On a successful login we save the token to the same Keychain store
// the SDK reads, then call connect(); the SDK reaches .ready and
// RootView swaps to chat.
//
// PIN is NEVER logged. Auto-submit fires once 4 digits are entered.
//
// Legacy ObservableObject (not @Observable): the app's AppConfig is also an
// ObservableObject injected via .environmentObject, and the login state is
// short-lived UI state owned by the screen — @StateObject keeps it scoped to
// the login view's lifetime.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// PIN length the gateway expects (auth.ts: 4-digit numeric PIN).
let pinLength = 4

/// Client feedback timings mirror the Web login contract. The server remains
/// authoritative; these durations only keep visual feedback legible.
enum LoginFeedbackTiming {
    static let checkingMinimum = Duration.milliseconds(700)
    static let successTransition = Duration.milliseconds(Int((DesignV2.Motion.state * 1_000).rounded()))
}

/// Which login sub-screen is showing.
enum AuthPhase {
    case pickUser
    case enterPin
}

func loginPinErrorMessage(for error: AuthError) -> String {
    switch onEnum(of: error) {
    case .invalidCredentials: return "Wrong PIN"
    case .network, .server, .unknown: return "Something went wrong"
    }
}

@MainActor
final class AuthViewModel: ObservableObject {
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
    /// True while a login round-trip, feedback transition, and commit are in flight.
    @Published private(set) var isSubmitting = false
    /// Success copy remains visible during the short transition before auth commits.
    @Published private(set) var pinSuccess: String?
    /// Incremented for each failed attempt so the keypad can replay its bounded feedback.
    @Published private(set) var pinFeedbackRevision = 0

    var phase: AuthPhase { selectedUser == nil ? .pickUser : .enterPin }

    private let authClient: AuthClient
    private let tokenStore: SecureTokenStore
    private let displayNameStore: DisplayNameStore
    private let connect: () -> Void
    /// Receives only the server-authenticated AuthUser.userId. Never pass a
    /// display name or derive identity from the token.
    private let onAuthenticatedUser: (String) -> Void
    private let onInitialUsersResolved: () -> Void
    private var initialUsersResolved = false
    private var loginAttempt = 0
    private var loginTask: Task<Void, Never>?
    private let sleep: @Sendable (Duration) async throws -> Void
    private let clock = ContinuousClock()
    private let log = AppLog("auth", "model")

    /// - Parameters:
    ///   - connect: called after a successful login + token save; wires to the
    ///     chat-scoped session's connect() so the session stays the only
    ///     transport owner.
    ///   - authClient: REST client built via the iOS createAuthClient factory.
    ///   - tokenStore: the same Keychain store the SDK reads on connect.
    ///   - displayNameStore: persists the selected user's display name so the
    ///     chat / history headers can read it after this login-scoped model is
    ///     torn down. NOT a secret — never touches the token path.
    init(
        connect: @escaping () -> Void,
        onAuthenticatedUser: @escaping (String) -> Void = { _ in },
        onInitialUsersResolved: @escaping () -> Void = {},
        authClient: AuthClient = AuthViewModel.makeAuthClient(),
        tokenStore: SecureTokenStore = createTokenStore(),
        displayNameStore: DisplayNameStore = DisplayNameStore(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.connect = connect
        self.onAuthenticatedUser = onAuthenticatedUser
        self.onInitialUsersResolved = onInitialUsersResolved
        self.authClient = authClient
        self.tokenStore = tokenStore
        self.displayNameStore = displayNameStore
        self.sleep = sleep
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
            log.warn("loadUsers.threw code=transport")
            self.error = "Can't reach the server. Check your connection."
        }
        isLoadingUsers = false
        if !initialUsersResolved {
            initialUsersResolved = true
            onInitialUsersResolved()
        }
    }

    func select(_ user: AuthUserLite) {
        invalidateLogin()
        selectedUser = user
        pin = ""
        error = nil
        pinSuccess = nil
    }

    func back() {
        invalidateLogin()
        selectedUser = nil
        pin = ""
        error = nil
        pinSuccess = nil
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
        loginAttempt += 1
        let attempt = loginAttempt
        loginTask?.cancel()
        log.info("login.start")
        isSubmitting = true
        error = nil
        pinSuccess = nil
        loginTask = Task { [weak self] in
            guard let self else { return }
            await self.performLogin(user: user, pin: attemptPin, attempt: attempt)
        }
    }

    private func performLogin(user: AuthUserLite, pin: String, attempt: Int) async {
        let startedAt = clock.now
        do {
            let result = try await authClient.login(userId: user.userId, pin: pin)
            try await waitForMinimumChecking(since: startedAt)
            guard isCurrent(attempt, user: user) else { return }

            switch onEnum(of: result) {
            case .success(let success):
                guard let response = success.value,
                      !response.token.isEmpty,
                      !response.user.userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    log.warn("login.invalid-success")
                    await finishPinFailure(
                        message: "Something went wrong. Please try again.",
                        since: startedAt,
                        attempt: attempt,
                        user: user
                    )
                    return
                }

                // Keep the accepted state visible before the backend-authoritative
                // identity/token commit changes the root view.
                pinSuccess = "PIN accepted."
                do {
                    try await sleep(LoginFeedbackTiming.successTransition)
                } catch is CancellationError {
                    return
                } catch {
                    return
                }
                guard isCurrent(attempt, user: user) else { return }

                // The namespace identity comes from the authenticated response,
                // not the pre-login display list and never the token text.
                let authenticatedUserId = response.user.userId
                log.info("login.ok")
                tokenStore.save(token: response.token)
                // Persist the server-authoritative display name for headers; it
                // is separate from the identity used by the calendar namespace.
                displayNameStore.save(response.user.displayName)
                isSubmitting = false
                onAuthenticatedUser(authenticatedUserId)
                connect()
            case .failure(let failure):
                log.warn("login.failed")
                await finishPinFailure(
                    message: loginPinErrorMessage(for: failure.error),
                    since: startedAt,
                    attempt: attempt,
                    user: user
                )
            }
        } catch is CancellationError {
            return
        } catch {
            log.warn("login.threw code=transport")
            await finishPinFailure(
                message: "Something went wrong. Please try again.",
                since: startedAt,
                attempt: attempt,
                user: user
            )
        }
    }

    private func waitForMinimumChecking(since startedAt: ContinuousClock.Instant) async throws {
        let minimum = LoginFeedbackTiming.checkingMinimum
        let elapsed = startedAt.duration(to: clock.now)
        guard elapsed < minimum else { return }
        try await sleep(minimum - elapsed)
    }

    private func finishPinFailure(
        message: String,
        since startedAt: ContinuousClock.Instant,
        attempt: Int,
        user: AuthUserLite
    ) async {
        do {
            try await waitForMinimumChecking(since: startedAt)
        } catch is CancellationError {
            return
        } catch {
            return
        }
        guard isCurrent(attempt, user: user) else { return }
        isSubmitting = false
        pin = ""
        pinSuccess = nil
        error = message
        pinFeedbackRevision += 1
    }

    private func isCurrent(_ attempt: Int, user: AuthUserLite) -> Bool {
        loginAttempt == attempt && selectedUser?.userId == user.userId
    }

    private func invalidateLogin() {
        loginAttempt += 1
        loginTask?.cancel()
        loginTask = nil
        isSubmitting = false
    }

    private func message(for error: AuthError) -> String {
        switch onEnum(of: error) {
        case .invalidCredentials: return "Wrong PIN"
        case .network: return "Can't reach the server. Check your connection."
        case .server: return "Server error. Please try again."
        case .unknown: return "Something went wrong. Please try again."
        }
    }

    // ── AuthClient construction ───────────────────────────────────────────────

    /// Build the REST AuthClient via the iOS factory. Resolves the backend from
    /// BackendConfigStore → build-time default → localhost fallback, matching the
    /// resolution order AppConfig uses. `nonisolated` so it can serve as a
    /// default-argument expression.
    nonisolated static func makeAuthClient() -> AuthClient {
        let resolved = resolveBackend(
            override: BackendConfigStore().load(),
            buildTimeDefaultURL: GatewayConfig.buildTimeDefaultWsURL,
            buildTimeAllowSelfSigned: GatewayConfig.buildTimeAllowSelfSigned
        )
        guard case let .configured(url, trust) = resolved else {
            return createAuthClient(
                gatewayWsUrl: GatewayConfig.buildTimeDefaultWsURL,
                allowSelfSignedDevHost: false
            )
        }
        return createAuthClient(gatewayWsUrl: url, allowSelfSignedDevHost: trust)
    }
}
