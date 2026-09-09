import Foundation
import MobileData

/// The complete semantic state consumed by the native calendar surface.
///
/// Shared projections remain the source of truth: this value only gives SwiftUI
/// stable names for the current shared state and never re-filters or re-projects
/// occurrences.
struct CalendarUiState {
    enum Content {
        case loading
        case empty
        case content
        case unavailableOffline
        case error
    }

    let anchorDate: String
    let selectedDate: String
    let todayDate: String
    let view: CalendarView
    let filters: CalendarFilters
    let locale: CalendarLocale
    let visibleInterval: CalendarDateInterval?
    let selectedInterval: CalendarDateInterval?
    let occurrences: [EffectiveOccurrence]
    let projection: CalendarExperienceProjection?
    let facets: CalendarFacetOptions
    let freshness: CalendarCacheFreshness
    let loading: CalendarLoadingState
    let offline: CalendarOfflineState
    let error: CalendarExperienceError?
    let hasCompleteCache: Bool
    let presentationReady: Bool
    let recovery: CalendarRecoveryState
    let mutationAvailability: CalendarMutationAvailability
    let mutation: CalendarMutationState
    let content: Content

    var day: CalendarDayProjection? { projection?.day }
    var week: CalendarWeekProjection? { projection?.week }
    var month: CalendarMonthProjection? { projection?.month }
    var year: CalendarYearProjection? { projection?.year }
    var visibleEvents: [CalendarProjectedEvent] { projection?.visibleEvents ?? [] }
    var agenda: [CalendarAgendaSection] {
        if let day { return day.agenda }
        if let week { return week.agenda }
        if let month { return month.agenda }
        return []
    }
    var isRefreshing: Bool { loading.isRefreshing || freshness == .refreshing }
    var isOffline: Bool { offline != .online }
    var preview: EffectiveOccurrence? { mutation.preview }
    var editor: CalendarMutationEditorState? { mutation.editor }
    var deleteConfirmation: CalendarDeleteConfirmationState? { mutation.deleteConfirmation }
    var conflict: CalendarConflictReviewState? { mutation.conflict }
    var outcome: (any CalendarMutationOutcome)? { mutation.outcome }

    init(_ state: CalendarExperienceState) {
        anchorDate = state.anchorDate
        selectedDate = state.selectedDate
        todayDate = state.todayDate
        view = state.view
        filters = state.filters
        locale = state.locale
        visibleInterval = state.visibleInterval
        selectedInterval = state.selectedInterval
        occurrences = state.authorizedOccurrences
        projection = state.projection
        facets = state.facets
        freshness = state.freshness
        loading = state.loading
        offline = state.offline
        error = state.error
        hasCompleteCache = state.hasCompleteCache
        presentationReady = state.presentationReady
        recovery = state.recovery
        mutationAvailability = state.mutationAvailability
        mutation = state.mutation

        if state.isUnavailableOffline && state.projection == nil {
            content = .unavailableOffline
        } else if state.loading.isInitial && state.projection == nil {
            content = .loading
        } else if state.error != nil && state.projection == nil {
            content = .error
        } else if !Self.hasVisibleEvents(state.projection) {
            content = .empty
        } else {
            content = .content
        }
    }
    /// Classification must not flatten, deduplicate and sort the whole visible
    /// projection again on the MainActor just to ask whether anything is present.
    private static func hasVisibleEvents(_ projection: CalendarExperienceProjection?) -> Bool {
        guard let projection else { return false }
        if let day = projection.day { return !day.events.isEmpty }
        if let week = projection.week { return !week.events.isEmpty }
        if let month = projection.month { return month.cells.contains { !$0.events.isEmpty } }
        if let year = projection.year { return year.months.contains { !$0.events.isEmpty } }
        return false
    }
}

