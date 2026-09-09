import MobileData
import SwiftUI

/// Civil identity, not a cache key or authorization capability. The shared
/// adapter must include its namespace/epoch, locale and filters in its reads.
struct CalendarViewportMonth: Hashable, Comparable {
    let year: Int32
    let month: Int32

    /// The shared viewport contract can render a complete 42-cell grid from
    /// January 0001 through November 9999. December 9999 would require a
    /// five-digit year in the trailing outside cells.
    static let firstSupportedIndex = 0
    static let lastSupportedIndex = (9999 - 1) * 12 + (11 - 1)
    static let nativeMonthCount = lastSupportedIndex + 1

    init(year: Int32, month: Int32) { self.year = year; self.month = month }
    init(date: String) {
        year = Int32(date.prefix(4)) ?? 1
        month = Int32(date.dropFirst(5).prefix(2)) ?? 1
    }
    init(index: Int) {
        year = Int32(index / 12 + 1)
        month = Int32(index % 12 + 1)
    }
    var index: Int { (Int(year) - 1) * 12 + Int(month) - 1 }
    var date: String { String(format: "%04d-%02d-01", year, month) }
    var isNativeSupported: Bool {
        year >= 1 && year <= 9999 && month >= 1 && month <= 12 &&
            (Self.firstSupportedIndex...Self.lastSupportedIndex).contains(index)
    }
    static func clampedToNativeDomain(_ month: Self) -> Self {
        Self(index: min(lastSupportedIndex, max(firstSupportedIndex, month.index)))
    }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.index < rhs.index }
}

/// Geometry shared by the native layout and the Canvas/date interaction
/// surface. The 42-cell projection remains the validation input; these
/// helpers describe only the owned rows that are actually presented.
enum CalendarNativeMonthGeometry {
    static let compactRowCount = 6

    struct CivilDate: Equatable {
        let year: Int
        let month: Int
        let day: Int

        var string: String {
            String(format: "%04d-%02d-%02d", year, month, day)
        }
    }

    static func isLeapYear(_ year: Int) -> Bool {
        year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    }

    static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 2: return isLeapYear(year) ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    static func daysInMonth(index: Int) -> Int {
        daysInMonth(year: index / 12 + 1, month: index % 12 + 1)
    }

    /// Astronomical-year proleptic Gregorian arithmetic matching the shared
    /// date adapter. In particular, year 0000 is the leap year immediately
    /// before year 0001; Foundation era components are not used for identity.
    static func civilDate(year: Int, month: Int, day: Int, offset: Int = 0) -> CivilDate {
        civilDate(from: daysFromCivil(year: year, month: month, day: day) + Int64(offset))
    }

    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int64 {
        var adjustedYear = Int64(year)
        adjustedYear -= month <= 2 ? 1 : 0
        let era = floorDiv(adjustedYear, 400)
        let yearOfEra = adjustedYear - era * 400
        let monthPrime = Int64(month) + (month > 2 ? -3 : 9)
        let dayOfYear = (153 * monthPrime + 2) / 5 + Int64(day) - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146097 + dayOfEra
    }

    private static func civilDate(from value: Int64) -> CivilDate {
        let era = floorDiv(value, 146097)
        let dayOfEra = value - era * 146097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
        var year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime + (monthPrime < 10 ? 3 : -9)
        year += month <= 2 ? 1 : 0
        return CivilDate(year: Int(year), month: Int(month), day: Int(day))
    }

    private static func floorDiv(_ value: Int64, _ divisor: Int64) -> Int64 {
        let quotient = value / divisor
        return value % divisor < 0 ? quotient - 1 : quotient
    }

    /// Days before the first day of a month in the proleptic Gregorian domain,
    /// with January 1 of year 1 at ordinal zero.
    static func daysBeforeMonth(index: Int) -> Int {
        let year = index / 12 + 1
        let month = index % 12 + 1
        let previousYear = year - 1
        let monthDays = (367 * month - 362) / 12 -
            (month <= 2 ? 0 : isLeapYear(year) ? 1 : 2)
        return previousYear * 365 + previousYear / 4 - previousYear / 100 + previousYear / 400 + monthDays
    }

