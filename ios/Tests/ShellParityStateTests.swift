import Combine
import Foundation
import MobileData
import Observation
import SwiftUI
import Testing
import UIKit
import XCTest
@testable import SentientApp

@Suite @MainActor
struct ShellParityStateTests {
    @Test func testSLaunchAssetMatchesThinkingCanvasInNormalAndIncreasedContrast() throws {
        for contrast in [UIAccessibilityContrast.normal, .high] {
            let traits = UITraitCollection(traitsFrom: [.init(userInterfaceStyle: .dark), .init(accessibilityContrast: contrast)])
            let launch = try #require(UIColor(named: "LaunchBackground", in: Bundle(for: StartupReadinessCoordinator.self), compatibleWith: traits))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            #expect(launch.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
            var expectedRed: CGFloat = 0, expectedGreen: CGFloat = 0, expectedBlue: CGFloat = 0, expectedAlpha: CGFloat = 0
            #expect(UIColor(DuskColors.bg).getRed(&expectedRed, green: &expectedGreen, blue: &expectedBlue, alpha: &expectedAlpha))
            #expect(abs(red - expectedRed) <= 0.000001)
            #expect(abs(green - expectedGreen) <= 0.000001)
            #expect(abs(blue - expectedBlue) <= 0.000001)
            #expect(abs(alpha - expectedAlpha) <= 0.000001)
        }
    }

    @Test func testSDelayedLastCardClearNeverAnnouncesCompletionBeforeAcknowledgment() async {
        let started = XCTestExpectation(description: "disposable clear suspended")
        var completion: CheckedContinuation<ScheduledInboxClearFailure?, Never>?
        let inbox = ScheduledInboxState(loadCards: { true }, clearCards: { _ in
            await withCheckedContinuation { completion = $0; started.fulfill() }
        })
        let card = ScheduledSessionCard(sessionId: "s-disposable", scheduleId: "schedule-disposable",
                                        occurrenceId: "occurrence-disposable", intendedAt: "2026-03-09T07:00:00Z",
                                        completedAt: "2026-03-09T07:01:00Z", status: .completed, preview: "Fixture only")
        inbox.receive([card], authoritative: true)
        inbox.cardsState = .ready
        inbox.clear(card)
        #expect(inbox.hasPendingClears, "Includes queued work before worker starts")
        #expect(await XCTWaiter.fulfillment(of: [started], timeout: 2) == .completed)
        #expect(inbox.cards.isEmpty)
        #expect(scheduledInboxEmptyPresentation(cardCount: inbox.cards.count, loading: false, ready: true,
                                               pendingClear: inbox.hasPendingClears, clearFailed: false) == .clearing)
        let acknowledged = XCTestExpectation(description: "clear settled")
        withObservationTracking { _ = inbox.hasPendingClears } onChange: { acknowledged.fulfill() }
        completion?.resume(returning: nil)
        #expect(await XCTWaiter.fulfillment(of: [acknowledged], timeout: 2) == .completed)
        #expect(!inbox.hasPendingClears)
        #expect(scheduledInboxEmptyPresentation(cardCount: inbox.cards.count, loading: false, ready: true,
                                               pendingClear: inbox.hasPendingClears, clearFailed: false) == .allClear)
    }

    @Test func testSBackendProbeCannotBeStartedTwiceWhileSuspended() async {
        let started = XCTestExpectation(description: "disposable probe suspended")
        var completion: CheckedContinuation<Bool, Never>?
        var calls = 0
        var configurations: [BackendConfig] = []
        let model = BackendSetupViewModel(existing: BackendConfig(host: "fixture.invalid", port: 443, security: .tlsValid),
                                          reconfigure: { configurations.append($0) }, probe: { _ in
            calls += 1
            return await withCheckedContinuation { completion = $0; started.fulfill() }
        })
        model.save()
        model.save()
        #expect(await XCTWaiter.fulfillment(of: [started], timeout: 2) == .completed)
        #expect(calls == 1)
        #expect(model.isSaving)
        #expect(configurations.isEmpty)
        let saved = XCTestExpectation(description: "backend save settled")
        let subscription = model.$didSave.first(where: { $0 }).sink { _ in saved.fulfill() }
        defer { subscription.cancel() }
        completion?.resume(returning: true)
        #expect(await XCTWaiter.fulfillment(of: [saved], timeout: 2) == .completed)
        #expect(configurations == [BackendConfig(host: "fixture.invalid", port: 443, security: .tlsValid)])
        #expect(model.didSave)
    }

    @Test func testSExpiryContextSurvivesLogoutAndClearsOnSuccessfulLoginOrBackendChange() {
        let suite = "S-ExpiryPresentation-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let tokens = ShellParityMemoryTokens()
        let names = DisplayNameStore(defaults: defaults)
        let config = AppConfig(tokenStore: tokens, displayNameStore: names,
                               identityStore: AuthenticatedIdentityStore(defaults: defaults),
                               configStore: BackendConfigStore(defaults: defaults), resolvedBackend: .unconfigured)
        config.prepareLogin(reason: .expired)
        config.logout(reason: config.loginReason)
        #expect(config.loginReason == .expired)
        #expect(!config.hasToken)
        #expect(config.loginReason?.explanation == "Your session expired. Enter your PIN to continue.")
        tokens.save(token: "disposable-token")
        names.save("Disposable profile")
        names.saveAvatarTint("clay")
        config.didLogin(authenticatedUserId: "disposable-profile")
        #expect(config.loginReason == nil)
        #expect(config.avatarTint == "clay")
        config.logout()
        #expect(config.loginReason == nil, "Explicit logout is not expiry")
        config.prepareLogin(reason: .expired)
        config.reconfigure(BackendConfig(host: "fixture.invalid", port: 443, security: .tlsValid))
        #expect(config.loginReason == nil)
        #expect(config.avatarTint.isEmpty)
    }
}

private final class ShellParityMemoryTokens: NSObject, SecureTokenStore {
    private var token: String?
    func load() -> String? { token }
    func save(token: String) { self.token = token }
    func clear() { token = nil }
}