/// A small collection seam keeps tests independent of repositories while the
/// production implementation below proves and uses SKIE's AsyncSequence bridge.
@MainActor
protocol CalendarExperienceStateSource: AnyObject {
    /// Activates the session-owned cache observation/revalidation path. The
    /// shared experience coalesces equivalent starts across route recreation.
    func activate()
    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async
    func dispatch(_ intent: any CalendarExperienceIntent)
    /// Current lease value, not a queued collection payload or an auth inference.
    var currentViewportState: CalendarViewportState? { get }
    var isViewportLeaseActive: Bool { get }
    /// Production supplies StateFlow.value. Nil is reserved for stream-only test sources.
    var currentExperienceState: CalendarExperienceState? { get }
    var maximumViewportPeriods: Int { get }
    func collectViewport(_ receive: @MainActor @escaping (CalendarViewportState) -> Void) async
    func setViewportPeriods(_ periods: [MobileData.CalendarViewportPeriod]) -> CalendarViewportRequestResult
    func navigateFromViewport(anchorDate: String, action: any CalendarNavigationAction) -> CalendarViewportRequestResult
    func currentViewportOccurrence(for identity: CalendarOccurrenceIdentity) -> EffectiveOccurrence?
    func releaseViewport()
}

extension CalendarExperienceStateSource {
    var currentViewportState: CalendarViewportState? { nil }
    var isViewportLeaseActive: Bool { false }
    var currentExperienceState: CalendarExperienceState? { nil }
    var maximumViewportPeriods: Int { 0 }
    func collectViewport(_ receive: @MainActor @escaping (CalendarViewportState) -> Void) async {}
    func setViewportPeriods(_ periods: [MobileData.CalendarViewportPeriod]) -> CalendarViewportRequestResult { .retired }
    func navigateFromViewport(anchorDate: String, action: any CalendarNavigationAction) -> CalendarViewportRequestResult { .unsupportedAction }
    func currentViewportOccurrence(for identity: CalendarOccurrenceIdentity) -> EffectiveOccurrence? { nil }
    func releaseViewport() {}
}

@MainActor
private final class SkieCalendarExperienceStateSource: CalendarExperienceStateSource {
    private let experience: CalendarExperience
    private nonisolated(unsafe) var viewportLease: CalendarViewportLease?

    deinit { viewportLease?.close() }

    var currentViewportState: CalendarViewportState? {
        guard let lease = viewportLease, lease.isActive else { return nil }
        return lease.state.value
    }
    var isViewportLeaseActive: Bool { viewportLease?.isActive == true }
    var currentExperienceState: CalendarExperienceState? { experience.state.value }
    var maximumViewportPeriods: Int { Int(viewportLease?.maximumPeriods ?? 0) }

    init(experience: CalendarExperience) {
        self.experience = experience
    }

    func activate() {
        // StateFlow collection alone does not start CalendarExperience. Starting
        // the current shared window is idempotent and leaves its work session-owned.
        if viewportLease == nil { viewportLease = experience.acquireViewport() }
        experience.start(window: experience.visibleWindow)
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        for await _ in experience.state {
            guard !Task.isCancelled else { return }
            // SKIE delivery can lag a synchronous namespace/auth clear.
            receive(experience.state.value)
        }
    }

    func collectViewport(_ receive: @MainActor @escaping (CalendarViewportState) -> Void) async {
        guard let lease = viewportLease else { return }
        for await _ in lease.state {
            guard !Task.isCancelled, viewportLease === lease else { return }
            receive(lease.state.value)
        }
    }

    func setViewportPeriods(_ periods: [MobileData.CalendarViewportPeriod]) -> CalendarViewportRequestResult {
        guard let lease = viewportLease else { return .retired }
        return lease.setPeriods(periods: periods)
    }

    func navigateFromViewport(anchorDate: String, action: any CalendarNavigationAction) -> CalendarViewportRequestResult {
        experience.navigateFromViewport(anchorDate: anchorDate, action: action)
    }

    func currentViewportOccurrence(for identity: CalendarOccurrenceIdentity) -> EffectiveOccurrence? {
        guard let lease = viewportLease, lease.isActive else { return nil }
        return lease.resolveOccurrence(identity: identity)
    }

    func releaseViewport() {
        let lease = viewportLease
        viewportLease = nil
        lease?.close()
    }

    func dispatch(_ intent: any CalendarExperienceIntent) {
        experience.dispatch(intent: intent)
    }
}

/// Thin, route-scoped adapter over the authenticated session's shared calendar
/// experience. The collection task is owned here; the experience is not.
@MainActor
@Observable
final class CalendarViewModel {
    private var foregroundRevision = 0
    // Compatibility for stream-only test sources; production never retains this.
    private var deliveredTestState: CalendarUiState?

