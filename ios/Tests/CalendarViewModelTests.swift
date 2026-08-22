import Foundation
import MobileData
import Testing
@testable import SentientApp

@MainActor
struct CalendarViewModelTests {
    @Test func completeCalendarExperienceStateIteratesThroughSkie() async {
        var views: [CalendarView] = []
        for await state in calendarExperienceBridgeProbe() {
            views.append(state.view)
            #expect(state.projection != nil)
            #expect(state.visibleInterval != nil)
            #expect(state.selectedInterval != nil)
            #expect(!state.authorizedOccurrences.isEmpty)
            #expect(!state.facets.groups.isEmpty)
            #expect(state.cachedWindow != nil)
            #expect(state.persistedCachePreferences != nil)
            #expect(state.error?.kind == .connection)
            #expect(state.mutation.preview != nil)
            #expect(state.mutation.editor?.draft.eventId == "bridge-event")
            #expect(state.mutation.deleteConfirmation != nil)
            #expect(state.mutation.conflict?.draft.originalStart == "2026-08-17T09:00:00-07:00")
            #expect(state.mutation.outcome != nil)
            #expect(state.mutation.error?.kind == .conflict)
        }
        #expect(views == [.day, .week, .month, .year])
    }

    @Test func mapsCompleteSharedStateWithoutReconstructingProjection() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        let shared = makeState(view: .month, freshness: .cachedOffline, offline: .offline)

        await source.waitUntilStarted()
        source.emit(shared)
        await source.waitForEmissions(1)

