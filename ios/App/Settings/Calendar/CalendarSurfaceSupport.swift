import Foundation
import MobileData
import SwiftUI

enum CalendarFont {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .semibold, relativeTo style: Font.TextStyle = .headline) -> Font {
        .custom(Fonts.shared.display, size: size, relativeTo: style).weight(weight)
    }

    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(Fonts.shared.ui, size: size, relativeTo: style).weight(weight)
    }

    static func mono(_ size: CGFloat, relativeTo style: Font.TextStyle = .caption) -> Font {
        .custom(Fonts.shared.mono, size: size, relativeTo: style)
    }
}

enum CalendarSurfaceLayout {
    static let topBarHeight: CGFloat = 58
    static let contentInset: CGFloat = 16
    static let minimumTarget: CGFloat = 44
    static let tagVisualHeight: CGFloat = 34
    static let agendaRowHeight: CGFloat = 64
    static let viewControlHeight: CGFloat = 46
    static let floatingBarClearance: CGFloat = 78
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

    static func date(_ value: String) -> Date? { isoFormatter.date(from: value) }

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

    static func subtitle(for state: CalendarUiState) -> String {
        if state.view == .year { return "YEAR AT A GLANCE" }
        guard let date = date(state.selectedDate) else { return state.selectedDate.uppercased() }
        return date.formatted(.dateTime.locale(Locale(identifier: state.locale.languageTag)).weekday(.wide).day()).uppercased()
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
        if state.isRefreshing { return "Refreshing calendar" }
        if state.isOffline { return "Showing saved calendar data" }
        if state.content == .empty { return "No events match these filters" }
        return nil
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
        if !state.agenda.isEmpty {
            return state.agenda.map { .init(date: $0.date, events: $0.events, accessibilityLabel: $0.accessibilityLabel) }
        }
        if let month = state.month {
            return month.cells.compactMap { cell in
                cell.events.isEmpty ? nil : .init(date: cell.date, events: cell.events, accessibilityLabel: cell.accessibilityLabel)
            }
        }
        return []
    }
}

struct CalendarPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}
