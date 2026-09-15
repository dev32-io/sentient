import CryptoKit
import MobileData
import XCTest
@testable import SentientApp

@MainActor
private final class RecordingIdentityDriver: SentientIdentityDriving {
    var reducedMotion: [Bool] = []
    var transitions: [SentientIdentityState] = []

    func setReducedMotion(_ reduced: Bool) { reducedMotion.append(reduced) }
    func transition(to state: SentientIdentityState) { transitions.append(state) }
}

private struct ImmediateStartupClock: StartupMonotonicClock {
    func sleepForMinimum() async {}
}

@MainActor
final class IdentityStartupTests: XCTestCase {
    func testPackagedIdentityChecksumAndFallback() throws {
        let bundle = Bundle(for: StartupReadinessCoordinator.self)
        let riveURL = try XCTUnwrap(bundle.url(forResource: "sentient-avatar", withExtension: "riv"))
        let digest = SHA256.hash(data: try Data(contentsOf: riveURL))
        XCTAssertEqual(digest.map { String(format: "%02x", $0) }.joined(),
                       "3111d27fbdeb48527e45e024148171fc0f77ecfed89decf7e8f4cd85fe1beec7")
        XCTAssertNotNil(bundle.url(forResource: "SentientMarkFallback", withExtension: "png"))
    }

    func testFakeRiveLoadFailureKeepsThinkingSemanticsForFallback() {
        let model = RiveIdentityModel(initialState: .thinking, resourceExists: { _ in false })
        XCTAssertNil(model.riveViewModel)
        XCTAssertEqual(model.controller.state, .thinking)
    }

    func testIdentityHasExactlyThreeMappedStatesAndLatestRequestWins() {
        XCTAssertEqual(SentientIdentityState.allCases, [.idle, .thinking, .responding])
        XCTAssertEqual(SentientIdentityState.allCases.map(\.triggerName),
                       ["toIdle", "toThinking", "toResponding"])
        XCTAssertEqual(SentientIdentityState.allCases.map(\.statusLabel),
                       ["Sentient is idle", "Sentient is thinking", "Sentient is responding"])

        let driver = RecordingIdentityDriver()
        let controller = SentientIdentityStateController(state: .idle, driver: driver)
        controller.synchronize(state: .idle, reducedMotion: false)
        controller.request(.thinking)
        controller.request(.responding)
        controller.setReducedMotion(true)

        XCTAssertEqual(controller.state, .responding)
        XCTAssertEqual(driver.transitions, [.idle, .thinking, .responding, .responding])
        XCTAssertEqual(driver.reducedMotion, [false, true])
    }

    func testReducedMotionStartsWithTheRequestedStaticVariant() {
        let driver = RecordingIdentityDriver()
        let controller = SentientIdentityStateController(
            state: .thinking,
            reducedMotion: false,
            driver: driver
        )

        XCTAssertTrue(driver.reducedMotion.isEmpty)
        XCTAssertTrue(driver.transitions.isEmpty)

        controller.synchronize(state: .thinking, reducedMotion: true)

        XCTAssertEqual(controller.state, .thinking)
        XCTAssertTrue(controller.reducedMotion)
        XCTAssertEqual(driver.reducedMotion, [true])
        XCTAssertEqual(driver.transitions, [.thinking])
    }

    func testAppearanceReconcilesLatestInputsOnlyOnce() {
        let driver = RecordingIdentityDriver()
        let controller = SentientIdentityStateController(state: .idle, driver: driver)

        controller.request(.thinking)
        controller.setReducedMotion(true)
        XCTAssertTrue(driver.reducedMotion.isEmpty)
        XCTAssertTrue(driver.transitions.isEmpty)

        controller.synchronize(state: .responding, reducedMotion: true)
        controller.synchronize(state: .responding, reducedMotion: true)

        XCTAssertEqual(controller.state, .responding)
        XCTAssertTrue(controller.reducedMotion)
        XCTAssertEqual(driver.reducedMotion, [true])
        XCTAssertEqual(driver.transitions, [.responding])
    }

    func testCaptureDoesNotDriveIdentityAndAssistantActivityDoes() {
        var connection = makeDisconnectedConnection()
        connection = ConnectionState(
            status: connection.status, hasSession: connection.hasSession,
            connectionLost: connection.connectionLost, authExpired: connection.authExpired,
            prefs: connection.prefs, voiceMode: connection.voiceMode, isSpeaking: false,
            audioState: .listening, cognition: .idle
        )
        XCTAssertEqual(identityState(for: connection), .idle)
        XCTAssertEqual(identityState(for: connection, hasStreamingAssistantText: true), .responding)

        let processing = ConnectionState(
            status: connection.status, hasSession: connection.hasSession,
            connectionLost: connection.connectionLost, authExpired: connection.authExpired,
            prefs: connection.prefs, voiceMode: connection.voiceMode, isSpeaking: false,
            audioState: .processing, cognition: .idle
        )
        XCTAssertEqual(identityState(for: processing), .thinking)
    }

    func testStartupRequiresBothSignalsAndStartsCovered() async {
        let startup = StartupReadinessCoordinator(clock: ImmediateStartupClock())
        XCTAssertTrue(startup.isCovering) // first frame is the thinking splash
        startup.begin()
        startup.rootDidResolve() // fast root
        await Task.yield()
        XCTAssertFalse(startup.isCovering)

        startup.begin()
        startup.minimumDidElapse() // slow root
        XCTAssertTrue(startup.isCovering)
        startup.rootDidResolve() // terminal success/empty/actionable error all resolve here
        XCTAssertFalse(startup.isCovering)
    }