        #expect(vm.state?.anchorDate == "2026-08-01")
        #expect(vm.state?.projection === shared.projection)
        #expect(vm.state?.facets === shared.facets)
        #expect(vm.state?.occurrences.first === shared.authorizedOccurrences.first)
        #expect(vm.state?.isOffline == true)
        #expect(vm.state?.freshness == .cachedOffline)
        #expect(vm.state?.month != nil)
        #expect(vm.state?.day == nil)
    }

    @Test func allSharedViewsAndSelectedDateRetentionAreRepresentable() {
        for view in CalendarView.allCases {
            let mapped = CalendarUiState(makeState(view: view))
            #expect(mapped.view == view)
            #expect(mapped.selectedDate == "2026-08-17")
            switch view {
            case .day: #expect(mapped.day != nil)
            case .week: #expect(mapped.week != nil)
            case .month: #expect(mapped.month != nil)
            case .year: #expect(mapped.year != nil)
            }
        }
    }

    @Test func calendarOpenActivatesBeforeCollectionAndMapsCacheThenRevalidation() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        let cached = makeState(freshness: .stale, loading: .idle)
        let refreshing = makeState(freshness: .refreshing, loading: .refreshing)
        let fresh = makeState(freshness: .fresh, loading: .idle)

        await source.waitUntilStarted()
        #expect(source.activationCount == 1)
        #expect(source.lifecycleEvents == ["activate", "collect"])

        source.emit(cached)
        await source.waitForEmissions(1)
        #expect(vm.state?.freshness == .stale)
        #expect(vm.state?.content == .content)

        source.emit(refreshing)
        await source.waitForEmissions(2)
        #expect(vm.state?.isRefreshing == true)
        #expect(vm.state?.content == .content)

        source.emit(fresh)
        await source.waitForEmissions(3)
        #expect(vm.state?.freshness == .fresh)
        #expect(vm.state?.isRefreshing == false)
        #expect(vm.state?.projection != nil)
    }

    @Test func routeRecreationCoalescesSessionActivationAndDisposalCancelsOnlyOwnedCollector() async {
        let source = RouteRecreationSourceSpy()
        let first = CalendarViewModel(source: source)
        let second = CalendarViewModel(source: source)

        await source.waitForCollectors(2)
        #expect(source.activationCalls == 2)
        #expect(source.activationWorkStarts == 1)
        #expect(source.sessionWorkActive)

        source.emit(makeState(view: .month))
        await source.waitForDeliveries(2)
        #expect(first.state?.view == .month)
        #expect(second.state?.view == .month)

        first.dispose()
        await source.waitForCancellations(1)
        #expect(source.activeCollectorCount == 1)
        #expect(source.sessionWorkActive)

        source.emit(makeState(view: .year))
        await source.waitForDeliveries(3)
        #expect(first.state?.view == .month)
        #expect(second.state?.view == .year)
        #expect(source.activationWorkStarts == 1)

        second.dispose()
        await source.waitForCancellations(2)
        #expect(source.activeCollectorCount == 0)
        #expect(source.sessionWorkActive)
    }

    @Test func forwardsNavigationFilterAndRefreshIntentsExactly() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        let filters = makeFilters(text: "school")
        let locale = makeLocale()

        vm.today()
        vm.previous()
        vm.next()
        vm.selectDate("2026-09-03")
        vm.selectMonth(year: 2027, month: 2)
        vm.selectView(.week)
        vm.setFilters(filters)
        vm.setLocale(locale)
        vm.refresh()

        #expect(source.intents.count == 9)
        expectNavigate(source.intents[0], CalendarNavigationActionToday.self)
        expectNavigate(source.intents[1], CalendarNavigationActionPrevious.self)
        expectNavigate(source.intents[2], CalendarNavigationActionNext.self)
        if case .navigate(let value) = onEnum(of: source.intents[3]),
           case .selectDate(let action) = onEnum(of: value.action) {
            #expect(action.date == "2026-09-03")
        } else { Issue.record("select-date intent changed") }
        if case .navigate(let value) = onEnum(of: source.intents[4]),
           case .selectMonth(let action) = onEnum(of: value.action) {
            #expect(action.year == 2027)
            #expect(action.month == 2)
        } else { Issue.record("select-month intent changed") }
        if case .navigate(let value) = onEnum(of: source.intents[6]),
           case .setFilters(let action) = onEnum(of: value.action) {
            #expect(action.filters === filters)
        } else { Issue.record("filter identity changed") }
        if case .setLocale(let value) = onEnum(of: source.intents[7]) {
            #expect(value.locale === locale)
        } else { Issue.record("locale identity changed") }
        if case .refresh = onEnum(of: source.intents[8]) {} else {
            Issue.record("refresh intent changed")
        }
    }

    @Test func searchForwardsAFilterCopyWithoutChangingOtherFacets() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        await source.waitUntilStarted()
        source.emit(makeState())
        await source.waitForEmissions(1)

        vm.search("pickup")

        guard case .navigate(let value) = onEnum(of: source.intents[0]),
              case .setFilters(let action) = onEnum(of: value.action) else {
            Issue.record("search was not forwarded as SetFilters")
            return
        }
        #expect(action.filters.text == "pickup")
        #expect(action.filters.scope == .all)
        #expect(action.filters.groups == Set(["family"]))
        #expect(action.filters.tags == Set(["school"]))
        #expect(action.filters.importance == .important)
    }

    @Test func forwardsMutationIdentityScopeConflictAndAcknowledgementExactly() {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        let occurrence = makeOccurrence()
        let draft = makeDraft()

        vm.openPreview(occurrence)
        vm.openEditor(occurrence: occurrence, draft: draft)
        vm.add(draft)
        vm.edit(occurrence, inputTimeZoneId: "America/Los_Angeles")
        vm.updateDraft(draft)
        vm.chooseMutationScope(.thisAndFollowing)
        vm.save(draft)
        vm.requestDelete()
        vm.confirmDelete(scope: .thisOccurrence)
        vm.rereadConflict()
        vm.reviewConflict(draft)
        vm.close()
        vm.acknowledgeOutcome()

        #expect(source.intents.count == 13)
        if case .openPreview(let value) = onEnum(of: source.intents[0]) {
            #expect(value.occurrence === occurrence)
            #expect(value.occurrence.originalStart == "2026-08-17T09:00:00-07:00")
        } else { Issue.record("preview identity changed") }
        if case .openEditor(let value) = onEnum(of: source.intents[1]) {
            #expect(value.occurrence === occurrence)
            #expect(value.draft === draft)
        } else { Issue.record("editor identity changed") }
        if case .createDraft(let value) = onEnum(of: source.intents[2]) {
            #expect(value.draft === draft)
        } else { Issue.record("create draft identity changed") }
        if case .editOccurrence(let value) = onEnum(of: source.intents[3]) {
            #expect(value.occurrence === occurrence)
            #expect(value.inputTimeZoneId == "America/Los_Angeles")
        } else { Issue.record("edit identity changed") }
        if case .updateDraft(let value) = onEnum(of: source.intents[4]) {
            #expect(value.draft === draft)
            #expect(value.draft.eventId == "event-42")
            #expect(value.draft.occurrenceId == "occurrence-42")
            #expect(value.draft.expectedRevision == 7)
        } else { Issue.record("draft identity changed") }
        if case .chooseMutationScope(let value) = onEnum(of: source.intents[5]) {
            #expect(value.scope == .thisAndFollowing)
        } else { Issue.record("mutation scope changed") }
        if case .submit(let value) = onEnum(of: source.intents[6]) {
            #expect(value.draft === draft)
        } else { Issue.record("submit draft identity changed") }
        if case .confirmDelete(let value) = onEnum(of: source.intents[8]) {
            #expect(value.scope == .thisOccurrence)
        } else { Issue.record("delete scope changed") }
        if case .reviewConflict(let value) = onEnum(of: source.intents[10]) {
            #expect(value.draft === draft)
        } else { Issue.record("conflict draft changed") }
        if case .cancel = onEnum(of: source.intents[11]) {} else { Issue.record("close changed") }
        if case .acknowledgeOutcome = onEnum(of: source.intents[12]) {} else { Issue.record("ack changed") }
    }

    @Test func disposalCancelsCollectionAndRejectsStaleEmissions() async {
        let source = CalendarExperienceSourceSpy()
        let vm = CalendarViewModel(source: source)
        await source.waitUntilStarted()
        source.emit(makeState(view: .month))
        await source.waitForEmissions(1)
        #expect(vm.state?.view == .month)

        vm.dispose()
        await source.waitUntilCancelled()
        #expect(source.collectionCancelled)
        source.emit(makeState(view: .year))
        #expect(vm.state?.view == .month)
    }

    @Test func nativeDateConversionDoesNotTouchSharedRawIdentity() {
        let occurrence = makeOccurrence()
        #expect(occurrence.originalStart == "2026-08-17T09:00:00-07:00")
        #expect(occurrence.start == "2026-08-17T10:00:00-07:00")
        let date = Date(timeIntervalSince1970: 0)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0)!
        #expect(CalendarNativeDateConversion.allDayValue(date, calendar: utc) == "1970-01-01")
    }

    private func expectNavigate<T>(_ intent: any CalendarExperienceIntent, _: T.Type) {
        guard case .navigate(let value) = onEnum(of: intent) else {
            Issue.record("expected navigate intent")
            return
        }
        #expect(value.action is T)
    }

}

