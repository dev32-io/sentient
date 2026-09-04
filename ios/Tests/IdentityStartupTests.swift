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
            reducedMotion: true,
            driver: driver
        )

        XCTAssertEqual(controller.state, .thinking)
        XCTAssertTrue(controller.reducedMotion)
        XCTAssertEqual(driver.reducedMotion, [true])
        XCTAssertEqual(driver.transitions, [.thinking])
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
}
