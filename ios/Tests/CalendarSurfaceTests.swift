import Foundation
import MobileData
import Testing
@testable import SentientApp

struct CalendarSurfaceTests {
    @Test func approvedStableGeometryRemainsExplicit() {
        #expect(CalendarSurfaceLayout.topBarHeight == 58)
        #expect(CalendarSurfaceLayout.contentInset == 16)
        #expect(CalendarSurfaceLayout.minimumTarget == 44)
        #expect(CalendarSurfaceLayout.tagVisualHeight == 34)
        #expect(CalendarSurfaceLayout.agendaRowHeight == 64)
        #expect(CalendarSurfaceLayout.viewControlHeight == 46)
        #expect(CalendarSurfaceLayout.floatingBarClearance >= CalendarSurfaceLayout.viewControlHeight)
    }

    @Test func dayIsFocusedAgendaWithoutASeparateCompactCanvas() {
        #expect(!CalendarSurfaceMapping.showsCompactCanvas(.day))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.week))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.month))
        #expect(CalendarSurfaceMapping.showsCompactCanvas(.year))
    }

    @Test func sharedProjectionSuppliesCompleteMonthWeekAndLeapYearDates() {
        let month = projection(view: .month, anchor: "2028-02-14").month
        #expect(month?.cells.count == 42)
        #expect(month?.weekdayLabels.count == 7)
        #expect(month?.cells.first?.date == month?.gridStartDate)
        #expect(month?.cells.last?.date == month?.gridEndDate)

        let week = projection(view: .week, anchor: "2028-02-14").week
        #expect(week?.days.count == 7)
        #expect(Set(week?.days.map(\.date) ?? []).count == 7)

        let year = projection(view: .year, anchor: "2028-02-14").year
        #expect(year?.months.count == 12)
        #expect(year?.months.flatMap(\.days).count == 366)
        #expect(year?.months[1].days.count == 29)
        #expect(year?.months.first?.days.first?.date == "2028-01-01")
        #expect(year?.months.last?.days.last?.date == "2028-12-31")
    }

    @Test func monthAgendaUsesTheSharedFourDaySlice() throws {
        let shared = projection(view: .month, anchor: "2028-02-14")
        let state = screenState(projection: shared, occurrences: [screenOccurrence(originalStart: "2028-02-14T15:20:00Z")])
        let agenda = CalendarSurfaceMapping.agenda(for: state)

        #expect(agenda.map(\.date) == shared.month?.agenda.map(\.date))
        #expect(agenda.count == 1)
        #expect(agenda.first?.events.first?.eventId == "event")
    }

    @Test func deviceProjectionContextIncludesLocaleWeekStartAndTimeZone() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let zone = try #require(TimeZone(identifier: "Pacific/Auckland"))

        let context = CalendarDeviceProjectionContext.current(
            locale: Locale(identifier: "en_GB"),
            calendar: calendar,
            timeZone: zone
        )

