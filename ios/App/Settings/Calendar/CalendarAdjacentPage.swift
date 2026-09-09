import Foundation
import MobileData
import SwiftUI

/// Geometry only: strict Gregorian civil dates, never event instants or cache keys.
struct CalendarViewportDate: Hashable, Comparable {
    let date: String

    init?(date: String) {
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard date.count == 10, parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...9999).contains(year), (1...12).contains(month), (1...31).contains(day),
              let value = Self.calendar.date(from: DateComponents(year: year, month: month, day: day)),
              Self.string(value) == date else { return nil }
        self.date = date
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }

    private static func string(_ value: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: value)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    func adding(days: Int) -> Self? {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let next = CalendarNativeMonthGeometry.civilDate(
            year: parts[0], month: parts[1], day: parts[2], offset: days
        )
        guard (1...9999).contains(next.year) else { return nil }
        return Self(date: next.string)
    }

    /// The shared lease accepts a complete 42-cell month grid around every
    /// adjacent anchor. The native month domain deliberately stops at
    /// 9999-11, while January 0001 remains valid because its leading grid
    /// cells are representable in astronomical year 0000.
    var isAdjacentViewportEligible: Bool {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return false }
        let month = CalendarViewportMonth(year: Int32(parts[0]), month: Int32(parts[1]))
        guard month.isNativeSupported else { return false }
        let leading = CalendarNativeMonthGeometry.civilDate(
            year: parts[0], month: parts[1], day: 1, offset: -6
        )
        let trailing = CalendarNativeMonthGeometry.civilDate(
            year: parts[0], month: parts[1], day: 1, offset: 42
        )
        return Self.isSharedCalendarDate(leading) && Self.isSharedCalendarDate(trailing)
    }

    private static func isSharedCalendarDate(_ date: CalendarNativeMonthGeometry.CivilDate) -> Bool {
        (0...9999).contains(date.year) && (1...12).contains(date.month) &&
            (1...CalendarNativeMonthGeometry.daysInMonth(year: date.year, month: date.month)).contains(date.day)
    }

    static func < (lhs: Self, rhs: Self) -> Bool { lhs.date < rhs.date }
}

struct CalendarAdjacentPageID: Hashable {
    let view: CalendarView
    let anchor: CalendarViewportDate

    var stepDays: Int { view == .week ? 7 : 1 }

    var isAdjacentViewportEligible: Bool { anchor.isAdjacentViewportEligible }

    func adding(periods: Int) -> Self? {
        guard let next = anchor.adding(days: periods * stepDays) else { return nil }
        let candidate = Self(view: view, anchor: next)
        return candidate.isAdjacentViewportEligible ? candidate : nil
    }

    /// Clamps an unsupported explicit cursor to the final native/shared
    /// period without ever constructing a rejected request anchor.
    var clampedToAdjacentViewportDomain: Self? {
        let month = CalendarViewportMonth(date: anchor.date)
        guard !isAdjacentViewportEligible, month.index > CalendarViewportMonth.lastSupportedIndex else {
            return isAdjacentViewportEligible ? self : nil
        }
        let clamped = CalendarViewportMonth.clampedToNativeDomain(month)
        let day = CalendarNativeMonthGeometry.daysInMonth(
            year: Int(clamped.year), month: Int(clamped.month)
        )
        let dateString = String(format: "%04d-%02d-%02d", Int(clamped.year), Int(clamped.month), day)
        guard let date = CalendarViewportDate(date: dateString) else { return nil }
        let candidate = Self(view: view, anchor: date)
        return candidate.isAdjacentViewportEligible ? candidate : nil
    }

    var previous: Self? { adding(periods: -1) }
    var next: Self? { adding(periods: 1) }

    /// Retained as a compatibility convenience for callers that need a bounded
    /// civil neighborhood. It is a vertical working-set seed, not a pager.
    var window: [Self] { CalendarAdjacentPeriodWindow.initial(around: self) }
}

/// The UIKit owner keeps only a small contiguous working set. Shared viewport
/// requests may be replaced as this set rolls in either direction.
enum CalendarAdjacentPeriodWindow {
    static let maximumPeriods = 15
    static let expansionCount = 4
    static let initialRadius = 4

    static func initial(around center: CalendarAdjacentPageID) -> [CalendarAdjacentPageID] {
        let origin = center.clampedToAdjacentViewportDomain ?? center
        return (-initialRadius...initialRadius).compactMap { origin.adding(periods: $0) }
    }

    /// A navigation destination starts at native y=0. Earlier periods are
    /// prepended by the existing edge-scroll path, not fitted/searched before
    /// the first incoming civil row can be presented. Same nine-period ceiling.
    static func starting(at center: CalendarAdjacentPageID) -> [CalendarAdjacentPageID] {
        let origin = center.clampedToAdjacentViewportDomain ?? center
        return [origin] + after(origin, count: initialRadius * 2)
    }

    static func before(_ period: CalendarAdjacentPageID, count: Int) -> [CalendarAdjacentPageID] {
        guard count > 0 else { return [] }
        return (1...count).reversed().compactMap { period.adding(periods: -$0) }
    }

