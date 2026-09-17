import CryptoKit
import MobileData
import RiveRuntime
import SwiftUI
import XCTest
@testable import SentientApp

@MainActor
private final class RecordingIdentityDriver: SentientIdentityDriving {
    var reducedMotion: [Bool] = []
    var transitions: [SentientIdentityState] = []
    var renderingActivity: [Bool] = []

    func setReducedMotion(_ reduced: Bool) { reducedMotion.append(reduced) }
    func transition(to state: SentientIdentityState) { transitions.append(state) }
    func setRenderingActive(_ active: Bool) { renderingActivity.append(active) }
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
        controller.setRenderingActive(true)
        controller.synchronize(state: .idle, reducedMotion: false)
        controller.request(.thinking)
        controller.request(.responding)
        controller.setReducedMotion(true)

        XCTAssertEqual(controller.state, .responding)
        XCTAssertEqual(driver.transitions, [.idle, .thinking, .responding, .responding])
        XCTAssertEqual(driver.reducedMotion, [false, true])
    }

    func testIdentityRenderingStopsOffscreenWithoutDuplicateLifecycleWork() {
        let driver = RecordingIdentityDriver()
        let controller = SentientIdentityStateController(state: .idle, driver: driver)

        controller.setRenderingActive(true)
        controller.setRenderingActive(true)
        controller.setRenderingActive(false)
        controller.setRenderingActive(false)
        controller.setRenderingActive(true)

        XCTAssertEqual(driver.renderingActivity, [true, false, true])
    }

    func testReducedMotionStartsWithTheRequestedStaticVariant() {
        let driver = RecordingIdentityDriver()
        let controller = SentientIdentityStateController(
            state: .thinking,
            reducedMotion: true,
            driver: driver
        )

        XCTAssertTrue(driver.reducedMotion.isEmpty)
        XCTAssertTrue(driver.transitions.isEmpty)

        controller.setRenderingActive(true)

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
        XCTAssertTrue(driver.transitions.isEmpty)

        controller.setRenderingActive(true)

        XCTAssertEqual(controller.state, .responding)
        XCTAssertTrue(controller.reducedMotion)
        XCTAssertEqual(driver.reducedMotion, [true])
        XCTAssertEqual(driver.transitions, [.responding])
    }

    func testInactiveRiveDoesNotWakeAndResumeAppliesLatestState() throws {
        let model = RiveIdentityModel(initialState: .thinking, autoPlay: false)
        let rive = try XCTUnwrap(model.riveViewModel)
        _ = rive.createRiveView()

        model.controller.setRenderingActive(true)
        XCTAssertTrue(rive.isPlaying)
        model.controller.setRenderingActive(false)
        XCTAssertFalse(rive.isPlaying)

        model.controller.request(.responding)
        model.controller.setReducedMotion(true)
        XCTAssertFalse(rive.isPlaying)

        model.controller.setRenderingActive(true)
        XCTAssertEqual(model.controller.state, .responding)
        XCTAssertTrue(model.controller.reducedMotion)
        XCTAssertFalse(rive.isPlaying, "authored Reduced Motion state must settle without a display link")
    }

    func testDecodedIdentityAssetIsSharedButAnimationStateIsIndependent() throws {
        let first = RiveIdentityModel(initialState: .thinking)
        let second = RiveIdentityModel(initialState: .responding)
        let firstRuntime = try XCTUnwrap(first.riveViewModel?.riveModel)
        let secondRuntime = try XCTUnwrap(second.riveViewModel?.riveModel)
        XCTAssertTrue(firstRuntime.riveFile === secondRuntime.riveFile)
        XCTAssertFalse(firstRuntime === secondRuntime)
        XCTAssertFalse(try XCTUnwrap(firstRuntime.artboard) === XCTUnwrap(secondRuntime.artboard))
        XCTAssertFalse(try XCTUnwrap(firstRuntime.stateMachine) === XCTUnwrap(secondRuntime.stateMachine))
        first.controller.setReducedMotion(true)
        XCTAssertFalse(second.controller.reducedMotion)
        XCTAssertEqual(second.controller.state, .responding)
    }

    func testRiveIdentityModelReleasesAfterOwnershipEnds() async throws {
        for _ in 0..<16 {
            weak var releasedModel: RiveIdentityModel?
            weak var releasedViewModel: RiveViewModel?
            weak var releasedView: RiveView?
            autoreleasepool {
                let model = RiveIdentityModel(initialState: .thinking)
                XCTAssertNotNil(model.riveViewModel)
                releasedModel = model
                releasedViewModel = model.riveViewModel
                releasedView = model.riveViewModel?.createRiveView()
                model.controller.setRenderingActive(true)
                model.controller.setRenderingActive(false)
            }
            XCTAssertNil(releasedModel)
            XCTAssertNil(releasedViewModel)
            // Rive.pause() drains queued playback callbacks on its next display tick.
            try await DisplayFrameWaiter.next()
            XCTAssertNil(releasedView, "The shared asset must not retain a recycled runtime view")
        }
    }

    func testIdleMarkNeverBuildsRiveAndActiveToIdleRemovesRuntimeView() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let host = UIHostingController(rootView: SentientMark(size: 72, mode: .idle)
            .environment(\.scenePhase, .active))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 120, height: 120)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func runtimeView(in view: UIView) -> RiveView? {
            if let rive = view as? RiveView { return rive }
            return view.subviews.lazy.compactMap { runtimeView(in: $0) }.first
        }
        func verifyMountedRive(_ expected: Bool) async throws {
            var stableFrames = 0
            for _ in 0..<30 {
                host.view.setNeedsLayout()
                host.view.layoutIfNeeded()
                try await DisplayFrameWaiter.next()
                let rive = runtimeView(in: host.view)
                let playing = (rive?.playerDelegate as? RiveViewModel)?.isPlaying == true
                if (rive != nil) == expected && playing == expected {
                    stableFrames += 1
                    if stableFrames == 3 { return }
                } else {
                    stableFrames = 0
                }
            }
            XCTFail("Identity did not reach expected runtime-view ownership")
        }

        try await verifyMountedRive(false)
        host.rootView = SentientMark(size: 72, mode: .thinking).environment(\.scenePhase, .active)
        try await verifyMountedRive(true)
        host.rootView = SentientMark(size: 72, mode: .idle).environment(\.scenePhase, .active)
        try await verifyMountedRive(false)
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
