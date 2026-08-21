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
        mutationAvailability = state.mutationAvailability
        mutation = state.mutation

        if state.isUnavailableOffline && state.projection == nil {
            content = .unavailableOffline
        } else if state.loading.isInitial && state.projection == nil {
            content = .loading
        } else if state.error != nil && state.projection == nil {
            content = .error
        } else if state.projection?.visibleEvents.isEmpty != false {
            content = .empty
        } else {
            content = .content
        }
    }
}

/// A small collection seam keeps tests independent of repositories while the
/// production implementation below proves and uses SKIE's AsyncSequence bridge.
@MainActor
protocol CalendarExperienceStateSource: AnyObject {
    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async
    func dispatch(_ intent: any CalendarExperienceIntent)
}

@MainActor
private final class SkieCalendarExperienceStateSource: CalendarExperienceStateSource {
    private let experience: CalendarExperience

    init(experience: CalendarExperience) {
        self.experience = experience
    }

    func collect(_ receive: @MainActor @escaping (CalendarExperienceState) -> Void) async {
        for await state in experience.state {
            guard !Task.isCancelled else { return }
            receive(state)
        }
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
    private(set) var state: CalendarUiState?

    private let source: any CalendarExperienceStateSource
    // Swift deinitializers are nonisolated; Task cancellation itself is thread-safe.
    private nonisolated(unsafe) var collectionTask: Task<Void, Never>?
    private var collectionGeneration = 0

    init(experience: CalendarExperience) {
        source = SkieCalendarExperienceStateSource(experience: experience)
        startCollecting()
    }

    init(source: any CalendarExperienceStateSource) {
        self.source = source
        startCollecting()
    }

    deinit {
        collectionTask?.cancel()
    }

    func dispose() {
        collectionGeneration += 1
        collectionTask?.cancel()
        collectionTask = nil
    }

    private func startCollecting() {
        collectionGeneration += 1
        let generation = collectionGeneration
        collectionTask?.cancel()
        collectionTask = Task { [weak self, source] in
            await source.collect { [weak self] sharedState in
                guard let self,
                      !Task.isCancelled,
                      self.collectionGeneration == generation else { return }
                self.state = CalendarUiState(sharedState)
            }
        }
    }

    private func navigate(_ action: any CalendarNavigationAction) {
        source.dispatch(CalendarExperienceIntentNavigate(action: action))
    }

    func today() { navigate(CalendarNavigationActionToday()) }
    func previous() { navigate(CalendarNavigationActionPrevious()) }
    func next() { navigate(CalendarNavigationActionNext()) }
    func selectDate(_ date: String) { navigate(CalendarNavigationActionSelectDate(date: date)) }
    func selectMonth(year: Int32, month: Int32) {
        navigate(CalendarNavigationActionSelectMonth(year: year, month: month))
    }
    func selectView(_ view: CalendarView) { navigate(CalendarNavigationActionSelectView(view: view)) }
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
