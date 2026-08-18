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

    @Test @MainActor func crudCallsUseCasesAndAllDayUpdateUsesEditedDate() async {
        let useCases = CalendarUseCaseSpy()
        let viewModel = CalendarViewModel(useCases: useCases)
        let original = event(
            id: "occurrence-row",
            start: CalendarTime.AllDay(date: "2026-08-01"),
            occurrenceId: "occurrence-1",
            baseEventId: "base-event-1"
        )

        await viewModel.create(title: " Picnic ", date: "2026-08-02")
        #expect(useCases.created?.title == "Picnic")
        #expect(useCases.created?.createdAt == "")
        #expect(useCases.created?.updatedAt == "")

        await viewModel.update(event: original, title: "Updated", date: "2026-08-04")
        #expect(useCases.updatedID == "base-event-1")
        #expect(useCases.updated?.title == "Updated")
        if let updated = useCases.updated {
            if case .allDay(let start) = onEnum(of: updated.start) {
                #expect(start.date == "2026-08-04")
            } else {
                Issue.record("all-day update changed the event kind")
            }
        } else {
            Issue.record("update use case was not called")
        }

        await viewModel.delete(event: original)
        #expect(useCases.deletedID == "base-event-1")
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

@MainActor
private final class CalendarUseCaseSpy: CalendarUseCaseOperations {
    var created: CalendarEvent?
    var updatedID: String?
    var updated: CalendarEvent?
    var deletedID: String?

    func listBoth(
        timedFrom: CalendarTime.Timed,
        timedTo: CalendarTime.Timed,
        allDayFrom: CalendarTime.AllDay,
        allDayTo: CalendarTime.AllDay,
        scope: CalendarScope?,
        group: String?,
        tags: [String]?,
        importance: Importance?
    ) async throws -> SentientResult<CalendarEventPage> {
        SentientResultSuccess(data: CalendarEventPage(events: [], more: 0))
    }

    func create(event: CalendarEvent) async throws -> SentientResult<CalendarEvent> {
        created = event
        return SentientResultSuccess(data: event)
    }

    func update(id: String, event: CalendarEvent) async throws -> SentientResult<CalendarEvent> {
        updatedID = id
        updated = event
        return SentientResultSuccess(data: event)
    }

    func delete(id: String) async throws -> SentientResult<KotlinUnit> {
        deletedID = id
        return SentientResultSuccess(data: KotlinUnit())
    }
}