    /// Collection triggers observation, but synchronous shared state is authority.
    var state: CalendarUiState? {
        _ = foregroundRevision
        guard isActive else { return nil }
        return source.currentExperienceState.map(CalendarUiState.init) ?? deliveredTestState
    }

    func currentOccurrence(for identity: CalendarEventActionIdentity) -> EffectiveOccurrence? {
        guard let state else { return nil }
        // Adjacent actions never fall back to a foreground revision when the
        // current lease rejects an identity. DTOs carry no action authority.
        if state.view == .day || state.view == .week {
            guard isViewportLeaseActive, let originalStart = identity.originalStart else { return nil }
            return source.currentViewportOccurrence(for: CalendarOccurrenceIdentity(
                eventId: identity.eventId, occurrenceId: identity.occurrenceId,
                originalStart: originalStart, scope: identity.scope
            ))
        }
        return CalendarScreenMapping.occurrence(for: identity, in: state)
    }
    private var isActive = false
    private var viewportRevision = 0
    private(set) var browsedDate: CalendarViewportDate?
    var browsedMonth: CalendarViewportMonth? { browsedDate.map { CalendarViewportMonth(date: $0.date) } }
    private(set) var viewportRequestResult: CalendarViewportRequestResult?
    private(set) var viewportNavigationResult: CalendarViewportRequestResult?
    private let viewportMapping = CalendarViewportNativeMapping()
    private let adjacentMapping = CalendarAdjacentNativeMapping()

    var adjacentData: CalendarAdjacentViewportData {
        adjacentMapping.data(viewport: viewportState, state: state, isActive: isViewportLeaseActive)
    }

    /// Prepared only at input replacement, outside native layout/drawing. Every
    /// access rechecks shared current authority before using a prepared value.
    var viewportData: CalendarViewportData {
        viewportMapping.data(viewport: viewportState, state: state, isActive: isViewportLeaseActive)
    }

    /// Observation is driven by collection, but reads use current shared authority.
    /// No retained native snapshot can survive a synchronous shared auth clear.
    var viewportState: CalendarViewportState? {
        _ = viewportRevision
        return isViewportLeaseActive ? source.currentViewportState : nil
    }

    /// Shared owner/namespace validity, independent of foreground loading or map size.
    var isViewportLeaseActive: Bool {
        _ = viewportRevision
        return isActive && source.isViewportLeaseActive
    }

    var maximumViewportPeriods: Int { isActive ? source.maximumViewportPeriods : 0 }

    private let source: any CalendarExperienceStateSource
    // Swift deinitializers are nonisolated; Task cancellation itself is thread-safe.
    private nonisolated(unsafe) var collectionTask: Task<Void, Never>?
    private nonisolated(unsafe) var viewportCollectionTask: Task<Void, Never>?
    private var collectionGeneration = 0

    // SwiftUI may construct and discard eager @State candidates while retaining
    // the mounted model. Construction must not acquire its owner's lease or
    // start collectors; the mounted route's onAppear calls resume synchronously.
    init(experience: CalendarExperience) {
        source = SkieCalendarExperienceStateSource(experience: experience)
    }

    init(source: any CalendarExperienceStateSource) {
        self.source = source
    }

    deinit {
        collectionTask?.cancel()
        viewportCollectionTask?.cancel()
    }

    func dispose() {
        guard isActive else { return }
        isActive = false
        deliveredTestState = nil
        collectionGeneration += 1
        collectionTask?.cancel()
        collectionTask = nil
        viewportCollectionTask?.cancel()
        viewportCollectionTask = nil
        source.releaseViewport()
        viewportMapping.clear()
        adjacentMapping.clear()
    }

