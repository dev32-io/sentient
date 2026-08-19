import Foundation
import MobileData

/// Calendar page state. Calendar operations deliberately go through the shared
/// use cases exposed by SettingsComponent; this VM owns only screen folding.
@MainActor
protocol CalendarUseCaseOperations {
    func listBoth(
        timedFrom: CalendarTime.Timed,
        timedTo: CalendarTime.Timed,
        allDayFrom: CalendarTime.AllDay,
        allDayTo: CalendarTime.AllDay,
        scope: CalendarScope?,
        group: String?,
        tags: [String]?,
        importance: Importance?
    ) async throws -> SentientResult<CalendarEventPage>
    func create(event: CalendarEvent) async throws -> SentientResult<CalendarEvent>
    func update(id: String, event: CalendarEvent) async throws -> SentientResult<CalendarEvent>
    func delete(id: String) async throws -> SentientResult<KotlinUnit>
}

@MainActor
private struct SettingsCalendarUseCases: CalendarUseCaseOperations {
    let settings: SettingsComponent

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
        try await settings.listCalendar.listBoth(
            timedFrom: timedFrom,
            timedTo: timedTo,
            allDayFrom: allDayFrom,
            allDayTo: allDayTo,
            scope: scope,
            group: group,
            tags: tags,
            importance: importance
        )
    }

    func create(event: CalendarEvent) async throws -> SentientResult<CalendarEvent> {
        try await settings.createCalendar.create(event: event)
    }

    func update(id: String, event: CalendarEvent) async throws -> SentientResult<CalendarEvent> {
        try await settings.updateCalendar.update(id: id, event: event)
    }

    func delete(id: String) async throws -> SentientResult<KotlinUnit> {
        try await settings.deleteCalendar.delete(id: id)
    }
}

@MainActor
@Observable
final class CalendarViewModel {
    enum Phase: Equatable { case loading, ready, failed(String) }
    enum Mutation: Equatable { case idle, saving, failed(String) }

    private(set) var phase: Phase = .loading
    private(set) var events: [CalendarEvent] = []
    private(set) var mutation: Mutation = .idle
    var mutationError: String? {
        if case .failed(let message) = mutation { return message }
        return nil
    }

    private let useCases: any CalendarUseCaseOperations
    private let log = AppLog("settings", "calendar-vm")

    init(settings: SettingsComponent) {
        self.useCases = SettingsCalendarUseCases(settings: settings)
    }

    init(useCases: any CalendarUseCaseOperations) {
        self.useCases = useCases
    }

    func load() async {
        phase = .loading
        let calendar = deviceCalendar()
        let today = calendar.startOfDay(for: Date())
        let end = calendar.date(byAdding: .year, value: 1, to: today) ?? today
        let zone = TimeZone.current.identifier.isEmpty ? "UTC" : TimeZone.current.identifier
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        do {
            // The REST/store contract accepts only one time kind per window.
            // Fetch both kinds through the shared use case and fold its merged page.
            let result = try await useCases.listBoth(
                timedFrom: CalendarTime.Timed(instant: formatter.string(from: today), timeZoneId: zone),
                timedTo: CalendarTime.Timed(
                    instant: formatter.string(from: calendar.date(byAdding: .day, value: 1, to: end) ?? end),
                    timeZoneId: zone
                ),
                allDayFrom: CalendarTime.AllDay(date: isoDate(today)),
                allDayTo: CalendarTime.AllDay(date: isoDate(end)),
                scope: nil, group: nil, tags: nil, importance: nil
            )
            fold(result)
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load calendar.")
            log.warn("load.threw")
        }
    }

    func create(title: String, date: String) async {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !date.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              mutation != .saving else { return }
        let event = CalendarEvent(
            id: UUID().uuidString,
            scope: .household,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: nil,
            start: CalendarTime.AllDay(date: date.trimmingCharacters(in: .whitespacesAndNewlines)),
            end: nil,
            recurrence: nil,
            exdates: nil,
            exceptions: nil,
            visibility: .everyone,
            importance: .normal,
            group: nil,
            tags: [],
            notification: nil,
            createdAt: "",
            updatedAt: "",
            occurrenceId: nil,
            baseEventId: nil
        )
        await create(event)
    }

    /// Use-case-shaped create entry retained for callers that already have a full event.
    func create(_ event: CalendarEvent) async {
        guard mutation != .saving else { return }
        await mutate { try await useCases.create(event: event) }
    }

    func update(event: CalendarEvent, title: String, date: String) async {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !date.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              mutation != .saving else { return }
        let edited = replacing(
            event,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            start: event.editedStart(from: date.trimmingCharacters(in: .whitespacesAndNewlines))
        )
        await update(id: event.mutationID, event: edited)
    }

    /// Kept as the use-case-shaped entry point for callers that already built a patch.
    func update(id: String, event: CalendarEvent) async {
        guard mutation != .saving else { return }
        await mutate(replacing: event) { try await useCases.update(id: id, event: event) }
    }

    func delete(event: CalendarEvent) async {
        await delete(id: event.mutationID)
    }