@MainActor
private final class CalendarExperienceSourceSpy: CalendarExperienceStateSource {
    private let stream: AsyncStream<CalendarExperienceState>
    private let continuation: AsyncStream<CalendarExperienceState>.Continuation
    private(set) var intents: [any CalendarExperienceIntent] = []
    private(set) var activationCount = 0
    private(set) var lifecycleEvents: [String] = []
    private(set) var collectionCancelled = false
    private var collectionStarted = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var receivedCount = 0
    private var receiptWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancelWaiters: [CheckedContinuation<Void, Never>] = []

    init() {
        var captured: AsyncStream<CalendarExperienceState>.Continuation!
        stream = AsyncStream { captured = $0 }
        continuation = captured
    }

    func activate() {
        activationCount += 1
        lifecycleEvents.append("activate")
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        lifecycleEvents.append("collect")
        collectionStarted = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        await withTaskCancellationHandler {
            for await state in stream {
                receive(state)
                receivedCount += 1
                let ready = receiptWaiters.filter { $0.0 <= receivedCount }
                receiptWaiters.removeAll { $0.0 <= receivedCount }
                ready.forEach { $0.1.resume() }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.collectionCancelled = true
                self.cancelWaiters.forEach { $0.resume() }
                self.cancelWaiters.removeAll()
            }
        }
    }

    func dispatch(_ intent: any CalendarExperienceIntent) { intents.append(intent) }
    func emit(_ state: CalendarExperienceState) { continuation.yield(state) }
    func waitUntilStarted() async {
        if collectionStarted { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }
    func waitForEmissions(_ count: Int) async {
        if receivedCount >= count { return }
        await withCheckedContinuation { receiptWaiters.append((count, $0)) }
    }
    func waitUntilCancelled() async {
        if collectionCancelled { return }
        await withCheckedContinuation { cancelWaiters.append($0) }
    }
}

/// Models multiple route collectors over one session-owned experience. The
/// activation work intentionally outlives every collector, matching KMP ownership.
@MainActor
private final class RouteRecreationSourceSpy: CalendarExperienceStateSource {
    private var collectors: [UUID: AsyncStream<CalendarExperienceState>.Continuation] = [:]
    private var collectorWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var cancellationWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private var deliveryWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    private(set) var activationCalls = 0
    private(set) var activationWorkStarts = 0
    private(set) var sessionWorkActive = false
    private(set) var cancellationCount = 0
    private(set) var deliveryCount = 0

    var activeCollectorCount: Int { collectors.count }

    func activate() {
        activationCalls += 1
        guard !sessionWorkActive else { return }
        sessionWorkActive = true
        activationWorkStarts += 1
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        let id = UUID()
        var captured: AsyncStream<CalendarExperienceState>.Continuation!
        let stream = AsyncStream<CalendarExperienceState> { captured = $0 }
        collectors[id] = captured
        resumeCollectorWaiters()

        await withTaskCancellationHandler {
            for await state in stream {
                receive(state)
                deliveryCount += 1
                resumeDeliveryWaiters()
            }
        } onCancel: {
            captured.finish()
        }

        collectors.removeValue(forKey: id)
        cancellationCount += 1
        resumeCancellationWaiters()
    }

    func dispatch(_ intent: any CalendarExperienceIntent) {}

    func emit(_ state: CalendarExperienceState) {
        collectors.values.forEach { $0.yield(state) }
    }