    /// Pair with onDisappear/dispose, including a cancelled interactive back.
    /// Auth owner changes must supply the current experience, not revive an old one.
    func resume() {
        guard !isActive else { return }
        isActive = true
        collectionGeneration += 1
        let generation = collectionGeneration
        collectionTask?.cancel()
        // Activation is synchronous and precedes creation of the SKIE collector,
        // so cache observation/revalidation cannot be skipped by a cold StateFlow.
        // CalendarExperience owns and idempotently coalesces that session work.
        source.activate()
        viewportCollectionTask = Task { [weak self, source] in
            guard !Task.isCancelled else { return }
            await source.collectViewport { [weak self] _ in
                guard let self, !Task.isCancelled,
                      self.collectionGeneration == generation else { return }
                self.viewportMapping.invalidate()
                self.viewportRevision += 1
            }
        }
        collectionTask = Task { [weak self, source] in
            guard !Task.isCancelled else { return }
            await source.collect { [weak self] sharedState in
                guard let self,
                      !Task.isCancelled,
                      self.collectionGeneration == generation else { return }
                self.deliveredTestState = source.currentExperienceState == nil ? CalendarUiState(sharedState) : nil
                self.foregroundRevision += 1
            }
        }
    }

    /// Shared validation returns recoverable outcomes without replacing a rejected request.
    @discardableResult
    func setViewportPeriods(_ periods: [MobileData.CalendarViewportPeriod]) -> CalendarViewportRequestResult {
        let result: CalendarViewportRequestResult = isActive ? source.setViewportPeriods(periods) : .retired
        viewportRequestResult = result
        return result
    }

    func requestViewport(_ request: CalendarViewportRequest) {
        // A retiring Month owner must not clear a successor Day/Week request.
        guard state == nil || state?.view == .month || state?.view == .year else { return }
        setViewportPeriods(request.months.map {
            MobileData.CalendarViewportPeriod(view: .month, anchorDate: $0.date)
        })
    }

    /// Civil cursor only: no shared dispatch, preference write or foreground read.
    func browse(_ month: CalendarViewportMonth) {
        guard isActive, (1...9999).contains(month.year), (1...12).contains(month.month) else { return }
        browsedDate = CalendarViewportDate(date: month.date)
    }

    func requestAdjacentViewport(_ request: CalendarAdjacentViewportRequest) {
        guard isActive, request.view == .day || request.view == .week,
              state?.view == request.view else { return }
        let eligible = request.periods.filter {
            CalendarAdjacentPageID(view: request.view, anchor: $0).isAdjacentViewportEligible
        }
        guard eligible.count == request.periods.count else {
            // Preserve the typed outcome for the route owner without sending a
            // whole poisoned batch to the shared lease.
            viewportRequestResult = .invalidDate
            return
        }
        // A rejected request is observable through viewportRequestResult and is
        // never retried or replaced here.
        _ = setViewportPeriods(eligible.map {
            MobileData.CalendarViewportPeriod(view: request.view, anchorDate: $0.date)
        })
    }

    func browse(_ date: CalendarViewportDate) {
        guard isActive else { return }
        browsedDate = date
    }

    func selectDate(from cursor: CalendarViewportDate, date: String) {
        guard isActive, state?.view == .week else { return }
        let result = source.navigateFromViewport(
            anchorDate: cursor.date, action: CalendarNavigationActionSelectDate(date: date)
        )
        viewportNavigationResult = result
        if result == .accepted { browsedDate = nil }
    }

    private func navigateFromBrowse(_ action: any CalendarNavigationAction) {
        guard let cursor = browsedDate else { navigate(action); return }
        let result: CalendarViewportRequestResult = isActive
            ? source.navigateFromViewport(anchorDate: cursor.date, action: action) : .retired
        viewportNavigationResult = result
        if result == .accepted { browsedDate = nil }
    }

    private func navigate(_ action: any CalendarNavigationAction) {
        source.dispatch(CalendarExperienceIntentNavigate(action: action))
    }

