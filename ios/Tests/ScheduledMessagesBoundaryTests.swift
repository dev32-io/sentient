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
}