    static func after(_ period: CalendarAdjacentPageID, count: Int) -> [CalendarAdjacentPageID] {
        guard count > 0 else { return [] }
        return (1...count).compactMap { period.adding(periods: $0) }
    }
}

struct CalendarAdjacentViewportRequest: Equatable {
    let view: CalendarView
    /// Visible first, then the bounded civil overscan working set.
    let periods: [CalendarViewportDate]
}

struct CalendarAdjacentViewportData {
    let isActive: Bool
    let generation: String
    let revision: Int
    let pages: [CalendarAdjacentPageID: CalendarAdjacentPageData]
    /// The shared semantic cursor, separate from the route-local leading-row
    /// cursor. This lets UIKit ignore the transient cursor-clear echo that
    /// precedes an explicit Previous/Today/Next state publication.
    let semanticAnchor: CalendarViewportDate?
    let selectedDate: String
    let todayDate: String

    init(
        isActive: Bool,
        generation: String,
        revision: Int,
        pages: [CalendarAdjacentPageID: CalendarAdjacentPageData],
        semanticAnchor: CalendarViewportDate? = nil,
        selectedDate: String = "", todayDate: String = ""
    ) {
        self.isActive = isActive
        self.generation = generation
        self.revision = revision
        self.pages = pages
        self.semanticAnchor = semanticAnchor
        self.selectedDate = selectedDate
        self.todayDate = todayDate
    }
}

struct CalendarAdjacentPageData {
    let projection: CalendarExperienceProjection?
    let loading: CalendarLoadingState
    let freshness: CalendarCacheFreshness
    let offline: CalendarOfflineState
    let error: CalendarExperienceError?
}

enum CalendarAdjacentRowKind: Hashable {
    case status
    case weekOverview
    case dayHeading(String)
    case event(String)
    case empty
}

struct CalendarAdjacentRowID: Hashable {
    let period: CalendarAdjacentPageID
    let kind: CalendarAdjacentRowKind
}

/// Non-event status only. An unchanged civil/status host must not retain an
/// older period's entire event projection merely to say whether data is known.
struct CalendarAdjacentAvailability: Equatable {
    let isKnown: Bool
    let freshness: CalendarCacheFreshness?
    let offline: CalendarOfflineState?
    let error: CalendarExperienceError?

    init(_ data: CalendarAdjacentPageData?) {
        isKnown = data?.projection != nil
        freshness = data?.freshness
        offline = data?.offline
        error = data?.error
    }
}

/// A single independently recyclable agenda item. A period is deliberately
/// flattened into these rows instead of being hosted as one large SwiftUI view.
struct CalendarAdjacentRow {
    enum Content {
        case status
        case weekOverview([CalendarCivilDay], CalendarWeekProjection?, String, String)
        case dayHeading(CalendarAgendaSlice)
        case event(CalendarProjectedEvent)
        case empty
    }

    let id: CalendarAdjacentRowID
    let period: CalendarAdjacentPageID
    let availability: CalendarAdjacentAvailability
    let content: Content

    static func rows(
        for period: CalendarAdjacentPageID,
        data: CalendarAdjacentPageData?,
        locale: CalendarLocale,
        civil: [CalendarCivilDay]? = nil,
        selectedDate: String = "", todayDate: String = ""
    ) -> [CalendarAdjacentRow] {
        let days = civil ?? CalendarCivilDay.days(for: period, locale: locale)
        let projection = data?.projection
        let availability = CalendarAdjacentAvailability(data)
        let sections = projection.map { CalendarSurfaceMapping.agenda(for: $0) } ?? []
        var rows: [CalendarAdjacentRow] = []
        if period.view == .week {
            rows.append(.init(
                id: .init(period: period, kind: .weekOverview), period: period, availability: availability,
                content: .weekOverview(days, projection?.week, selectedDate, todayDate)
            ))
        }
        for day in days {
            let section = sections.first { $0.date == day.date }
            let heading = CalendarAgendaSlice(date: day.date, events: [], accessibilityLabel: day.label)
            rows.append(.init(
                id: .init(period: period, kind: .dayHeading(day.date)), period: period, availability: availability,
                content: .dayHeading(heading)
            ))
            rows.append(contentsOf: (section?.events ?? []).map { event in
                CalendarAdjacentRow(
                    id: .init(period: period, kind: .event("\(day.date):\(event.actionIdentity.stableKey)")),
                    period: period, availability: availability, content: .event(event)
                )
            })
        }
        // Only an actual projection establishes emptiness. Civil dates never
        // manufacture event cells, counts, or empty results while awaiting it.
        let known = period.view == .day ? projection?.day != nil : projection?.week != nil
        if known && sections.allSatisfy({ $0.events.isEmpty }) {
            rows.insert(.init(id: .init(period: period, kind: .empty), period: period, availability: availability, content: .empty), at: 1)
        }
        if needsStatus(data) {
            rows.insert(.init(id: .init(period: period, kind: .status), period: period, availability: availability, content: .status), at: 1)
        }
        return rows
    }