    func today() { browsedDate = nil; navigate(CalendarNavigationActionToday()) }
    func previous() { navigateFromBrowse(CalendarNavigationActionPrevious()) }
    func next() { navigateFromBrowse(CalendarNavigationActionNext()) }
    func selectDate(_ date: String) { browsedDate = nil; navigate(CalendarNavigationActionSelectDate(date: date)) }
    func selectMonth(year: Int32, month: Int32) {
        browsedDate = nil
        navigate(CalendarNavigationActionSelectMonth(year: year, month: month))
    }
    func selectView(_ view: CalendarView) { navigateFromBrowse(CalendarNavigationActionSelectView(view: view)) }
    func setFilters(_ filters: CalendarFilters) {
        navigate(CalendarNavigationActionSetFilters(filters: filters))
    }
    func search(_ text: String) {
        guard let state else { return }
        setFilters(state.filters.doCopy(
            scope: state.filters.scope,
            groups: state.filters.groups,
            tags: state.filters.tags,
            importance: state.filters.importance,
            text: text
        ))
    }
    func setLocale(_ locale: CalendarLocale) {
        source.dispatch(CalendarExperienceIntentSetLocale(locale: locale))
    }
    func refresh() { source.dispatch(CalendarExperienceIntentRefresh()) }
    func openPreview(_ occurrence: EffectiveOccurrence) {
        source.dispatch(CalendarExperienceIntentOpenPreview(occurrence: occurrence))
    }
    func openEditor(occurrence: EffectiveOccurrence? = nil, draft: CalendarMutationDraft? = nil) {
        source.dispatch(CalendarExperienceIntentOpenEditor(occurrence: occurrence, draft: draft))
    }
    func add(_ draft: CalendarMutationDraft? = nil) {
        source.dispatch(CalendarExperienceIntentCreateDraft(draft: draft))
    }
    func edit(_ occurrence: EffectiveOccurrence, inputTimeZoneId: String? = nil) {
        source.dispatch(CalendarExperienceIntentEditOccurrence(
            occurrence: occurrence,
            inputTimeZoneId: inputTimeZoneId
        ))
    }
    func updateDraft(_ draft: CalendarMutationDraft) {
        source.dispatch(CalendarExperienceIntentUpdateDraft(draft: draft))
    }
    func chooseMutationScope(_ scope: CalendarMutationScope) {
        source.dispatch(CalendarExperienceIntentChooseMutationScope(scope: scope))
    }
    func save(_ draft: CalendarMutationDraft? = nil) {
        source.dispatch(CalendarExperienceIntentSubmit(draft: draft))
    }
    func requestDelete() { source.dispatch(CalendarExperienceIntentRequestDelete()) }
    func confirmDelete(scope: CalendarMutationScope? = nil) {
        source.dispatch(CalendarExperienceIntentConfirmDelete(scope: scope))
    }
    func rereadConflict() { source.dispatch(CalendarExperienceIntentRereadConflict()) }
    func reviewConflict(_ draft: CalendarMutationDraft) {
        source.dispatch(CalendarExperienceIntentReviewConflict(draft: draft))
    }
    func close() { source.dispatch(CalendarExperienceIntentCancel()) }
    func acknowledgeOutcome() { source.dispatch(CalendarExperienceIntentAcknowledgeOutcome()) }
}

/// Bounded shared-to-native field mapping. The cache is never an authority;
/// current shared inputs are checked on every access, and replacements never merge.
@MainActor
private final class CalendarViewportNativeMapping {
    private let scope = UUID().uuidString
    private var contextCounter = 0
    private var revision = 0
    private var context: Context?
    private weak var viewportSnapshot: CalendarViewportState?
    private var hadViewport = false
    private var wasActive = false
    private var prepared: CalendarViewportData?

    private struct Context: Equatable {
        let locale: CalendarLocale
        let filters: CalendarFilters

        init(_ state: CalendarUiState) {
            locale = state.locale
            filters = state.filters
        }

        func matches(_ projection: CalendarExperienceProjection) -> Bool {
            locale == projection.locale && filters == projection.filters
        }
    }

    func clear() {
        contextCounter += 1
        context = nil
        viewportSnapshot = nil
        hadViewport = false
        prepared = nil
    }

    func invalidate() { prepared = nil }

