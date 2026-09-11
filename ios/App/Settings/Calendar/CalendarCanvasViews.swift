import MobileData
import SwiftUI

struct CalendarCanvasView: View {
    let state: CalendarUiState
    let onSelectDate: (String) -> Void
    @ScaledMetric(relativeTo: .body) private var minimumDateWidth = DesignMetrics.minimumTarget

    var body: some View {
        Group {
            switch state.view {
            case .day:
                EmptyView()
            case .week:
                if let week = state.week {
                    ScrollView(.horizontal) {
                        CalendarWeekCanvas(week: week, onSelectDate: onSelectDate)
                            .containerRelativeFrame(.horizontal) { width, _ in
                                max(width, minimumDateWidth * 7 + Space.sm * 2 + Space.xs * 6)
                            }
                    }
                }
            case .month, .year:
                // The scaffold owns their fixed stage, never a nested canvas.
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(state.view.displayName) calendar")
    }
}

/// Content-free dates, shared by pending and projected Week rows. No event or
/// authorization state is cached here. Week bounds match shared weekStart.
struct CalendarCivilDay: Equatable {
    let date: String
    let number: Int
    let weekday: String
    let label: String

    static func dates(for period: CalendarAdjacentPageID, locale: CalendarLocale) -> [CalendarNativeMonthGeometry.CivilDate] {
        let month = CalendarViewportMonth(date: period.anchor.date)
        let day = Int(period.anchor.date.suffix(2))!
        let firstWeekday = CalendarCivilMonth.firstWeekday(locale)
        let leading = CalendarNativeMonthGeometry.leadingSlot(index: month.index, firstWeekday: firstWeekday)
        let offset = period.view == .week ? -((leading + day - 1) % 7) : 0
        return (0..<(period.view == .week ? 7 : 1)).map { index in
            CalendarNativeMonthGeometry.civilDate(
                year: Int(month.year), month: Int(month.month), day: day, offset: offset + index
            )
        }
    }

    static func days(for period: CalendarAdjacentPageID, locale: CalendarLocale) -> [Self] {
        let calendar = CalendarCivilMonth.calendar(locale)
        return dates(for: period, locale: locale).enumerated().map { index, value in
            let weekday: Int
            if period.view == .week {
                weekday = (calendar.firstWeekday - 1 + index) % 7
            } else {
                let month = CalendarViewportMonth(year: Int32(value.year), month: Int32(value.month))
                weekday = (CalendarNativeMonthGeometry.daysBeforeMonth(index: month.index) + value.day) % 7
            }
            return Self(date: value.string, number: value.day,
                        weekday: calendar.shortStandaloneWeekdaySymbols[weekday],
                        label: value.year < 1 ? value.string : CalendarSurfaceText.fullDate(value.string, locale: locale))
        }
    }

}

struct CalendarWeekCanvas: View {
    let days: [CalendarCivilDay]
    let week: CalendarWeekProjection?
    let selectedDate: String
    let todayDate: String
    let onSelectDate: (String) -> Void

    init(week: CalendarWeekProjection, onSelectDate: @escaping (String) -> Void) {
        self.init(days: week.days.enumerated().map { index, day in
            CalendarCivilDay(date: day.date, number: Int(day.dayOfMonth),
                             weekday: week.weekdayLabels[index].shortLabel, label: day.accessibilityLabel)
        }, week: week, selectedDate: week.days.first(where: \.isSelected)?.date ?? "",
           todayDate: week.days.first(where: \.isToday)?.date ?? "", onSelectDate: onSelectDate)
    }

    init(days: [CalendarCivilDay], week: CalendarWeekProjection?, selectedDate: String,
         todayDate: String, onSelectDate: @escaping (String) -> Void) {
        self.days = days
        self.week = week
        self.selectedDate = selectedDate
        self.todayDate = todayDate
        self.onSelectDate = onSelectDate
    }

    var body: some View {
        HStack(spacing: Space.xs) {
            ForEach(days, id: \.date) { day in
                let projected = week?.days.first { $0.date == day.date }
                let selected = day.date == selectedDate || (selectedDate.isEmpty && projected?.isSelected == true)
                Button { onSelectDate(day.date) } label: {
                    VStack(spacing: 5) {
                        Text(day.weekday)
                            .font(Typo.mono(TypeScale.xs))
                            .foregroundStyle(selected ? DuskColors.ink : DuskColors.ink3)
                        Text("\(day.number)")
                            .font(Typo.display(TypeScale.xl, .medium))
                            .foregroundStyle(DuskColors.ink)
                        Group {
                            if let projected {
                                CalendarIndicatorRow(events: projected.events, indicators: projected.indicators, overflow: projected.overflow)
                            } else {
                                Color.clear.frame(height: CalendarSurfaceLayout.indicatorRowHeight)
                            }
                        }
                        .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: CalendarSurfaceLayout.weekDayHeight)
                    .background(selected ? DuskColors.accent50.opacity(0.46) : .clear)
                    .contentShape(Rectangle())
                }
                .buttonStyle(CalendarPressButtonStyle())
                .accessibilityLabel(projected.map(CalendarSurfaceText.dateCellLabel) ??
                    (day.label + (day.date == todayDate ? ", Today" : "") + ", Event data not loaded"))
                .accessibilityValue(selected ? "Selected, week view remains active" : "Week view remains active")
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("calendar-date-\(day.date)")
            }
        }
        .padding(Space.sm)
        .designPlate()
    }
}

struct CalendarIndicatorRow: View {
    let events: [CalendarProjectedEvent]
    let indicators: [CalendarEventIndicator]
    let overflow: CalendarOverflow?

    private var visibleIndicators: [CalendarEventIndicator] { Array(indicators.prefix(2)) }
    private var hiddenCount: Int { Int(overflow?.count ?? 0) + max(0, indicators.count - visibleIndicators.count) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.xs) {
                ForEach(Array(visibleIndicators.enumerated()), id: \.offset) { _, indicator in
                    Circle()
                        .fill(indicatorColor(indicator))
                        .frame(width: CalendarSurfaceLayout.indicatorSize, height: CalendarSurfaceLayout.indicatorSize)
                        .accessibilityHidden(true)
                }
                if hiddenCount > 0 {
                    Text("+\(hiddenCount)")
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .accessibilityLabel("\(hiddenCount) additional events")
                        .accessibilityIdentifier("calendar-overflow")
                }
            }
            .fixedSize(horizontal: true, vertical: false)

            // A dense date remains one native target opening the complete Day
            // agenda. Prefer a count over colliding dots on very narrow cells.
            Text("\(events.count)")
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .accessibilityLabel("\(events.count) events")
                .accessibilityIdentifier(hiddenCount > 0 ? "calendar-overflow" : "")
        }
        .frame(minHeight: CalendarSurfaceLayout.indicatorRowHeight)
    }

    private func indicatorColor(_ indicator: CalendarEventIndicator) -> Color {
        if let event = events.first(where: { $0.actionIdentity.stableKey == indicator.actionIdentity.stableKey }) {
            return importanceColor(event.importance)
        }
        return indicator.kind == .allDay ? DuskColors.amber : DuskColors.sage
    }
}

private func importanceColor(_ importance: Importance) -> Color {
    switch importance {
    case .normal: DuskColors.sage
    case .important: DuskColors.amber
    case .pinned: DuskColors.accent
    }
}