    static func normalizedWeekday(_ firstWeekday: Int) -> Int {
        (firstWeekday - 1 + 7) % 7 + 1
    }

    static func leadingSlot(index: Int, firstWeekday: Int) -> Int {
        let offset = (9 - normalizedWeekday(firstWeekday)) % 7
        return (daysBeforeMonth(index: index) + offset) % 7
    }

    static func ownedRowCount(index: Int, firstWeekday: Int) -> Int {
        (leadingSlot(index: index, firstWeekday: firstWeekday) + daysInMonth(index: index) + 6) / 7
    }

    // Immutable, content-free prefixes: seven week starts × one Gregorian
    // cycle (4,801 integers each), not a table for the whole date domain.
    // Layout/frame/request queries subsequently do constant-time arithmetic.
    private static let rowPrefixes: [[Int]] = (1...7).map { weekday in
        var prefix = [0]
        prefix.reserveCapacity(4_801)
        for month in 0..<4_800 {
            prefix.append(prefix.last! + ownedRowCount(index: month, firstWeekday: weekday))
        }
        return prefix
    }

    static func rowsBeforeMonth(index: Int, firstWeekday: Int) -> Int {
        guard index > 0 else { return 0 }
        let prefix = rowPrefixes[normalizedWeekday(firstWeekday) - 1]
        return (index / 4_800) * prefix[4_800] + prefix[index % 4_800]
    }

    static func headingHeight(dateSize: CGFloat) -> CGFloat {
        max(CalendarSurfaceLayout.minimumTarget, dateSize * 2 + Space.sm)
    }

    static func compactWeekdayHeight(dateSize: CGFloat) -> CGFloat {
        max(CalendarSurfaceLayout.miniDayHeight, dateSize * 1.6)
    }

    static func compactRowHeight(dateSize: CGFloat) -> CGFloat {
        // Keep the established date/marker spacing and mini-cell floor.
        max(CalendarSurfaceLayout.miniDayHeight,
            dateSize + Space.sm + CalendarSurfaceLayout.indicatorSize + Space.xs)
    }

    static func monthRowHeight(width: CGFloat, rowHeight: CGFloat) -> CGFloat {
        max(width / 7 * 1.2, max(rowHeight, CalendarSurfaceLayout.minimumTarget))
    }

    static func compactHeight(dateSize: CGFloat) -> CGFloat {
        let inset = Space.md
        return inset * 2 + headingHeight(dateSize: dateSize) +
            compactWeekdayHeight(dateSize: dateSize) +
            compactRowHeight(dateSize: dateSize) * CGFloat(compactRowCount)
    }

    static func dateNumberCenter(in rect: CGRect, dateSize: CGFloat) -> CGPoint {
        let markerBlock = dateSize + Space.xs + CalendarSurfaceLayout.indicatorSize
        let numberTop = max(rect.minY + Space.xs + DesignMetrics.hairline * 2,
                            rect.midY - markerBlock / 2)
        return CGPoint(x: rect.midX, y: numberTop + dateSize / 2)
    }

    static func significanceCenter(in rect: CGRect, dateSize: CGFloat) -> CGPoint {
        let number = dateNumberCenter(in: rect, dateSize: dateSize)
        return CGPoint(x: number.x,
                       y: number.y + dateSize / 2 + Space.xs + CalendarSurfaceLayout.indicatorSize / 2)
    }

    static func markerGroupWidth(markCount: Int, diameter: CGFloat, gap: CGFloat,
                                 overflowWidth: CGFloat = 0, overflowGap: CGFloat = 0) -> CGFloat {
        let marks = markCount == 0 ? 0 : CGFloat(markCount) * diameter + CGFloat(markCount - 1) * gap
        return marks + (markCount > 0 && overflowWidth > 0 ? overflowGap : 0) + overflowWidth
    }
}

