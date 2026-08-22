import MobileData
import SwiftUI

struct CalendarCanvasView: View {
    let state: CalendarUiState
    let onSelectDate: (String) -> Void
    let onSelectMonth: (Int32, Int32) -> Void

    var body: some View {
        Group {
            switch state.view {
            case .day:
                EmptyView()
            case .week:
                if let week = state.week {
                    CalendarWeekCanvas(week: week, onSelectDate: onSelectDate)
                }
            case .month:
                if let month = state.month {
                    CalendarMonthCanvas(month: month, onSelectDate: onSelectDate)
                }
            case .year:
                if let year = state.year {
                    CalendarYearCanvas(year: year, onSelectMonth: onSelectMonth)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .background(DuskColors.bgSunk)
        .clipShape(RoundedRectangle(cornerRadius: Radii.lg))
        .overlay(RoundedRectangle(cornerRadius: Radii.lg).stroke(DuskColors.lineSoft))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(state.view.displayName) calendar")
    }
}

struct CalendarWeekCanvas: View {
    let week: CalendarWeekProjection
    let onSelectDate: (String) -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            ForEach(Array(week.days.enumerated()), id: \.element.date) { index, day in
                Button { onSelectDate(day.date) } label: {
                    VStack(spacing: 5) {
                        Text(week.weekdayLabels[index].shortLabel)
                            .font(CalendarFont.mono(TypeScale.xs))
                            .foregroundStyle(day.isSelected ? DuskColors.ink : DuskColors.ink3)
                        Text("\(day.dayOfMonth)")
                            .font(CalendarFont.display(TypeScale.xl, .medium))
                            .foregroundStyle(DuskColors.ink)
                        CalendarIndicatorRow(indicators: day.indicators, overflow: day.overflow)
                    }
                    .frame(maxWidth: .infinity, minHeight: 70)
                    .background(day.isSelected ? DuskColors.paper : .clear, in: RoundedRectangle(cornerRadius: Radii.md))
                    .contentShape(Rectangle())
                }
                .buttonStyle(CalendarPressButtonStyle())
                .accessibilityLabel(CalendarSurfaceText.dateCellLabel(day))
                .accessibilityValue(day.isSelected ? "Selected, week view remains active" : "Week view remains active")
                .accessibilityAddTraits(day.isSelected ? .isSelected : [])
                .accessibilityIdentifier("calendar-date-\(day.date)")
            }
        }
        .padding(Space.sm)
    }
}

struct CalendarMonthCanvas: View {
    let month: CalendarMonthProjection
    let onSelectDate: (String) -> Void
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 7)

    var body: some View {
        VStack(spacing: 0) {
            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(month.weekdayLabels, id: \.weekday) { label in
                    Text(label.shortLabel)
                        .font(CalendarFont.mono(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .accessibilityLabel(label.accessibilityLabel)
                }
            }
            Divider().overlay(DuskColors.lineSoft)
            LazyVGrid(columns: columns, spacing: 0) {
                ForEach(month.cells, id: \.date) { cell in
                    Button { onSelectDate(cell.date) } label: {
                        VStack(spacing: Space.xs) {
                            Text("\(cell.dayOfMonth)")
                                .font(CalendarFont.mono(TypeScale.xs))
                                .foregroundStyle(cell.isOutsideMonth ? DuskColors.ink4 : DuskColors.ink2)
                                .frame(width: 25, height: 25)
                                .background(cell.isSelected ? DuskColors.paper : .clear, in: Circle())
                                .overlay(Circle().stroke(cell.isToday ? DuskColors.ink : .clear))
                            CalendarIndicatorRow(indicators: cell.indicators, overflow: cell.overflow)
                        }
                        .frame(maxWidth: .infinity, minHeight: 53, alignment: .top)
                        .padding(.top, Space.xs)
                        .background(cell.isOutsideMonth ? DuskColors.bg.opacity(0.7) : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(CalendarPressButtonStyle())
                    .overlay(alignment: .topLeading) {
                        Rectangle().fill(DuskColors.lineSoft).frame(width: 0.5)
                    }
                    .overlay(alignment: .top) {
                        Rectangle().fill(DuskColors.lineSoft).frame(height: 0.5)
                    }
                    .accessibilityLabel(CalendarSurfaceText.dateCellLabel(cell))
                    .accessibilityHint("Opens day view")
                    .accessibilityAddTraits(cell.isSelected ? .isSelected : [])
                    .accessibilityIdentifier("calendar-date-\(cell.date)")
                }
            }
        }
        .accessibilityIdentifier("calendar-month-42-cells")
    }
}

struct CalendarYearCanvas: View {
    let year: CalendarYearProjection
    let onSelectMonth: (Int32, Int32) -> Void
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 0), count: 3)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 1) {
            ForEach(year.months, id: \.month) { month in
                Button { onSelectMonth(month.year, month.month) } label: {
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Text(monthName(month.month))
                            .font(CalendarFont.display(TypeScale.sm, .medium))
                            .foregroundStyle(DuskColors.ink)
                        CalendarYearDays(days: month.days)
                    }
                    .padding(Space.sm)
                    .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
                    .background(DuskColors.bgSunk)
                    .contentShape(Rectangle())
                }
                .buttonStyle(CalendarPressButtonStyle())
                .accessibilityLabel(month.accessibilityLabel)
                .accessibilityValue("\(month.days.count) complete dates, \(month.eventDayCount) event days")
                .accessibilityHint("Opens month view")
                .accessibilityIdentifier("calendar-year-month-\(month.month)")
            }
        }
        .background(DuskColors.lineSoft)
    }

    private func monthName(_ month: Int32) -> String {
        let symbols = Calendar.current.shortMonthSymbols
        let index = Int(month) - 1
        return symbols.indices.contains(index) ? symbols[index] : "\(month)"
    }
}

private struct CalendarYearDays: View {
    let days: [CalendarDateCell]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

    var body: some View {
        LazyVGrid(columns: columns, spacing: 2) {
            ForEach(days, id: \.date) { day in
                Circle()
                    .fill(day.hasEvents ? DuskColors.sage : DuskColors.ink3.opacity(0.12))
                    .aspectRatio(1, contentMode: .fit)
                    .accessibilityHidden(true)
            }
        }
    }
}

private struct CalendarIndicatorRow: View {
    let indicators: [CalendarEventIndicator]
    let overflow: CalendarOverflow?

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(indicators.prefix(3).enumerated()), id: \.offset) { _, indicator in
                Circle()
                    .fill(indicatorColor(indicator))
                    .frame(width: 5, height: 5)
                    .accessibilityHidden(true)
            }
            if let overflow {
                Text("+\(overflow.count)")
                    .font(CalendarFont.mono(8))
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityLabel(overflow.accessibilityLabel)
                    .accessibilityIdentifier("calendar-overflow")
            }
        }
        .frame(minHeight: 8)
    }

    private func indicatorColor(_ indicator: CalendarEventIndicator) -> Color {
        indicator.kind == .allDay ? DuskColors.amber : DuskColors.sage
    }
}
