import Foundation
import MobileData
import XCTest
@testable import SentientApp

final class ScheduledMessagesBoundaryTests: XCTestCase {
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
}