/// Replace, never merge, this input on every authorized shared emission.
/// Explicit inactivity clears even with a foreground projection. An absent month is unknown,
/// not an empty month. `generation` changes at auth/locale/filter invalidation.
struct CalendarViewportData {
    let generation: String
    /// Monotonically changes for every replacement emission within a generation.
    let revision: Int
    let months: [CalendarViewportMonth: CalendarViewportMonthData]
    /// Current shared lease authority, independent of foreground loading.
    let isActive: Bool
}

struct CalendarViewportMonthData {
    enum Availability: Equatable { case ready, loading, unavailable }
    let cells: [CalendarDateCell]
    let availability: Availability

    /// Shared formatting is authoritative; validate identity completeness only.
    func validated(for civil: CalendarCivilMonth) -> Self {
        guard availability == .ready else { return self }
        let expected = Set(civil.slots.map(\.date))
        let received = Set(cells.map(\.date))
        guard cells.count == 42, received.count == 42, expected == received else {
            return Self(cells: [], availability: .unavailable)
        }
        return self
    }
}

struct CalendarViewportRequest: Equatable {
    // Mirrors the private MAX_VIEWPORT_PERIODS in shared CalendarViewport.kt.
    static let maximumPeriods = 48
    /// Visible-first month units plus one complete overscan row on each edge.
    let months: [CalendarViewportMonth]
}

/// The interpolation clock is scoped to this native component, not injected
/// into the workspace environment. UIKit owns both layouts and their cursor;
/// the SAME sample places cells and draws their interiors. No endpoint copies,
/// independent interior animation, observable frame writes or scroll timers.
struct CalendarMorphStage: View {
    let state: CalendarUiState
    let onSelectDate: (String) -> Void
    let onSelectMonth: (Int32, Int32) -> Void
    var viewportData: CalendarViewportData? = nil
    var onRequestPeriods: (CalendarViewportRequest) -> Void = { _ in }
    var onBrowse: (CalendarViewportMonth) -> Void = { _ in }
    var browsedMonth: CalendarViewportMonth? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var direction
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var dynamicType
    @Environment(\.calendarBottomOcclusion) private var bottomOcclusion
    @ScaledMetric(relativeTo: .footnote) private var dateSize = TypeScale.sm
    @ScaledMetric(relativeTo: .body) private var rowHeight = CalendarSurfaceLayout.monthCellHeight
    @ScaledMetric(relativeTo: .body) private var dateWidth = CalendarSurfaceLayout.minimumTarget

    var body: some View {
        CalendarViewportMotion(
            progress: state.view == .year ? 0 : 1,
            input: CalendarNativeViewportInput(
                state: state, data: viewportData, browsedMonth: browsedMonth,
                rightToLeft: direction == .rightToLeft,
                increasedContrast: contrast == .increased,
                accessibilitySize: dynamicType.isAccessibilitySize, reduceMotion: reduceMotion,
                dateSize: dateSize, rowHeight: rowHeight, dateWidth: dateWidth,
                onSelectDate: onSelectDate, onSelectMonth: onSelectMonth,
                onRequest: onRequestPeriods, onBrowse: onBrowse,
                bottomOcclusion: bottomOcclusion
            )
        )
        .animation(reduceMotion || !(viewportData?.isActive ?? (state.projection != nil)) ? nil : CalendarSurfaceLayout.spatialAnimation,
                   value: state.view)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(state.view.displayName) calendar")
    }
}

private struct CalendarViewportMotion: View, Animatable {
    var progress: CGFloat
    let input: CalendarNativeViewportInput
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
    var body: some View { CalendarNativeViewport(input: input, progress: progress) }
}

/// Locale-only geometry may be cached. Never put authorized events here.
struct CalendarCivilMonth {
    struct Slot {
        let date: String
        let number: String
        let label: String
        let outside: Bool
    }
    let id: CalendarViewportMonth
    let title: String
    let weekdays: [String]
    let slots: [Slot]
    // One extra week on each side handles ±7 keyboard steps from any owned
    // date, including a first-of-month in slot zero. Prepared, not date math
    // in a key/scroll/frame handler. Never rendered or exposed as AX dates.
    private let keyboardDates: [String]