    func data(viewport: CalendarViewportState?, state: CalendarUiState?, isActive: Bool) -> CalendarViewportData {
        let nextContext = state.map(Context.init)
        if let prepared, wasActive == isActive, context == nextContext,
           hadViewport == (viewport != nil), viewportSnapshot === viewport { return prepared }
        if wasActive != isActive || context != nextContext { contextCounter += 1 }
        wasActive = isActive
        context = nextContext
        viewportSnapshot = viewport
        hadViewport = viewport != nil
        revision += 1
        var months: [CalendarViewportMonth: CalendarViewportMonthData] = [:]
        // Activity is shared lease authority. Selection/Today are native paint;
        // only locale/filters determine whether current period marks can be used.
        if isActive, let context, let viewport {
            for (period, entry) in viewport.periods where period.view == .month {
                let id = CalendarViewportMonth(date: period.anchorDate)
                if let projection = entry.projection, context.matches(projection), let month = projection.month {
                    months[id] = CalendarViewportMonthData(cells: month.cells, availability: .ready)
                } else {
                    let pending = entry.projection != nil || entry.loading.isInitial || entry.loading.isRefreshing
                    months[id] = CalendarViewportMonthData(cells: [], availability: pending ? .loading : .unavailable)
                }
            }
        }
        let data = CalendarViewportData(
            generation: "\(scope):\(contextCounter)", revision: revision, months: months, isActive: isActive
        )
        prepared = data
        return data
    }
}

/// Native controls may convert between `Date` and wire values, but raw shared
/// temporal identity is otherwise never normalized by the adapter.
enum CalendarNativeDateConversion {
    static func allDayValue(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func timedValue(_ date: Date) -> String {
        date.ISO8601Format(.iso8601(timeZone: .current, includingFractionalSeconds: true))
    }
}

/// No retained projection dictionary: every read maps only the current lease.
/// Selection/Today are render inputs, while the structural context is the
/// generation fence. A Week date selection must repaint its overview without
/// recreating or recentering the vertical working set.
@MainActor
private final class CalendarAdjacentNativeMapping {
    private let scope = UUID().uuidString
    private var generation = 0
    private var revision = 0
    private var context: Context?
    private weak var snapshot: CalendarViewportState?
    private var active = false

    private struct StructuralContext: Equatable {
        let view: CalendarView
        let locale: CalendarLocale
        let filters: CalendarFilters
    }

    private struct Context: Equatable {
        let structural: StructuralContext
        let selected: String
        let today: String

        init(_ state: CalendarUiState) {
            structural = StructuralContext(view: state.view, locale: state.locale, filters: state.filters)
            selected = state.selectedDate
            today = state.todayDate
        }

        func matches(_ projection: CalendarExperienceProjection, id: CalendarAdjacentPageID) -> Bool {
            projection.view == id.view && projection.anchorDate == id.anchor.date &&
                projection.locale == structural.locale && projection.filters == structural.filters &&
                projection.selectedDate == selected && projection.todayDate == today
        }
    }

    func clear() {
        context = nil
        snapshot = nil
        active = false
        generation += 1
        revision += 1
    }

    func data(viewport: CalendarViewportState?, state: CalendarUiState?, isActive: Bool) -> CalendarAdjacentViewportData {
        let next = isActive ? state.map(Context.init) : nil
        if active != isActive || next?.structural != context?.structural {
            generation += 1
        }
        if active != isActive || next != context || snapshot !== viewport {
            revision += 1
        }
        active = isActive
        context = next
        snapshot = viewport
        var pages: [CalendarAdjacentPageID: CalendarAdjacentPageData] = [:]
        if isActive, let context, let viewport, context.structural.view == .day || context.structural.view == .week {
            for (period, entry) in viewport.periods where period.view == context.structural.view {
                guard let anchor = CalendarViewportDate(date: period.anchorDate) else { continue }
                let id = CalendarAdjacentPageID(view: period.view, anchor: anchor)
                let projection = entry.projection.flatMap { context.matches($0, id: id) ? $0 : nil }
                pages[id] = CalendarAdjacentPageData(
                    projection: projection,
                    loading: entry.projection != nil && projection == nil
                        ? CalendarLoadingState(phase: .loading) : entry.loading,
                    freshness: entry.freshness, offline: entry.offline, error: entry.error
                )
            }
        }
        return CalendarAdjacentViewportData(
            isActive: isActive,
            generation: "\(scope):\(generation)",
            revision: revision,
            pages: pages,
            semanticAnchor: state.flatMap { CalendarViewportDate(date: $0.anchorDate) },
            selectedDate: state?.selectedDate ?? "", todayDate: state?.todayDate ?? ""
        )
    }
}
