import Foundation
import MobileData
import SwiftUI

/// Calendar-specific geometry approved by the reviewed native surface. Color,
/// typography, spacing, radii, motion, and material values come from Foundation.
enum CalendarSurfaceLayout {
    static let topBarHeight: CGFloat = 58
    static let contentInset: CGFloat = 16
    static let minimumTarget = DesignMetrics.minimumTarget
    static let tagVisualHeight: CGFloat = 34
    static let agendaRowHeight: CGFloat = 64
    static let viewControlHeight: CGFloat = 46
    static let floatingBarClearance: CGFloat = 78
    static let accessibilitySentinelSize = DesignMetrics.hairline
    static let weekDayHeight: CGFloat = 70
    static let weekdayHeaderHeight: CGFloat = 34
    static let monthDaySize: CGFloat = 25
    static let monthCellHeight: CGFloat = 53
    static let miniMonthWidth: CGFloat = 150
    static let miniDayHeight: CGFloat = 22
    static let spatialAnimation = Animation.easeInOut(duration: Motion.normal)
    // Detail appears after the grid has opened; reversal uses the same phase.
    static let indicatorRevealStart: CGFloat = 0.5
    // calendar.css: quiet Year face, Month cell face, and inset selection.
    static let yearFaceOpacity = 0.66
    static let monthCellFaceOpacity = 0.36
    static let monthSelectionOpacity = 0.22
    static let monthSelectionLineOpacity = 0.24
    static let monthGridLineWidth: CGFloat = 0.5
    static let indicatorSize: CGFloat = 5
    static let indicatorRowHeight: CGFloat = 8
    static let overflowTypeSize: CGFloat = 8
    static let agendaDateInset: CGFloat = 2
    static let agendaTimeWidth: CGFloat = 54
    static let scopeBadgeSize: CGFloat = 28
    static let emptyStateHeight: CGFloat = 96
    static let filterHorizontalPadding: CGFloat = 13
    static let tagHorizontalPadding: CGFloat = 10
    static let floatingHorizontalInset: CGFloat = 12
    static let floatingInnerPadding: CGFloat = 5
    static let floatingPaperOpacity = 0.94
    static let floatingShadowOpacity = 0.82
    static let floatingShadowRadius: CGFloat = 28
    static let floatingShadowY: CGFloat = 20
    static let disabledOpacity = 0.45
    static let pressedScale = 0.985
    static let normalScale = 1.0
}

enum CalendarSurfaceText {
    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func date(_ value: String) -> Date? {
        // Foundation's era-based formatter cannot label astronomical year 0.
        guard let year = Int(value.prefix(4)), year > 0 else { return nil }
        return isoFormatter.date(from: value)
    }

    static func fullDate(_ value: String, locale: CalendarLocale) -> String {
        guard let date = date(value) else { return value }
        return date.formatted(.dateTime.locale(Locale(identifier: locale.languageTag)).weekday(.wide).month(.wide).day().year())
    }

    static func heading(for state: CalendarUiState) -> String {
        guard let date = date(state.anchorDate) else { return state.anchorDate }
        let style: Date.FormatStyle
        switch state.view {
        case .day: style = .dateTime.locale(Locale(identifier: state.locale.languageTag)).month(.wide).day()
        case .week:
            guard let week = state.week,
                  let start = self.date(week.startDate), let end = self.date(week.endDate) else {
                return fullDate(state.anchorDate, locale: state.locale)
            }
            let first = start.formatted(.dateTime.locale(Locale(identifier: state.locale.languageTag)).month(.abbreviated).day())
            let last = end.formatted(.dateTime.locale(Locale(identifier: state.locale.languageTag)).month(.abbreviated).day())
            return "\(first)–\(last)"
        case .month: style = .dateTime.locale(Locale(identifier: state.locale.languageTag)).month(.wide).year()
        case .year: style = .dateTime.locale(Locale(identifier: state.locale.languageTag)).year()
        }
        return date.formatted(style)
    }

