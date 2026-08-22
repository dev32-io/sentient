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

    private func projection(view: CalendarView, anchor: String) -> CalendarExperienceProjection {
        let locale = CalendarLocale(languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12)
        let occurrence = CalendarProjectionOccurrence(
            eventId: "event", occurrenceId: "occurrence", originalStart: nil,
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
}
