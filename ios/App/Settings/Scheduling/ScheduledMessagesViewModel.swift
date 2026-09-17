import Foundation
import MobileData

enum ScheduledInboxClearFailure: Equatable {
    case unknownOutcome
    case failed(String)

    var title: String {
        switch self {
        case .unknownOutcome: "Clear outcome unknown"
        case .failed: "Messages not cleared"
        }
    }

    var detail: String {
        switch self {
        case .unknownOutcome: "Connection ended before the clear result was confirmed. Reload to check current messages."
        case .failed(let message): message
        }
    }
}

struct ScheduledInboxProjection {
    private(set) var cards: [ScheduledSessionCard] = []
    private var serverCards: [ScheduledSessionCard] = []
    private var pendingIds: Set<String> = []
    private var acknowledgedIds: Set<String> = []

    mutating func receive(_ incoming: [ScheduledSessionCard], authoritative: Bool) {
        if authoritative {
            serverCards = incoming
            acknowledgedIds.formIntersection(incoming.lazy.map(\.occurrenceId))
        } else {
            let knownIds = Set(serverCards.lazy.map(\.occurrenceId))
            let incomingById = Dictionary(incoming.map { ($0.occurrenceId, $0) }, uniquingKeysWith: { first, _ in first })
            let arrivals = incoming.filter { !knownIds.contains($0.occurrenceId) }
            serverCards = arrivals + serverCards.map { incomingById[$0.occurrenceId] ?? $0 }
        }
        project()
    }

    mutating func beginClear(_ ids: Set<String>) {
        pendingIds.formUnion(ids)
        project()
    }

    mutating func finishClear(_ ids: Set<String>, succeeded: Bool) {
        pendingIds.subtract(ids)
        if succeeded { acknowledgedIds.formUnion(ids) }
        project()
    }

    private mutating func project() {
        cards = serverCards.filter { !pendingIds.contains($0.occurrenceId) && !acknowledgedIds.contains($0.occurrenceId) }
    }
}

struct ScheduledInboxClearTarget {
    let occurrenceIds: Set<String>
    let requiresConfirmation: Bool
}

@MainActor
@Observable
final class ScheduledInboxState {
    enum LoadState { case loading, ready, failed(String) }
    private(set) var cards: [ScheduledSessionCard] = []
    var cardsState: LoadState = .loading
    var clearFailure: ScheduledInboxClearFailure?

    private var failedClear: ScheduledInboxClearTarget?
    private var clearQueue: [ScheduledInboxClearTarget] = []
    private var projection = ScheduledInboxProjection()
    private var clearFailureRevision = 0
    private var reloadGeneration = 0
    private var clearGeneration = 0
    private var currentClear: ScheduledInboxClearTarget?
    private let loadCards: () async throws -> Bool
    private let clearCards: ([String]) async throws -> ScheduledInboxClearFailure?
    @ObservationIgnored private nonisolated(unsafe) var clearTask: Task<Void, Never>?

    init(
        loadCards: @escaping () async throws -> Bool,
        clearCards: @escaping ([String]) async throws -> ScheduledInboxClearFailure?
    ) {
        self.loadCards = loadCards
        self.clearCards = clearCards
    }

    deinit { clearTask?.cancel() }

    func cancel() {
        reloadGeneration &+= 1
        clearGeneration &+= 1
        clearTask?.cancel()
        let cancelledIds = clearQueue.reduce(into: currentClear?.occurrenceIds ?? []) { $0.formUnion($1.occurrenceIds) }
        clearQueue.removeAll()
        currentClear = nil
        projection.finishClear(cancelledIds, succeeded: false)
        cards = projection.cards
        clearTask = nil
    }

    func reload() async {
        let generation = reloadGeneration
        let failureRevision = clearFailureRevision
        do {
            let loaded = try await loadCards()
            guard generation == reloadGeneration, !Task.isCancelled else { return }
            if loaded, clearFailureRevision == failureRevision {
                clearFailure = nil
                failedClear = nil
            }
        } catch is CancellationError {
        } catch {
            guard generation == reloadGeneration, !Task.isCancelled else { return }
            cardsState = .failed("Couldn't load scheduled messages.")
        }
    }

    var clearRetryRequiresConfirmation: Bool { failedClear?.requiresConfirmation == true }

    func clear(_ card: ScheduledSessionCard) {
        enqueueClear(ScheduledInboxClearTarget(occurrenceIds: [card.occurrenceId], requiresConfirmation: false))
    }

    func clearAll() {
        if let failedClear, failedClear.requiresConfirmation {
            enqueueClear(failedClear)
        } else {
            enqueueClear(ScheduledInboxClearTarget(occurrenceIds: Set(cards.lazy.map(\.occurrenceId)), requiresConfirmation: true))
        }
    }

    func retryClear() {
        guard let failedClear, !failedClear.requiresConfirmation else { return }
        enqueueClear(failedClear)
    }

    func receive(_ value: [ScheduledSessionCard], authoritative: Bool) {
        projection.receive(value, authoritative: authoritative)
        cards = projection.cards
    }

