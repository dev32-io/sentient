import Testing
import Foundation
import MobileData
@testable import SentientApp

struct CalendarViewModelTests {
    private func event(
        id: String,
        start: CalendarTime,
        occurrenceId: String? = nil,
        baseEventId: String? = nil
    ) -> CalendarEvent {
        CalendarEvent(
            id: id,
            scope: .household,
            title: "Dinner",
            description: nil,
            start: start,
            end: nil,
            recurrence: nil,
            exdates: nil,
            exceptions: nil,
            visibility: .everyone,
            importance: .normal,
            group: nil,
            tags: [],
            notification: nil,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            occurrenceId: occurrenceId,
            baseEventId: baseEventId
        )
    }

    @Test func listFoldAcceptsTimedAndAllDayRows() {
        let timed = event(
            id: "timed",
            start: CalendarTime.Timed(instant: "2026-08-01T13:00:00.000Z", timeZoneId: "UTC")
        )
        let allDay = event(id: "all-day", start: CalendarTime.AllDay(date: "2026-08-02"))
        let page = CalendarEventPage(events: [timed, allDay], more: 0)
        let folded = foldCalendarList(
            phase: .loading,
            events: [],
            result: SentientResultSuccess<CalendarEventPage>(data: page)
        )

        #expect(folded.phase == .ready)
        #expect(folded.events.map(\.id) == ["timed", "all-day"])
    }

    @Test func listFoldPreservesLastGoodRowsOnFailure() {
        let previous = event(id: "previous", start: CalendarTime.AllDay(date: "2026-08-01"))
        let error = SentientError.Unknown(userMessage: "Calendar unavailable", cause: nil)
        let result = SentientResultFailure(error: error) as! SentientResult<CalendarEventPage>
        let folded = foldCalendarList(phase: .ready, events: [previous], result: result)

        #expect(folded.phase == .failed("Calendar unavailable"))
        #expect(folded.events.map(\.id) == ["previous"])
    }

    @Test func crudMutationStateTransitionsAreExplicit() {
        #expect(reduceCalendarMutation(.idle, .begin) == .saving)
        #expect(reduceCalendarMutation(.saving, .success) == .idle)
        #expect(reduceCalendarMutation(.saving, .failure("No connection")) == .failed("No connection"))
    }

    @Test func occurrenceRowsKeepRowIdentitySeparateFromMutationIdentity() {
        let occurrence = event(
            id: "recurring-1",
            start: CalendarTime.Timed(instant: "2026-08-01T13:00:00.000Z", timeZoneId: "UTC"),
            occurrenceId: "occurrence-1",
            baseEventId: "recurring-1"
        )

        #expect(occurrence.rowID == "occurrence-1")
        #expect(occurrence.mutationID == "recurring-1")
    }

    @Test func startsRenderInTheRequestedDeviceTimezone() {
        #expect(CalendarDisplayFormatter.startText(CalendarTime.AllDay(date: "2026-08-01")) == "2026-08-01")
        let timed = CalendarTime.Timed(instant: "2026-08-01T13:00:00.000Z", timeZoneId: "UTC")
        #expect(
            CalendarDisplayFormatter.startText(timed, timeZone: TimeZone(identifier: "America/New_York")!)
                == "2026-08-01 09:00"
        )
    }
}