    var availabilityLabel: String {
        availability.isKnown ? "Event data available" : "Event data not loaded"
    }

    /// Compare only the presentation owned by this row. Event callbacks retain
    /// the submitted revision fence, so event rows are rebound on a new revision.
    func matchesPresentation(_ other: Self) -> Bool {
        switch (content, other.content) {
        case (.dayHeading(let a), .dayHeading(let b)):
            return a.date == b.date && a.accessibilityLabel == b.accessibilityLabel &&
                availabilityLabel == other.availabilityLabel
        case (.weekOverview(let a, let ap, let asel, let atoday),
              .weekOverview(let b, let bp, let bsel, let btoday)):
            return a == b && ap == bp && asel == bsel && atoday == btoday
        case (.empty, .empty): return true
        case (.status, .status):
            return availability == other.availability
        case (.event(let a), .event(let b)): return a == b
        default: return false
        }
    }

    private static func needsStatus(_ data: CalendarAdjacentPageData?) -> Bool {
        guard let data else { return false }
        if data.error != nil || data.offline != .online { return true }
        if data.projection != nil { return data.freshness == .stale }
        return !data.loading.isInitial && !data.loading.isRefreshing
    }
}

/// One native collection cell hosts exactly one agenda/status/overview row.
struct CalendarAdjacentPage: View {
    var row: CalendarAdjacentRow
    let locale: CalendarLocale
    let rightToLeft: Bool
    let openerFocus: AccessibilityFocusState<CalendarOverlayOrigin?>.Binding
    let onEvent: (CalendarProjectedEvent) -> Void
    let onSelectDate: (String) -> Void
    let onRetry: () -> Void
    @ScaledMetric(relativeTo: .body) private var minimumDateWidth = DesignMetrics.minimumTarget

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DuskColors.bg)
            .environment(\.layoutDirection, rightToLeft ? .rightToLeft : .leftToRight)
            .duskTheme()
    }

    @ViewBuilder private var content: some View {
        switch row.content {
        case .status:
            CalendarAdjacentStatusView(
                availability: row.availability,
                retryAccessibilityId: "calendar-adjacent-retry-\(calendarTagToken(row.period.anchor.date))",
                onRetry: onRetry
            )
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
                .padding(.vertical, Space.xs)
        case .weekOverview(let days, let week, let selected, let today):
            ScrollView(.horizontal, showsIndicators: false) {
                CalendarWeekCanvas(days: days, week: week, selectedDate: selected, todayDate: today, onSelectDate: onSelectDate)
                    .containerRelativeFrame(.horizontal) { width, _ in
                        max(width, minimumDateWidth * 7 + Space.sm * 2 + Space.xs * 6)
                    }
            }
            .padding(.horizontal, CalendarSurfaceLayout.contentInset)
            .accessibilityLabel("Week overview")
        case .dayHeading(let section):
            CalendarAdjacentDayHeading(section: section, locale: locale)
                .accessibilityValue(row.availabilityLabel)
        case .event(let event):
            CalendarAgendaRow(event: event, openerFocus: openerFocus) {
                onEvent(event)
            }
            .padding(.horizontal, CalendarSurfaceLayout.contentInset)
        case .empty:
            CalendarEmptyState(message: "No events match these filters.")
                .padding(.horizontal, CalendarSurfaceLayout.contentInset)
        }
    }
}

private struct CalendarAdjacentDayHeading: View {
    let section: CalendarAgendaSlice
    let locale: CalendarLocale

    var body: some View {
        let heading = CalendarSurfaceText.agendaHeading(section.date, locale: locale)
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Text(heading.date)
                .font(Typo.display(TypeScale.xl, .medium))
                .foregroundStyle(DuskColors.ink)
            Text(heading.weekday)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
            Spacer()
        }
        .padding(.horizontal, CalendarSurfaceLayout.contentInset + CalendarSurfaceLayout.agendaDateInset)
        .padding(.vertical, Space.xs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(section.accessibilityLabel)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct CalendarAdjacentStatusView: View {
    let availability: CalendarAdjacentAvailability
    let retryAccessibilityId: String
    let onRetry: () -> Void

    var body: some View {
        Group {
            if let error = availability.error {
                retryStatus(error.userMessage)
            } else if !availability.isKnown {
                retryStatus(availability.offline != .online ? "Calendar unavailable offline." : "This date range is unavailable.")
            } else if availability.offline != .online {
                Label("Showing saved calendar data", systemImage: "wifi.slash")
                    .foregroundStyle(DuskColors.ink2)
            } else if availability.freshness == .stale {
                Label("Calendar may be out of date", systemImage: "clock")
                    .foregroundStyle(DuskColors.ink2)
            }
        }
        .font(Typo.ui(TypeScale.sm))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func retryStatus(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(message)
                .foregroundStyle(DuskColors.ink2)
            DesignTextButton(title: "Retry", accessibilityId: retryAccessibilityId, action: onRetry)
        }
    }
}