    private func enqueueClear(_ target: ScheduledInboxClearTarget) {
        guard !target.occurrenceIds.isEmpty else { return }
        if failedClear?.occurrenceIds == target.occurrenceIds {
            failedClear = nil
            clearFailure = nil
        }
        projection.beginClear(target.occurrenceIds)
        cards = projection.cards
        clearQueue.append(target)
        guard clearTask == nil else { return }
        let generation = clearGeneration
        clearTask = Task { [weak self] in await self?.drainClearQueue(generation: generation) }
    }

    private func drainClearQueue(generation: Int) async {
        while generation == clearGeneration, !clearQueue.isEmpty, !Task.isCancelled {
            let target = clearQueue.removeFirst()
            currentClear = target
            let outcome: ScheduledInboxClearFailure?
            do {
                outcome = try await clearCards(Array(target.occurrenceIds))
            } catch is CancellationError {
                guard generation == clearGeneration, !Task.isCancelled else { break }
                outcome = .unknownOutcome
            } catch {
                outcome = .unknownOutcome
            }
            guard generation == clearGeneration, !Task.isCancelled else { break }
            currentClear = nil
            projection.finishClear(target.occurrenceIds, succeeded: outcome == nil)
            cards = projection.cards
            if let outcome {
                failedClear = target
                clearFailure = outcome
                clearFailureRevision &+= 1
            }
        }
        guard generation == clearGeneration else { return }
        currentClear = nil
        clearTask = nil
    }
}

@MainActor
@Observable
final class ScheduledMessagesViewModel {
    typealias LoadState = ScheduledInboxState.LoadState
    var schedules: [Schedule] = []
    var scheduleState: LoadState = .loading
    var mutationError: String?
    var isMutating = false

    var cards: [ScheduledSessionCard] { inbox.cards }
    var cardsState: LoadState { inbox.cardsState }
    var clearFailure: ScheduledInboxClearFailure? { inbox.clearFailure }
    var clearRetryRequiresConfirmation: Bool { inbox.clearRetryRequiresConfirmation }

    private let useCases: ScheduleUseCases
    private let inbox: ScheduledInboxState
    private var reloadGeneration = 0
    @ObservationIgnored private nonisolated(unsafe) var scheduleTask: Task<Void, Never>?
    @ObservationIgnored private nonisolated(unsafe) var cardsTask: Task<Void, Never>?
    @ObservationIgnored private nonisolated(unsafe) var reloadTask: Task<Void, Never>?

    init(useCases: ScheduleUseCases) {
        self.useCases = useCases
        inbox = ScheduledInboxState(
            loadCards: {
                if case .success = onEnum(of: try await useCases.loadCards(limit: 100)) { return true }
                return false
            },
            clearCards: { ids in
                switch onEnum(of: try await useCases.clearCards(occurrenceIds: ids)) {
                case .success: return nil
                case .failure(let failure):
                    return failure.error.kind == .connection || failure.error.kind == .timeout
                        ? .unknownOutcome
                        : .failed(failure.error.userMessage)
                case .loading: return .unknownOutcome
                }
            }
        )
    }

    deinit { scheduleTask?.cancel(); cardsTask?.cancel(); reloadTask?.cancel() }

    func cancel() {
        scheduleTask?.cancel()
        cardsTask?.cancel()
        reloadGeneration &+= 1
        reloadTask?.cancel()
        inbox.cancel()
        scheduleTask = nil
        cardsTask = nil
        reloadTask = nil
    }

    func start(loadSchedules: Bool = true) {
        if loadSchedules && scheduleTask == nil {
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
        }
        startObservingCards()
        if reloadTask == nil {
            let generation = reloadGeneration
            reloadTask = Task { [weak self] in
                guard let self else { return }
                if loadSchedules { await reload() }
                else { await reloadCards() }
                guard generation == reloadGeneration else { return }
                reloadTask = nil
            }
        }
    }

    func startObservingCards() {
        guard cardsTask == nil else { return }
        cardsTask = Task { [weak self, useCases] in
            for await value in useCases.cards {
                guard let self, !Task.isCancelled else { return }
                switch onEnum(of: value) {
                case .loading(let loading):
                    if let partial = loading.partial as? [ScheduledSessionCard] { self.inbox.receive(partial, authoritative: false) }
                    self.inbox.cardsState = .loading
                case .success(let success):
                    self.inbox.receive((success.data as? [ScheduledSessionCard]) ?? [], authoritative: true)
                    self.inbox.cardsState = .ready
                case .failure(let failure): self.inbox.cardsState = .failed(failure.error.userMessage)
                }
            }
        }
    }

    func reload() async {
        do { _ = try await useCases.reload(limit: 100); await inbox.reload() }
        catch is CancellationError {} catch { scheduleState = .failed("Couldn't load scheduled messages.") }
    }

    func reloadCards() async { await inbox.reload() }

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
    func clear(_ card: ScheduledSessionCard) { inbox.clear(card) }
    func clearAll() { inbox.clearAll() }
    func retryClear() { inbox.retryClear() }
    func receiveCards(_ value: [ScheduledSessionCard], authoritative: Bool) { inbox.receive(value, authoritative: authoritative) }

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
