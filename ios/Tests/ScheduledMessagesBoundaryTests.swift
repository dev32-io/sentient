import Foundation
import MobileData
import SwiftUI
import XCTest
@testable import SentientApp

final class ScheduledMessagesBoundaryTests: XCTestCase {
    func testClearAllCancellationLeavesConfirmationInactive() {
        var intent = ScheduledInboxClearAllIntent()
        intent.request(.initial, canClear: true)
        XCTAssertTrue(intent.isPresented)

        intent.cancel()

        XCTAssertFalse(intent.isPresented)
    }

    func testBulkRetryReopensConfirmationBeforeDestructiveRequest() {
        var intent = ScheduledInboxClearAllIntent()

        intent.request(.retry, canClear: true)

        XCTAssertTrue(intent.isPresented)
        XCTAssertEqual(intent.reason, .retry)
    }

    func testUnknownClearOutcomeOffersHonestReconciliationCopy() {
        XCTAssertEqual(ScheduledInboxClearFailure.unknownOutcome.title, "Clear outcome unknown")
        XCTAssertTrue(ScheduledInboxClearFailure.unknownOutcome.detail.contains("Reload"))
        XCTAssertFalse(ScheduledInboxClearFailure.unknownOutcome.detail.contains("not cleared"))
    }

    @MainActor
    func testOptimisticClearKeepsKnownPositionsAndPrependsOnlyNewArrivals() async {
        let cleared = scheduledCard("clear-me")
        let retained = scheduledCard("retained")
        let arrival = scheduledCard("arrival")
        let clearStarted = expectation(description: "clear started")
        let clears = SuspendedInboxClears(starts: [clearStarted])
        let inbox = ScheduledInboxState(loadCards: { true }, clearCards: { try await clears.run($0) })
        inbox.receive([cleared, retained], authoritative: true)

        inbox.clear(cleared)
        await fulfillment(of: [clearStarted], timeout: 2)
        inbox.receive([cleared, arrival], authoritative: false)
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), [arrival.occurrenceId, retained.occurrenceId])

        clears.complete(0, with: .failed("Try again"))
        await waitUntil { inbox.clearFailure != nil }
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), [arrival.occurrenceId, cleared.occurrenceId, retained.occurrenceId])

        inbox.receive([retained], authoritative: false)
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), [arrival.occurrenceId, cleared.occurrenceId, retained.occurrenceId])
    }

    func testSuccessfulClearDoesNotResurrectFromStaleSnapshotAndClearAllRetryTargetStaysFrozen() {
        let old = scheduledCard("old")
        let arrival = scheduledCard("arrival")
        var projection = ScheduledInboxProjection()
        projection.receive([old], authoritative: true)
        let retryTarget = ScheduledInboxClearTarget(occurrenceIds: Set(projection.cards.map(\.occurrenceId)), requiresConfirmation: true)

        projection.beginClear(retryTarget.occurrenceIds)
        projection.finishClear(retryTarget.occurrenceIds, succeeded: true)
        projection.receive([old, arrival], authoritative: false)
        XCTAssertEqual(projection.cards.map(\.occurrenceId), [arrival.occurrenceId])
        XCTAssertEqual(retryTarget.occurrenceIds, [old.occurrenceId], "retry must not capture later arrivals")
    }

    @MainActor
    func testCancelRestoresQueuedAndCurrentClearsAndFencesLateWorkerCleanup() async {
        let firstStarted = expectation(description: "first clear started")
        let restarted = expectation(description: "restarted clear started")
        let trailingStarted = expectation(description: "trailing clear started")
        let clears = SuspendedInboxClears(starts: [firstStarted, restarted, trailingStarted])
        var reloads = 0
        let inbox = ScheduledInboxState(
            loadCards: { reloads += 1; return true },
            clearCards: { try await clears.run($0) }
        )
        let a = scheduledCard("a")
        let b = scheduledCard("b")
        inbox.receive([a, b], authoritative: true)

        inbox.clear(a)
        inbox.clear(b)
        await fulfillment(of: [firstStarted], timeout: 2)
        inbox.cancel()
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), ["a", "b"])
        await inbox.reload()
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), ["a", "b"])

        inbox.clear(a)
        await fulfillment(of: [restarted], timeout: 2)
        clears.complete(0)
        await Task.yield()
        inbox.clear(b)
        XCTAssertEqual(clears.calls.count, 2, "late cancelled worker must not clear restarted task ownership")

        clears.complete(1)
        await fulfillment(of: [trailingStarted], timeout: 2)
        clears.complete(2)
        await waitUntil { inbox.cards.isEmpty }
    }

    @MainActor
    func testOperationCancellationRestoresTargetAndFreezesRetry() async {
        let card = scheduledCard("cancelled")
        var calls: [[String]] = []
        let inbox = ScheduledInboxState(
            loadCards: { true },
            clearCards: { ids in
                calls.append(ids)
                if calls.count == 1 { throw CancellationError() }
                return nil
            }
        )
        inbox.receive([card], authoritative: true)

        inbox.clear(card)
        await waitUntil { inbox.clearFailure == .unknownOutcome }
        XCTAssertEqual(inbox.cards.map(\.occurrenceId), [card.occurrenceId])
        XCTAssertFalse(inbox.clearRetryRequiresConfirmation)

        inbox.retryClear()
        await waitUntil { calls.count == 2 && inbox.cards.isEmpty }
        XCTAssertEqual(calls, [[card.occurrenceId], [card.occurrenceId]])
    }

    @MainActor
    func testCanceledReloadIgnoringCancellationCannotClearRecoveryState() async {
        let clearFinished = expectation(description: "clear failed")
        let loadStarted = expectation(description: "load started")
        var loadContinuation: CheckedContinuation<Bool, Never>?
        let inbox = ScheduledInboxState(
            loadCards: {
                loadStarted.fulfill()
                return await withCheckedContinuation { loadContinuation = $0 }
            },
            clearCards: { _ in
                clearFinished.fulfill()
                return .failed("Try again")
            }
        )
        inbox.receive([scheduledCard("failed")], authoritative: true)
        inbox.clearAll()
        await fulfillment(of: [clearFinished], timeout: 2)
        await waitUntil { inbox.clearFailure != nil }

        let reload = Task { await inbox.reload() }
        await fulfillment(of: [loadStarted], timeout: 2)
        inbox.cancel()
        loadContinuation?.resume(returning: true)
        await reload.value

        XCTAssertEqual(inbox.clearFailure, .failed("Try again"))
        XCTAssertTrue(inbox.clearRetryRequiresConfirmation)
    }

    func testDraftBuildsBoundedAbsoluteDelayAndRecurringInputs() {
        var once = ScheduleDraft(message: "Follow up", mode: .once, date: Date().addingTimeInterval(600))
        XCTAssertNotNil(once.createRequest)

        once.mode = .delay
        once.delayMinutes = 30
        guard case .onceAfter(let delay) = onEnum(of: once.timing!) else { return XCTFail("Expected delay") }
        XCTAssertEqual(delay.afterSeconds, 1_800)

        once.mode = .recurring
        once.frequency = .weekly
        once.weekday = 0
        once.timeZone = "America/Los_Angeles"
        guard case .recurring(let recurring) = onEnum(of: once.timing!) else { return XCTFail("Expected recurrence") }
        XCTAssertEqual(recurring.timeZone, "America/Los_Angeles")
        XCTAssertEqual(recurring.weekdays, [.monday])
    }

    func testRecurringSaveValidationPublishesErrorsAndKeepsDraftUntilCorrected() {
        var draft = ScheduleDraft(message: "Morning update", mode: .recurring)
        let original = draft.localTime
        var fields = ScheduleEditorFields(
            absolute: "",
            delay: "30",
            recurringTime: "9:00",
            dayOfMonth: "1",
            timeZone: "Not/AZone"
        )
        var errors = fields.apply(to: &draft)
        XCTAssertEqual(errors.timeZone, "Enter a valid IANA time zone.")
        XCTAssertEqual(draft.localTime, original)
        XCTAssertNil(draft.createRequest)

        fields.timeZone = "America/Los_Angeles"
        errors = fields.apply(to: &draft)
        XCTAssertEqual(errors.recurringTime, "Enter time as HH:mm, for example 09:00.")
        XCTAssertEqual(draft.localTime, original)

        fields.recurringTime = "24:00"
        errors = fields.apply(to: &draft)
        XCTAssertNotNil(errors.recurringTime)
        fields.recurringTime = "09:00"
        errors = fields.apply(to: &draft)
        XCTAssertTrue(errors.isEmpty)
        XCTAssertNil(draft.validationMessage)
        XCTAssertNotNil(draft.createRequest)
    }

    func testDraftRejectsInvalidUserInputBeforeCrossingSharedBoundary() {
        var draft = ScheduleDraft()
        XCTAssertNotNil(draft.validationMessage)
        draft.message = "Message"
        draft.mode = .delay
        draft.delayMinutes = 0
        XCTAssertNil(draft.createRequest)
        draft.mode = .recurring
        draft.timeZone = "Not/AZone"
        XCTAssertNil(draft.createRequest)
    }

    func testInboxSwipeSnapAndArmBoundaries() {
        var belowSnap = inboxSwipe(distance: ScheduledInboxSwipeMetrics.snapDistance - 1)
        XCTAssertEqual(belowSnap.finish(width: 300), .close)

        var atSnap = inboxSwipe(distance: ScheduledInboxSwipeMetrics.snapDistance)
        XCTAssertEqual(atSnap.finish(width: 300), .reveal)

        var armed = inboxSwipe(distance: 300 * ScheduledInboxSwipeMetrics.armFraction)
        XCTAssertTrue(armed.isArmed(width: 300))
        XCTAssertEqual(armed.finish(width: 300), .clear)
    }

    func testOneContinuousSwipeFromCenterRevealsThenArmsBeforeScreenEdge() {
        for screenWidth: CGFloat in [320, 390, 430] {
            for direction: LayoutDirection in [.leftToRight, .rightToLeft] {
                let rowWidth = screenWidth - 36
                let sign: CGFloat = direction == .leftToRight ? -1 : 1
                var swipe = ScheduledInboxSwipeState()
                swipe.update(
                    translation: CGSize(width: sign * 90, height: 0),
                    initialDistance: 0,
                    width: rowWidth,
                    layoutDirection: direction
                )
                XCTAssertFalse(swipe.isArmed(width: rowWidth))
                var releasedEarly = swipe
                XCTAssertEqual(releasedEarly.finish(width: rowWidth), .reveal)

                // Continue the SAME touch from screen center to 8% from its edge.
                // The parent now marks this row revealed; it must not add another offset.
                // UIKit consumes initial movement before recognizing the pan (~10pt observed).
                let travel = screenWidth * 0.42 - 12
                swipe.update(
                    translation: CGSize(width: sign * travel, height: 0),
                    initialDistance: ScheduledInboxSwipeMetrics.revealDistance,
                    width: rowWidth,
                    layoutDirection: direction
                )
                XCTAssertEqual(swipe.distance, travel)
                XCTAssertTrue(swipe.isArmed(width: rowWidth))
                XCTAssertEqual(swipe.finish(width: rowWidth), .clear)
            }
        }
    }

    func testInterruptedSwipeRestoresInitialRevealWithoutClearing() {
        var closed = inboxSwipe(distance: 250)
        XCTAssertFalse(closed.cancel())
        XCTAssertEqual(closed.distance, 0)

        var revealed = ScheduledInboxSwipeState()
        revealed.update(
            translation: CGSize(width: -200, height: 0),
            initialDistance: ScheduledInboxSwipeMetrics.revealDistance,
            width: 300,
            layoutDirection: .leftToRight
        )
        XCTAssertTrue(revealed.isArmed(width: 300))
        XCTAssertTrue(revealed.cancel())
        XCTAssertEqual(revealed.distance, 0)
        XCTAssertEqual(revealed.intent, .idle)
    }

    func testInboxSwipeDragBackVerticalIntentAndRTL() {
        var dragBack = ScheduledInboxSwipeState()
        dragBack.update(
            translation: CGSize(width: 80, height: 0),
            initialDistance: ScheduledInboxSwipeMetrics.revealDistance,
            width: 300,
            layoutDirection: .leftToRight
        )
        XCTAssertEqual(dragBack.finish(width: 300), .close)

        var vertical = ScheduledInboxSwipeState()
        vertical.update(
            translation: CGSize(width: -4, height: 12),
            initialDistance: 0,
            width: 300,
            layoutDirection: .leftToRight
        )
        XCTAssertEqual(vertical.intent, .vertical)
        XCTAssertEqual(vertical.finish(width: 300), .unchanged)

        var rtl = ScheduledInboxSwipeState()
        rtl.update(
            translation: CGSize(width: 300, height: 0),
            initialDistance: 0,
            width: 300,
            layoutDirection: .rightToLeft
        )
        XCTAssertEqual(rtl.finish(width: 300), .clear)
    }

    private func inboxSwipe(distance: CGFloat) -> ScheduledInboxSwipeState {
        var state = ScheduledInboxSwipeState()
        state.update(
            translation: CGSize(width: -distance, height: 0),
            initialDistance: 0,
            width: 300,
            layoutDirection: .leftToRight
        )
        return state
    }
}

