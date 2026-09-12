import Foundation
import MobileData

@MainActor
@Observable
final class ScheduledMessagesViewModel {
    enum LoadState { case loading, ready, failed(String) }
    var schedules: [Schedule] = []
    var cards: [ScheduledSessionCard] = []
    var scheduleState: LoadState = .loading
    var cardsState: LoadState = .loading
    var mutationError: String?
    var isMutating = false

    private let useCases: ScheduleUseCases
    @ObservationIgnored private nonisolated(unsafe) var scheduleTask: Task<Void, Never>?
    @ObservationIgnored private nonisolated(unsafe) var cardsTask: Task<Void, Never>?

    init(useCases: ScheduleUseCases) { self.useCases = useCases }
    deinit { scheduleTask?.cancel(); cardsTask?.cancel() }

    func start() {
        guard scheduleTask == nil else { return }
        scheduleTask = Task { [weak self, useCases] in
            for await value in useCases.schedules {
                guard let self, !Task.isCancelled else { return }
                switch onEnum(of: value) {
                case .loading(let loading): self.schedules = (loading.partial as? [Schedule]) ?? self.schedules; self.scheduleState = .loading
                case .success(let success): self.schedules = (success.data as? [Schedule]) ?? []; self.scheduleState = .ready
                case .failure(let failure): self.scheduleState = .failed(failure.error.userMessage)
                }
            }
        }
        cardsTask = Task { [weak self, useCases] in
            for await value in useCases.cards {
                guard let self, !Task.isCancelled else { return }
                switch onEnum(of: value) {
                case .loading(let loading): self.cards = (loading.partial as? [ScheduledSessionCard]) ?? self.cards; self.cardsState = .loading
                case .success(let success): self.cards = (success.data as? [ScheduledSessionCard]) ?? []; self.cardsState = .ready
                case .failure(let failure): self.cardsState = .failed(failure.error.userMessage)
                }
            }
        }
        Task { await reload() }
    }

    func reload() async {
        do { _ = try await useCases.reload(limit: 100); _ = try await useCases.loadCards(limit: 100) }
        catch is CancellationError {} catch { scheduleState = .failed("Couldn't load scheduled messages.") }
    }

    func create(_ draft: ScheduleDraft) async -> Bool {
        guard let request = draft.createRequest else { mutationError = draft.validationMessage; return false }
        return await mutate { try await self.useCases.create(request: request) }
    }

    func update(_ schedule: Schedule, draft: ScheduleDraft) async -> Bool {
        guard draft.validationMessage == nil, let timing = draft.timing else { mutationError = draft.validationMessage; return false }
        let changes = ScheduleChanges(message: draft.message, timing: timing, enabled: nil)
        return await mutate { try await self.useCases.edit(schedule: schedule, changes: changes) }
    }

    func toggle(_ schedule: Schedule) async {
        _ = await mutate {
            schedule.enabled ? try await self.useCases.pause(schedule: schedule) : try await self.useCases.resume(schedule: schedule)
        }
    }

    func delete(_ schedule: Schedule) async { _ = await mutate { try await self.useCases.delete(schedule: schedule) } }
    func select(_ card: ScheduledSessionCard) { useCases.select(card: card) }

    private func mutate<T>(_ operation: () async throws -> SentientResult<T>) async -> Bool {
        isMutating = true; mutationError = nil
        defer { isMutating = false }
        do {
            switch onEnum(of: try await operation()) {
            case .success: return true
            case .failure(let failure): mutationError = failure.error.userMessage; return false
            case .loading: return false
            }
        } catch is CancellationError { return false }
        catch { mutationError = "Couldn't save this change. Please try again."; return false }
    }

}

enum ScheduleDraftMode: String, CaseIterable { case once = "Once", delay = "After delay", recurring = "Recurring" }
enum ScheduleDraftFrequency: String, CaseIterable { case daily = "Daily", weekly = "Weekly", monthly = "Monthly" }