    func waitForCollectors(_ count: Int) async {
        if collectors.count >= count { return }
        await withCheckedContinuation { collectorWaiters.append((count, $0)) }
    }

    func waitForCancellations(_ count: Int) async {
        if cancellationCount >= count { return }
        await withCheckedContinuation { cancellationWaiters.append((count, $0)) }
    }

    func waitForDeliveries(_ count: Int) async {
        if deliveryCount >= count { return }
        await withCheckedContinuation { deliveryWaiters.append((count, $0)) }
    }

    private func resumeCollectorWaiters() {
        let ready = collectorWaiters.filter { $0.0 <= collectors.count }
        collectorWaiters.removeAll { $0.0 <= collectors.count }
        ready.forEach { $0.1.resume() }
    }

    private func resumeCancellationWaiters() {
        let ready = cancellationWaiters.filter { $0.0 <= cancellationCount }
        cancellationWaiters.removeAll { $0.0 <= cancellationCount }
        ready.forEach { $0.1.resume() }
    }

    private func resumeDeliveryWaiters() {
        let ready = deliveryWaiters.filter { $0.0 <= deliveryCount }
        deliveryWaiters.removeAll { $0.0 <= deliveryCount }
        ready.forEach { $0.1.resume() }
    }
}

private func makeLocale() -> CalendarLocale {
    CalendarLocale(languageTag: "en-US", timeZoneId: "America/Los_Angeles", weekStart: .monday, hourCycle: .hour12)
}

private func makeFilters(text: String = "") -> CalendarFilters {
    CalendarFilters(scope: .all, groups: Set(["family"]), tags: Set(["school"]), importance: .important, text: text)
}

private func makeOccurrence() -> EffectiveOccurrence {
    EffectiveOccurrence(
        eventId: "event-42", occurrenceId: "occurrence-42",
        originalStart: "2026-08-17T09:00:00-07:00", recurring: true, revision: 7,
        scope: .household, title: "School pickup", description: "Bring forms",
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        visibility: .everyone, importance: .important, group: "family", tags: ["school"], recurrence: nil
    )
}

private func makeDraft() -> CalendarMutationDraft {
    CalendarMutationDraft(
        title: "School pickup", description: "Bring forms", allDay: false,
        start: "2026-08-17T10:00:00-07:00", end: "2026-08-17T10:30:00-07:00",
        scope: .household, visibility: .everyone, importance: .important, group: "family", tags: ["school"],
        recurrence: nil, eventId: "event-42", occurrenceId: "occurrence-42",
        originalStart: "2026-08-17T09:00:00-07:00", expectedRevision: 7,
        inputTimeZoneId: "America/Los_Angeles", recurring: true
    )
}

private func makeState(
    view: CalendarView = .month,
    freshness: CalendarCacheFreshness = .fresh,
    loading: CalendarLoadingPhase = .idle,
    offline: CalendarOfflineState = .online
) -> CalendarExperienceState {
    let occurrence = makeOccurrence()
    let locale = makeLocale()
    let filters = makeFilters()
    let projectionOccurrence = CalendarProjectionOccurrence(
        eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId,
        originalStart: occurrence.originalStart, recurring: occurrence.recurring,
        recurrence: occurrence.recurrence, revision: occurrence.revision,
        scope: occurrence.scope, title: occurrence.title, description: occurrence.description_,
        start: occurrence.start, end: occurrence.end, visibility: occurrence.visibility,
        importance: occurrence.importance, group: occurrence.group, tags: occurrence.tags,
        persistedTimeZoneId: "America/Los_Angeles"
    )
    let projection = CalendarProjection().project(request: CalendarProjectionRequest(
        occurrences: [projectionOccurrence], anchorDate: "2026-08-01", view: view,
        selectedDate: "2026-08-17", todayDate: "2026-08-17", locale: locale, filters: filters
    ))
    return CalendarExperienceState(
        anchorDate: "2026-08-01", view: view, selectedDate: "2026-08-17", filters: filters,
        locale: locale, todayDate: "2026-08-17",
        visibleInterval: projection.interval,
        selectedInterval: CalendarDateInterval(startDate: "2026-08-17", endExclusive: "2026-08-18"),
        authorizedOccurrences: [occurrence], projection: projection,
        facets: CalendarFacetOptions(scopes: [.all, .household], groups: ["family"], tags: ["school"], importances: [.important]),
        freshness: freshness, loading: CalendarLoadingState(phase: loading), offline: offline, error: nil,
        hasCompleteCache: true, cachedWindow: nil, persistedCachePreferences: nil,
        presentationReady: true,
        mutationAvailability: CalendarMutationAvailability(canCreate: true, canEdit: true, canDelete: true, reason: nil),
        mutation: CalendarMutationState(
            phase: .previewing, preview: occurrence, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        )
    )
}