        #expect(context.languageTag == "en-GB")
        #expect(context.weekStart == .monday)
        #expect(context.timeZoneId == "Pacific/Auckland")
    }

    @Test func freshnessRecoveryAnnouncementOnlyFiresOnATransitionToFresh() {
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .refreshing, to: .fresh) == "Calendar is up to date")
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .fresh, to: .fresh) == nil)
        #expect(CalendarSurfaceText.freshnessRecoveryAnnouncement(from: .stale, to: .refreshing) == nil)
    }

    @Test func freshnessIdentifiersExposeBehavioralStates() {
        let projection = projection(view: .month, anchor: "2028-02-14")
        let occurrence = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence])) == "calendar-freshness-up-to-date")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence], freshness: .refreshing, loading: CalendarLoadingState(phase: .refreshing))) == "calendar-freshness-refreshing")
        #expect(CalendarSurfaceMapping.freshnessIdentifier(for: screenState(projection: projection, occurrences: [occurrence], freshness: .cachedOffline, offline: .offline)) == "calendar-freshness-offline")
    }

    @Test func accessibilityCellLabelIncludesFullSemanticStateAndOverflow() {
        let cell = CalendarDateCell(
            date: "2026-04-18", dayOfMonth: 18, events: [], indicators: [],
            overflow: CalendarOverflow(count: 2, label: "2 more events", accessibilityLabel: "2 additional events"),
            isSelected: true, isToday: true, isOutsideMonth: true,
            accessibilityLabel: "Saturday, April 18, 2026"
        )

        let label = CalendarSurfaceText.dateCellLabel(cell)
        #expect(label.contains("Saturday, April 18, 2026"))
        #expect(label.contains("Today"))
        #expect(label.contains("Selected"))
        #expect(label.contains("Outside month"))
        #expect(label.contains("2 additional events"))
    }

    @Test func selectedAbsentFiltersRemainVisibleAndRemovableWithoutChangingOtherFacets() {
        let filters = CalendarFilters(
            scope: .private, groups: Set(["Absent group"]), tags: Set(["absent-tag"]),
            importance: .pinned, text: "pickup"
        )
        let facets = CalendarFacetOptions(
            scopes: [.all, .household], groups: ["Family"], tags: ["school"], importances: [.normal]
        )

        #expect(CalendarFilterMapping.groups(filters: filters, facets: facets) == ["Absent group", "Family"])
        #expect(CalendarFilterMapping.tags(filters: filters, facets: facets) == ["absent-tag", "school"])
        #expect(CalendarFilterMapping.importances(filters: filters, facets: facets) == [.normal, .pinned])

        let changed = CalendarFilterMapping.replacing(
            filters,
            tags: CalendarFilterMapping.toggling("absent-tag", in: filters.tags)
        )
        #expect(changed.tags.isEmpty)
        #expect(changed.scope == .private)
        #expect(changed.groups == Set(["Absent group"]))
        #expect(changed.importance == .pinned)
        #expect(changed.text == "pickup")

        let clearedImportance = CalendarFilterMapping.replacing(filters, importance: .some(nil))
        #expect(clearedImportance.importance == nil)
        #expect(clearedImportance.tags == Set(["absent-tag"]))
    }

    @Test func controlledActionClosuresPreserveSelectionValues() {
        var dates: [String] = []
        var months: [(Int32, Int32)] = []
        var views: [CalendarView] = []
        let actions = CalendarSurfaceActions(
            onBack: {}, onAdd: {}, onToday: {}, onPrevious: {}, onNext: {},
            onSelectDate: { dates.append($0) },
            onSelectMonth: { months.append(($0, $1)) },
            onSelectView: { views.append($0) },
            onFiltersChanged: { _ in }, onSearch: { _ in }, onEvent: { _ in }, onRetry: {}
        )

        actions.onSelectDate("2026-04-18")
        actions.onSelectMonth(2027, 9)
        actions.onSelectView(.week)

        #expect(dates == ["2026-04-18"])
        #expect(months.count == 1)
        #expect(months[0].0 == 2027 && months[0].1 == 9)
        #expect(views == [.week])
    }

    @Test func formattingUsesFullDatesAndSharedDisplayTimes() {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        #expect(CalendarSurfaceText.fullDate("2026-04-18", locale: locale) == "Saturday, April 18, 2026")
        let event = projection(view: .day, anchor: "2028-02-14").day?.events.first
        #expect(event.map(CalendarSurfaceText.eventTime) == "3:20 PM")
    }

    @Test func screenMapsProjectedActionToExactAuthorizedOccurrenceIdentity() throws {
        let projection = projection(view: .day, anchor: "2028-02-14")
        let event = try #require(projection.day?.events.first)
        let wrong = screenOccurrence(originalStart: "2028-02-14T14:20:00Z")
        let exact = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        let state = screenState(projection: projection, occurrences: [wrong, exact])

        #expect(CalendarScreenMapping.occurrence(for: event, in: state) === exact)
    }

    @Test func screenNavigationAlwaysDismissesTopMutationStateFirst() {
        let projection = projection(view: .day, anchor: "2028-02-14")
        let occurrence = screenOccurrence(originalStart: "2028-02-14T15:20:00Z")
        let closed = screenState(projection: projection, occurrences: [occurrence])
        #expect(CalendarScreenMapping.navigationDisposition(for: closed) == .perform)

        let openMutation = CalendarMutationState(
            phase: .previewing, preview: occurrence, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        )
        let open = screenState(projection: projection, occurrences: [occurrence], mutation: openMutation)
        #expect(CalendarScreenMapping.navigationDisposition(for: open) == .dismissOverlayFirst)
    }

    private func projection(view: CalendarView, anchor: String) -> CalendarExperienceProjection {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        let occurrence = CalendarProjectionOccurrence(
            eventId: "event", occurrenceId: "occurrence", originalStart: "2028-02-14T15:20:00Z",
            recurring: false, recurrence: nil, revision: 1, scope: .household,
            title: "School pickup", description: nil,
            start: "2028-02-14T15:20:00Z", end: "2028-02-14T16:00:00Z",
            visibility: .everyone, importance: .important, group: "Family", tags: ["school"],
            persistedTimeZoneId: "UTC"
        )
        return CalendarProjection().project(request: CalendarProjectionRequest(
            occurrences: [occurrence], anchorDate: anchor, view: view,
            selectedDate: anchor, todayDate: anchor, locale: locale,
            filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
        ))
    }

    private func screenOccurrence(originalStart: String) -> EffectiveOccurrence {
        EffectiveOccurrence(
            eventId: "event", occurrenceId: "occurrence", originalStart: originalStart,
            recurring: false, revision: 1, scope: .household, title: "School pickup",
            description: nil, start: "2028-02-14T15:20:00Z", end: "2028-02-14T16:00:00Z",
            visibility: .everyone, importance: .important, group: "Family", tags: ["school"], recurrence: nil
        )
    }

    private func screenState(
        projection: CalendarExperienceProjection,
        occurrences: [EffectiveOccurrence],
        mutation: CalendarMutationState = CalendarMutationState(
            phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil,
            pendingRequest: nil, error: nil, conflict: nil, outcome: nil,
            successorEventId: nil, affectedWindows: []
        ),
        freshness: CalendarCacheFreshness = .fresh,
        loading: CalendarLoadingState = CalendarLoadingState(phase: .idle),
        offline: CalendarOfflineState = .online
    ) -> CalendarUiState {
        CalendarUiState(CalendarExperienceState(
            anchorDate: projection.anchorDate, view: projection.view,
            selectedDate: projection.selectedDate, filters: projection.filters,
            locale: projection.locale, todayDate: projection.todayDate,
            visibleInterval: projection.interval, selectedInterval: nil,
            authorizedOccurrences: occurrences, projection: projection, facets: projection.facets,
            freshness: freshness, loading: loading, offline: offline,
            error: nil, hasCompleteCache: true, cachedWindow: nil, persistedCachePreferences: nil,
            presentationReady: true,
            recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
            mutationAvailability: CalendarMutationAvailability(
                canCreate: true, canEdit: true, canDelete: true, reason: nil
            ),
            mutation: mutation
        ))
    }
}
