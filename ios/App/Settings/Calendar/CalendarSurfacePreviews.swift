#if DEBUG
import MobileData
import SwiftUI

private struct CalendarSurfacePreview: View {
    let view: CalendarView
    var variant: PreviewVariant = .dense
    var width: CGFloat = 390
    var height: CGFloat = 844
    @AccessibilityFocusState private var openerFocus: CalendarOverlayOrigin?

    var body: some View {
        CalendarScaffold(
            state: PreviewCalendarFactory.state(view: view, variant: variant),
            actions: .preview,
            openerFocus: $openerFocus
        )
        .frame(width: width, height: height)
    }
}

private enum PreviewVariant { case dense, empty, offline, error }

private enum PreviewCalendarFactory {
    static func state(view: CalendarView, variant: PreviewVariant) -> CalendarUiState {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "America/Los_Angeles", weekStart: .sunday, hourCycle: .hour12)
        let filters = CalendarFilters(scope: .all, groups: Set(["Family"]), tags: Set(["school"]), importance: nil, text: "")
        let occurrences = variant == .empty || variant == .error ? [] : previewOccurrences()
        let projection: CalendarExperienceProjection? = variant == .error ? nil : CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: occurrences,
            anchorDate: "2026-04-18",
            view: view,
            selectedDate: "2026-04-18",
            todayDate: "2026-04-18",
            locale: locale,
            filters: filters
        ))
        let error = variant == .error ? CalendarExperienceError(kind: .connection, userMessage: "Calendar could not be refreshed.", recoverable: true) : nil
        let shared = CalendarExperienceState(
            anchorDate: "2026-04-18", view: view, selectedDate: "2026-04-18", filters: filters,
            locale: locale, todayDate: "2026-04-18",
            visibleInterval: projection?.interval,
            selectedInterval: CalendarDateInterval(startDate: "2026-04-18", endExclusive: "2026-04-19"),
            authorizedOccurrences: [], projection: projection,
            facets: CalendarFacetOptions(
                scopes: [.private, .household, .all], groups: ["Family", "School"],
                tags: ["family", "school", "routine", "travel"], importances: [.normal, .important, .pinned]
            ),
            freshness: variant == .offline ? .cachedOffline : .fresh,
            loading: CalendarLoadingState(phase: .idle),
            offline: variant == .offline ? .offline : .online,
            error: error, hasCompleteCache: variant != .error,
            cachedWindow: nil, persistedCachePreferences: nil,
            presentationReady: true,
            recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
            mutationAvailability: CalendarMutationAvailability(canCreate: true, canEdit: true, canDelete: true, reason: nil),
            mutation: CalendarMutationState(
                phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil,
                pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
                successorEventId: nil, affectedWindows: []
            )
        )
        return CalendarUiState(shared)
    }

    private static func previewOccurrences() -> [CalendarProjectionOccurrence] {
        let values = [
            ("2026-04-13", "07:00", "Monday morning routine", "routine", Importance.normal),
            ("2026-04-15", "15:20", "School pickup", "school", .important),
            ("2026-04-18", "10:30", "Mia’s birthday planning", "family", .important),
            ("2026-04-18", "18:00", "Family dinner", "family", .normal),
            ("2026-04-18", "19:00", "Call grandparents", "family", .pinned),
            ("2026-04-18", "20:00", "Prepare school bags", "school", .normal),
            ("2026-04-19", "08:00", "Sunday morning routine", "routine", .normal),
            ("2026-04-21", "08:15", "School pickup", "school", .important),
            ("2026-04-25", "18:30", "Elena arrives", "travel", .normal)
        ]
        return values.enumerated().map { index, value in
            CalendarProjectionOccurrence(
                eventId: "preview-\(index)", occurrenceId: "preview-\(index)", originalStart: nil,
                recurring: false, recurrence: nil, revision: 1, scope: index.isMultiple(of: 2) ? .household : .private,
                title: value.2, description: nil, start: "\(value.0)T\(value.1):00-07:00",
                end: nil, visibility: .everyone, importance: value.4, group: "Family", tags: [value.3],
                persistedTimeZoneId: "America/Los_Angeles"
            )
        }
    }
}

private extension CalendarSurfaceActions {
    static let preview = CalendarSurfaceActions(
        onBack: {}, onAdd: {}, onToday: {}, onPrevious: {}, onNext: {},
        onSelectDate: { _ in }, onSelectMonth: { _, _ in }, onSelectView: { _ in },
        onFiltersChanged: { _ in }, onSearch: { _ in }, onEvent: { _ in }, onRetry: {}
    )
}

#Preview("Day · 390×844") { CalendarSurfacePreview(view: .day) }
#Preview("Week · 390×844") { CalendarSurfacePreview(view: .week) }
#Preview("Month · 390×844") { CalendarSurfacePreview(view: .month) }
#Preview("Year · 390×844") { CalendarSurfacePreview(view: .year) }
#Preview("Day · 430×932") { CalendarSurfacePreview(view: .day, width: 430, height: 932) }
#Preview("Week · 430×932") { CalendarSurfacePreview(view: .week, width: 430, height: 932) }
#Preview("Month · 430×932") { CalendarSurfacePreview(view: .month, width: 430, height: 932) }
#Preview("Year · 430×932") { CalendarSurfacePreview(view: .year, width: 430, height: 932) }
#Preview("Dense month") { CalendarSurfacePreview(view: .month, variant: .dense) }
#Preview("Empty day") { CalendarSurfacePreview(view: .day, variant: .empty) }
#Preview("Offline week") { CalendarSurfacePreview(view: .week, variant: .offline) }
#Preview("Error") { CalendarSurfacePreview(view: .month, variant: .error) }
#Preview("Safe-area clearance · 430×932") {
    CalendarSurfacePreview(view: .month, width: 430, height: 932)
        .safeAreaPadding(.bottom, 34)
        .background(DuskColors.bg)
}
#Preview("Dynamic Type") {
    CalendarSurfacePreview(view: .day, width: 430, height: 932)
        .environment(\.dynamicTypeSize, .accessibility3)
}
#Preview("Reduced motion") {
    CalendarSurfacePreview(view: .week)
        .transaction {
            $0.animation = nil
            $0.disablesAnimations = true
        }
}
#endif