    func testColdValidationClearsOldIdentityIntentBeforePublishingRefreshedAuthentication() async {
        let fixture = StartupAuthFixture()
        let pending = PendingNotificationNavigation()
        pending.receive(NotificationDestination(sessionId: "old-account-session")!)
        fixture.auth.result = AuthResultSuccess(value: fixture.response(token: "fresh", userId: "server-user"))
        var callbackObservedOldIdentity = false

        let result = await fixture.config.validateStartupAuthentication(beforeAccountChange: {
            callbackObservedOldIdentity = fixture.config.startupAuthentication == .validating &&
                fixture.identity.load() == "stored-user"
            pending.clear()
        })
        XCTAssertEqual(result, .authenticated)
        XCTAssertTrue(callbackObservedOldIdentity)
        XCTAssertNil(pending.destination)
        XCTAssertEqual(fixture.tokens.load(), "fresh")
        XCTAssertEqual(fixture.identity.load(), "server-user")
        XCTAssertEqual(fixture.names.load(), "Server User")
    }

    func testColdInvalidCredentialReturnsLoginAndReportsOldAccountFence() async {
        let fixture = StartupAuthFixture()
        fixture.auth.result = authFailure(AuthError.InvalidCredentials.shared)
        var fence: String?

        let result = await fixture.config.validateStartupAuthentication(beforeInvalidation: { fence = $0 })
        XCTAssertEqual(result, .login)
        XCTAssertEqual(fence, "wss://gateway.test/api/v1/ws|stored-user")
        XCTAssertNil(fixture.tokens.load())
    }

    func testColdNetworkFailureKeepsCredentialsAndShowsRetry() async {
        let fixture = StartupAuthFixture()
        fixture.auth.error = NSError(domain: "test", code: 1)

        let result = await fixture.config.validateStartupAuthentication()
        XCTAssertEqual(result, .retry)
        XCTAssertEqual(fixture.tokens.load(), "stored-token")
        XCTAssertTrue(fixture.config.hasToken)
    }

    func testLateValidationCannotOverwriteLogout() async {
        let fixture = StartupAuthFixture(suspended: true)
        let started = expectation(description: "validation started")
        fixture.auth.onStart = { started.fulfill() }
        let task = Task { await fixture.config.validateStartupAuthentication() }
        await fulfillment(of: [started], timeout: 1)
        fixture.config.logout()
        fixture.auth.complete(AuthResultSuccess(value: fixture.response(token: "stale", userId: "stale-user")))
        _ = await task.value

        XCTAssertEqual(fixture.config.startupAuthentication, .login)
        XCTAssertNil(fixture.tokens.load())
        XCTAssertNil(fixture.identity.load())
    }

    func testCancelledValidationPreservesCredentialsAndRejectsLateSuccess() async {
        let fixture = StartupAuthFixture(suspended: true)
        let started = expectation(description: "validation started")
        fixture.auth.onStart = { started.fulfill() }
        let task = Task { await fixture.config.validateStartupAuthentication() }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        fixture.auth.complete(AuthResultSuccess(value: fixture.response(token: "cancelled", userId: "other-user")))
        let result = await task.value

        XCTAssertEqual(result, .retry)
        XCTAssertEqual(fixture.tokens.load(), "stored-token")
        XCTAssertEqual(fixture.identity.load(), "stored-user")
    }
}

@MainActor
private final class StartupAuthFixture {
    let tokens = StartupMemoryTokens()
    let names: DisplayNameStore
    let identity: AuthenticatedIdentityStore
    let auth: StartupControlledAuth
    let config: AppConfig

    init(suspended: Bool = false) {
        let defaults = UserDefaults(suiteName: "StartupAuthFixture.\(UUID().uuidString)")!
        names = DisplayNameStore(defaults: defaults)
        identity = AuthenticatedIdentityStore(defaults: defaults)
        let client = StartupControlledAuth(suspended: suspended)
        auth = client
        tokens.save(token: "stored-token")
        names.save("Stored User")
        identity.save("stored-user")
        config = AppConfig(
            tokenStore: tokens,
            displayNameStore: names,
            identityStore: identity,
            resolvedBackend: .configured(gatewayWsURL: "wss://gateway.test/api/v1/ws", allowSelfSignedDevHost: false),
            authClientFactory: { _, _ in client }
        )
    }

    func response(token: String, userId: String) -> AuthResponse {
        AuthResponse(token: token, user: AuthUser(
            userId: userId, displayName: "Server User", role: "adult", isAdmin: false, avatarTint: "blue"
        ))
    }
}

@MainActor
private final class StartupControlledAuth: StartupAuthenticating {
    var result: AuthResult<AuthResponse>?
    var error: Error?
    var onStart: (() -> Void)?
    private let suspended: Bool
    private var continuation: CheckedContinuation<AuthResult<AuthResponse>, Never>?

    init(suspended: Bool) { self.suspended = suspended }

    func me(token: String) async throws -> AuthResult<AuthResponse> {
        onStart?()
        if let error { throw error }
        if let result { return result }
        precondition(suspended)
        return await withCheckedContinuation { continuation = $0 }
    }

    func complete(_ result: AuthResult<AuthResponse>) {
        guard let continuation else {
            self.result = result
            return
        }
        continuation.resume(returning: result)
        self.continuation = nil
    }
}

private final class StartupMemoryTokens: NSObject, SecureTokenStore {
    private var token: String?
    func save(token: String) { self.token = token }
    func load() -> String? { token }
    func clear() { token = nil }
}

private func authFailure(_ error: AuthError) -> AuthResult<AuthResponse> {
    (AuthResultFailure(error: error) as AnyObject) as! AuthResult<AuthResponse>
}