    var ownedRowCount: Int {
        guard let first = slots.firstIndex(where: { !$0.outside }),
              let last = slots.lastIndex(where: { !$0.outside }) else { return 0 }
        return last / 7 - first / 7 + 1
    }

    func keyboardDate(from slot: Int, step: Int) -> String? {
        let target = slot + step
        guard keyboardDates.indices.contains(target + 7) else { return nil }
        let date = keyboardDates[target + 7]
        // Outside cells are useful for crossing ordinary month boundaries,
        // but the native viewport has no owner for year 0000 or December
        // 9999. Keep keyboard focus inside the same shared-supported domain.
        guard CalendarViewportMonth(date: date).isNativeSupported else { return nil }
        return date
    }

    static func calendar(_ locale: CalendarLocale) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: locale.languageTag)
        calendar.timeZone = .gmt
        calendar.firstWeekday = firstWeekday(locale)
        return calendar
    }

    static func firstWeekday(_ locale: CalendarLocale) -> Int {
        switch locale.resolvedWeekStart {
        case .sunday: return 1
        case .monday: return 2
        case .tuesday: return 3
        case .wednesday: return 4
        case .thursday: return 5
        case .friday: return 6
        case .saturday: return 7
        }
    }

    init(id: CalendarViewportMonth, locale: CalendarLocale) {
        self.id = id
        let calendar = Self.calendar(locale)
        let symbols = calendar.veryShortStandaloneWeekdaySymbols
        weekdays = (0..<7).map { symbols[(calendar.firstWeekday - 1 + $0) % 7] }
        title = "\(calendar.standaloneMonthSymbols[Int(id.month) - 1]) \(id.year)"
        let leading = CalendarNativeMonthGeometry.leadingSlot(index: id.index, firstWeekday: calendar.firstWeekday)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = .gmt
        formatter.locale = calendar.locale
        formatter.dateStyle = .full
        let prepared = (-7..<49).map { index in
            let parts = CalendarNativeMonthGeometry.civilDate(
                year: Int(id.year), month: Int(id.month), day: 1, offset: index - leading
            )
            return Slot(
                date: parts.string,
                number: String(parts.day),
                label: Self.localizedLabel(for: parts, calendar: calendar, formatter: formatter),
                outside: parts.month != Int(id.month) || parts.year != Int(id.year)
            )
        }
        slots = Array(prepared[7..<49])
        keyboardDates = prepared.map(\.date)
    }

    private static func localizedLabel(
        for parts: CalendarNativeMonthGeometry.CivilDate,
        calendar: Calendar,
        formatter: DateFormatter
    ) -> String {
        // DateFormatter remains the localized presentation source for dates
        // Foundation can represent. Verify its era-based components before
        // accepting the label so year 0000 can never be mislabeled as 1 BC/AD.
        guard parts.year >= 1,
              let date = calendar.date(from: DateComponents(era: 1, year: parts.year,
                                                             month: parts.month, day: parts.day)) else {
            return parts.string
        }
        let actual = calendar.dateComponents([.era, .year, .month, .day], from: date)
        guard actual.era == 1, actual.year == parts.year,
              actual.month == parts.month, actual.day == parts.day else {
            return parts.string
        }
        return formatter.string(from: date)
    }
}

struct CalendarFixedWeekdays: View {
    let locale: CalendarLocale
    @Environment(\.dynamicTypeSize) private var dynamicType
    var body: some View {
        let calendar = CalendarCivilMonth.calendar(locale)
        let symbols = dynamicType.isAccessibilitySize ? calendar.veryShortStandaloneWeekdaySymbols : calendar.shortStandaloneWeekdaySymbols
        HStack(spacing: 0) {
            ForEach(0..<7, id: \.self) { index in
                Text(symbols[(calendar.firstWeekday - 1 + index) % 7])
                    .font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(minHeight: CalendarSurfaceLayout.weekdayHeaderHeight)
        .background(DuskColors.bgSunk)
        .accessibilityHidden(true) // Every date has its full localized weekday.
    }
}
