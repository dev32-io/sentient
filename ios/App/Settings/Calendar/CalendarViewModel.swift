import Foundation
import MobileData

/// Calendar page state. Calendar operations deliberately go through the shared
/// use cases exposed by SettingsComponent; this VM owns only screen folding.
@MainActor
@Observable
final class CalendarViewModel {
    enum Phase: Equatable { case loading, ready, failed(String) }

    private(set) var phase: Phase = .loading
    private(set) var events: [CalendarEvent] = []
    private(set) var mutationError: String?

    private let settings: SettingsComponent
    private let log = AppLog("settings", "calendar-vm")

    init(settings: SettingsComponent) { self.settings = settings }

    func load() async {
        phase = .loading
        let calendar = Calendar(identifier: .gregorian)
        let today = calendar.startOfDay(for: Date())
        let from = isoDate(today)
        let to = isoDate(calendar.date(byAdding: .month, value: 3, to: today) ?? today)
        do {
            let result = try await settings.listCalendar.list(
                from: CalendarTime.AllDay(date: from),
                to: CalendarTime.AllDay(date: to),
                scope: nil, group: nil, tags: nil, importance: nil
            )
            fold(result)
        } catch is CancellationError {
        } catch {
            phase = .failed("Couldn't load calendar.")
            log.warn("load.threw")
        }
    }

    func create(_ event: CalendarEvent) async {
        await mutate { try await settings.createCalendar.create(event: event) }
    }

    func update(id: String, event: CalendarEvent) async {
        await mutate { try await settings.updateCalendar.update(id: id, event: event) }
    }

    func delete(id: String) async {
        do {
            let result = try await settings.deleteCalendar.delete(id: id)
            switch onEnum(of: result) {
            case .success: events.removeAll { $0.id == id }; mutationError = nil
            case .failure(let f): mutationError = f.error.userMessage
            case .loading: break
            }
        } catch is CancellationError {
        } catch { mutationError = "Couldn't delete calendar event." }
    }

    private func mutate(_ operation: () async throws -> SentientResult<CalendarEvent>) async {
        do {
            let result = try await operation()
            switch onEnum(of: result) {
            case .success(let s):
                if let index = events.firstIndex(where: { $0.id == s.data.id }) { events[index] = s.data }
                else { events.append(s.data) }
                events.sort { $0.startText < $1.startText }
                mutationError = nil
            case .failure(let f): mutationError = f.error.userMessage
            case .loading: break
            }
        } catch is CancellationError {
        } catch { mutationError = "Couldn't save calendar event." }
    }

    private func fold(_ result: SentientResult<CalendarEventPage>) {
        switch onEnum(of: result) {
        case .success(let s): events = s.data.events; phase = .ready
        case .failure(let f): phase = .failed(f.error.userMessage)
        case .loading: phase = .loading
        }
    }

    private func isoDate(_ date: Date) -> String {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withFullDate]
        return f.string(from: date)
    }
}

private extension CalendarEvent {
    var startText: String {
        switch onEnum(of: start) {
        case .allDay(let value): return value.date
        case .timed(let value): return value.instant
        }
    }
}