    static func adjacentHeading(
        view: CalendarView, anchorDate: String,
        projection: CalendarExperienceProjection?, locale: CalendarLocale
    ) -> String {
        let language = Locale(identifier: locale.languageTag)
        if view == .week, let anchor = CalendarViewportDate(date: anchorDate) {
            let days = CalendarCivilDay.dates(for: .init(view: .week, anchor: anchor), locale: locale)
            if let first = days.first, let last = days.last,
               let start = date(first.string), let end = date(last.string) {
                let style = Date.FormatStyle.dateTime.locale(language).month(.abbreviated).day()
                return "\(start.formatted(style))–\(end.formatted(style))"
            }
        }
        guard view == .day, let day = date(projection?.day?.date ?? anchorDate) else {
            return fullDate(anchorDate, locale: locale)
        }
        return day.formatted(.dateTime.locale(language).month(.wide).day())
    }

    static func agendaHeading(_ date: String, locale: CalendarLocale) -> (date: String, weekday: String) {
        guard let value = self.date(date) else { return (date, "") }
        let locale = Locale(identifier: locale.languageTag)
        return (
            value.formatted(.dateTime.locale(locale).month(.abbreviated).day()),
            value.formatted(.dateTime.locale(locale).weekday(.wide))
        )
    }

    static func eventTime(_ event: CalendarProjectedEvent) -> String {
        switch onEnum(of: event.start) {
        case .allDay: return "All day"
        case .timed(let timed): return timed.displayTime
        }
    }

    static func dateCellLabel(_ cell: CalendarDateCell) -> String {
        var values = [cell.accessibilityLabel]
        if cell.isToday { values.append("Today") }
        if cell.isSelected { values.append("Selected") }
        if cell.isOutsideMonth { values.append("Outside month") }
        if let overflow = cell.overflow { values.append(overflow.accessibilityLabel) }
        return values.joined(separator: ", ")
    }

    static func navigationAnnouncement(_ state: CalendarUiState) -> String {
        "\(state.view.displayName) view, \(fullDate(state.anchorDate, locale: state.locale))"
    }

    static func filterAnnouncementKey(_ state: CalendarUiState) -> String {
        [
            state.filters.scope.name,
            String(state.filters.groups.count),
            String(state.filters.tags.count),
            state.filters.importance?.name ?? "ANY",
            state.filters.text.isEmpty ? "EMPTY" : "SET"
        ].joined(separator: ":")
    }

    static func stateAnnouncement(_ state: CalendarUiState) -> String? {
        if state.content == .unavailableOffline { return "Calendar unavailable offline" }
        if state.content == .error { return state.error?.userMessage ?? "Calendar unavailable" }
        if state.isOffline { return "Showing saved calendar data" }
        if state.content == .empty { return "No events match these filters" }
        return nil
    }

    static func freshnessRecoveryAnnouncement(
        from previous: CalendarCacheFreshness,
        to current: CalendarCacheFreshness
    ) -> String? {
        previous != .fresh && current == .fresh ? "Calendar is up to date" : nil
    }
}

struct CalendarAgendaSlice: Identifiable {
    let date: String
    let events: [CalendarProjectedEvent]
    let accessibilityLabel: String
    var id: String { date }
}

enum CalendarSurfaceMapping {
    static func showsCompactCanvas(_ view: CalendarView) -> Bool { view != .day }

    static func agenda(for state: CalendarUiState) -> [CalendarAgendaSlice] {
        state.agenda.map { .init(date: $0.date, events: $0.events, accessibilityLabel: $0.accessibilityLabel) }
    }

    static func agenda(for projection: CalendarExperienceProjection) -> [CalendarAgendaSlice] {
        let sections = projection.day?.agenda ?? projection.week?.agenda ?? []
        return sections.map { .init(date: $0.date, events: $0.events, accessibilityLabel: $0.accessibilityLabel) }
    }

    static func freshnessIdentifier(for state: CalendarUiState) -> String {
        if state.content == .unavailableOffline { return "calendar-freshness-unavailable" }
        if state.isOffline { return "calendar-freshness-offline" }
        if state.isRefreshing { return "calendar-freshness-refreshing" }
        if state.freshness == .stale { return "calendar-freshness-stale" }
        return "calendar-freshness-up-to-date"
    }
}

struct CalendarPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? CalendarSurfaceLayout.pressedScale : CalendarSurfaceLayout.normalScale)
            .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}