@MainActor
private func waitUntil(
    timeout: Duration = .seconds(2),
    _ condition: () -> Bool
) async {
    let deadline = ContinuousClock.now + timeout
    while !condition(), ContinuousClock.now < deadline { await Task.yield() }
    XCTAssertTrue(condition(), "Timed out waiting for async state")
}

private func scheduledCard(_ occurrenceId: String) -> ScheduledSessionCard {
    ScheduledSessionCard(
        sessionId: "session-\(occurrenceId)",
        scheduleId: "schedule",
        occurrenceId: occurrenceId,
        intendedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        status: .completed,
        preview: "Done"
    )
}

@MainActor
private final class SuspendedInboxClears {
    private let starts: [XCTestExpectation]
    private var continuations: [CheckedContinuation<ScheduledInboxClearFailure?, Never>?]
    private(set) var calls: [[String]] = []

    init(starts: [XCTestExpectation]) {
        self.starts = starts
        continuations = Array(repeating: nil, count: starts.count)
    }

    func run(_ ids: [String]) async throws -> ScheduledInboxClearFailure? {
        let index = calls.count
        calls.append(ids)
        starts[index].fulfill()
        return await withCheckedContinuation { continuations[index] = $0 }
    }

    func complete(_ index: Int, with result: ScheduledInboxClearFailure? = nil) {
        continuations[index]?.resume(returning: result)
        continuations[index] = nil
    }
}