struct ScheduleEditorFieldErrors: Equatable {
    var absolute: String?
    var recurringTime: String?
    var timeZone: String?
    var isEmpty: Bool { absolute == nil && recurringTime == nil && timeZone == nil }
}

struct ScheduleEditorFields {
    var absolute: String
    var delay: String
    var recurringTime: String
    var dayOfMonth: String
    var timeZone: String

    @discardableResult
    func apply(to draft: inout ScheduleDraft) -> ScheduleEditorFieldErrors {
        var errors = ScheduleEditorFieldErrors()
        draft.delayMinutes = Int(delay) ?? 0
        draft.dayOfMonth = Int(dayOfMonth) ?? 0
        draft.timeZone = timeZone

        if draft.mode == .once {
            guard let parsed = try? Date(absolute, strategy: .iso8601) else {
                errors.absolute = "Enter a valid ISO 8601 date and time."
                return errors
            }
            draft.date = parsed
        }
        if draft.mode == .recurring {
            guard let zone = TimeZone(identifier: timeZone) else {
                errors.timeZone = "Enter a valid IANA time zone."
                return errors
            }
            guard let match = recurringTime.wholeMatch(of: /([01][0-9]|2[0-3]):([0-5][0-9])/) else {
                errors.recurringTime = "Enter time as HH:mm, for example 09:00."
                return errors
            }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let components = DateComponents(
                timeZone: zone,
                year: 2001,
                month: 1,
                day: 15,
                hour: Int(match.1),
                minute: Int(match.2)
            )
            guard let parsed = calendar.date(from: components) else {
                errors.recurringTime = "Enter a valid local time."
                return errors
            }
            draft.localTime = parsed
        }
        return errors
    }
}

struct ScheduleDraft {
    var message = ""
    var mode = ScheduleDraftMode.once
    var date = Date().addingTimeInterval(3600)
    var delayMinutes = 30
    var frequency = ScheduleDraftFrequency.daily
    var localTime = Date()
    var weekday = 0
    var dayOfMonth = 1
    var timeZone = TimeZone.current.identifier

    var validationMessage: String? {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Enter the message to send." }
        if trimmed.count > 12_000 { return "Message is too long." }
        if mode == .once && date <= Date() { return "Choose a future time." }
        if mode == .delay && !(1...525_600).contains(delayMinutes) { return "Choose a delay from one minute to one year." }
        if mode == .recurring && TimeZone(identifier: timeZone) == nil { return "Enter a valid time zone." }
        if mode == .recurring && frequency == .monthly && !(1...31).contains(dayOfMonth) { return "Choose a day from 1 to 31." }
        return nil
    }

    var createRequest: ScheduleCreateRequest? {
        guard validationMessage == nil, let timing else { return nil }
        return ScheduleCreateRequest(idempotencyKey: UUID().uuidString, message: message, timing: timing, enabled: true)
    }

    var timing: ScheduleTimingInput? {
        switch mode {
        case .once:
            return ScheduleTimingInput.OnceAt(at: date.ISO8601Format(.iso8601(timeZone: .gmt)))
        case .delay:
            return ScheduleTimingInput.OnceAfter(afterSeconds: Int32(delayMinutes * 60))
        case .recurring:
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"; formatter.timeZone = TimeZone(identifier: timeZone)
            let mappedFrequency: ScheduleFrequency = switch frequency { case .daily: .daily; case .weekly: .weekly; case .monthly: .monthly }
            let weekdays: [ScheduleWeekday]? = frequency == .weekly ? [Self.weekdays[weekday.clamped(to: 0...6)]] : nil
            return ScheduleTimingInput.Recurring(
                frequency: mappedFrequency, localTime: formatter.string(from: localTime), timeZone: timeZone,
                weekdays: weekdays, dayOfMonth: frequency == .monthly ? KotlinInt(int: Int32(dayOfMonth)) : nil
            )
        }
    }

    private static let weekdays: [ScheduleWeekday] = [.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday]
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}