    func delete(id: String) async {
        guard mutation != .saving else { return }
        mutation = reduceCalendarMutation(mutation, .begin)
        do {
            let result = try await useCases.delete(id: id)
            switch onEnum(of: result) {
            case .success:
                events.removeAll { $0.mutationID == id }
                mutation = reduceCalendarMutation(mutation, .success)
            case .failure(let f): mutation = reduceCalendarMutation(mutation, .failure(f.error.userMessage))
            case .loading: break
            }
        } catch is CancellationError {
        } catch { mutation = reduceCalendarMutation(mutation, .failure("Couldn't delete calendar event.")) }
    }

    private func mutate(replacing original: CalendarEvent? = nil, _ operation: () async throws -> SentientResult<CalendarEvent>) async {
        mutation = reduceCalendarMutation(mutation, .begin)
        do {
            let result = try await operation()
            switch onEnum(of: result) {
            case .success(let s):
                let rowID = s.data.rowID
                let index = events.firstIndex { row in
                    if let original {
                        if row.rowID == original.rowID { return true }
                        if let occurrenceId = original.occurrenceId, row.occurrenceId == occurrenceId { return true }
                        if let baseEventId = original.baseEventId, row.baseEventId == baseEventId,
                           (original.occurrenceId == nil || row.occurrenceId == original.occurrenceId) { return true }
                    }
                    return row.rowID == rowID
                }
                if let index { events[index] = s.data }
                else { events.append(s.data) }
                events.sort { $0.calendarSortText < $1.calendarSortText }
                mutation = reduceCalendarMutation(mutation, .success)
            case .failure(let f): mutation = reduceCalendarMutation(mutation, .failure(f.error.userMessage))
            case .loading: break
            }
        } catch is CancellationError {
        } catch { mutation = reduceCalendarMutation(mutation, .failure("Couldn't save calendar event.")) }
    }

    private func fold(_ result: SentientResult<CalendarEventPage>) {
        let folded = foldCalendarList(phase: phase, events: events, result: result)
        phase = folded.phase
        events = folded.events
    }

    private func deviceCalendar() -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    private func isoDate(_ date: Date) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate]
        return f.string(from: date)
    }
}

enum CalendarMutationAction {
    case begin
    case success
    case failure(String)
}

/// Pure mutation state fold used by the VM and its unit tests.
func reduceCalendarMutation(_ state: CalendarViewModel.Mutation, _ action: CalendarMutationAction) -> CalendarViewModel.Mutation {
    switch action {
    case .begin: return .saving
    case .success: return .idle
    case .failure(let message): return .failed(message)
    }
}

struct CalendarListFold {
    let phase: CalendarViewModel.Phase
    let events: [CalendarEvent]
}

/// Pure list fold used by the VM and its unit tests.
func foldCalendarList(
    phase: CalendarViewModel.Phase,
    events: [CalendarEvent],
    result: SentientResult<CalendarEventPage>
) -> CalendarListFold {
    switch onEnum(of: result) {
    case .success(let s): return CalendarListFold(phase: .ready, events: s.data.events)
    case .failure(let f): return CalendarListFold(phase: .failed(f.error.userMessage), events: events)
    case .loading: return CalendarListFold(phase: .loading, events: events)
    }
}

/// Device-timezone formatting shared by the screen and deterministic unit tests.
enum CalendarDisplayFormatter {
    static func startText(_ start: CalendarTime, timeZone: TimeZone = .current) -> String {
        switch onEnum(of: start) {
        case .allDay(let value): return value.date
        case .timed(let value):
            guard let instant = parseInstant(value.instant) else { return "Invalid date" }
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = timeZone
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            return formatter.string(from: instant)
        }
    }

    static func editorText(_ start: CalendarTime, timeZone: TimeZone = .current) -> String {
        switch onEnum(of: start) {
        case .allDay(let value): return value.date
        case .timed(let value):
            guard let instant = parseInstant(value.instant) else { return "" }
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = timeZone
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            return formatter.string(from: instant)
        }
    }

    private static func parseInstant(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? {
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }()
    }
}

extension CalendarEvent {
    var rowID: String { occurrenceId ?? id }
    var mutationID: String { baseEventId ?? id }
    var calendarStartText: String { CalendarDisplayFormatter.startText(start) }
    var calendarSortText: String { calendarStartText }

    func editedStart(from value: String) -> CalendarTime {
        switch onEnum(of: start) {
        case .allDay: return CalendarTime.AllDay(date: value)
        case .timed(let original):
            // The editor accepts a local date or local date+time, but the event
            // remains timed and keeps its event timezone id in either case.
            let deviceCalendar = Calendar.current
            let parser = DateFormatter()
            parser.calendar = deviceCalendar
            parser.locale = Locale(identifier: "en_US_POSIX")
            parser.timeZone = .current
            parser.dateFormat = value.count == 10 ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm"
            let instant = parser.date(from: value)?.ISO8601Format() ?? original.instant
            return CalendarTime.Timed(instant: instant, timeZoneId: original.timeZoneId)
        }
    }
}

private func replacing(_ event: CalendarEvent, title: String, start: CalendarTime) -> CalendarEvent {
    CalendarEvent(
        id: event.id,
        scope: event.scope,
        title: title,
        description: event.description,
        start: start,
        end: event.end,
        recurrence: event.recurrence,
        exdates: event.exdates,
        exceptions: event.exceptions,
        visibility: event.visibility,
        importance: event.importance,
        group: event.group,
        tags: event.tags,
        notification: event.notification,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        occurrenceId: event.occurrenceId,
        baseEventId: event.baseEventId
    )
}
