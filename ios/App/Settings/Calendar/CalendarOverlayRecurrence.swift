import SwiftUI
import MobileData

struct CalendarDraftRecurrenceSection: View {
    @Binding var repeats: Bool
    @Binding var frequency: RecurrenceFrequency
    @Binding var interval: Int
    @Binding var count: Int
    @Binding var hasCount: Bool
    @Binding var untilDate: Date
    @Binding var hasUntil: Bool
    @Binding var weekdays: Set<Weekday>
    let startDate: Date
    let zone: TimeZone
    let onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarToggleField(
                label: "Repeats",
                isOn: $repeats,
                accessibilityIdentifier: "calendar-editor-recurrence"
            ) { enabled in
                if enabled {
                    if !hasCount && !hasUntil { hasCount = true }
                    ensureWeeklyDay()
                }
                onChange()
            }

            if repeats {
                CalendarLabeledField("Frequency") {
                    CalendarSegmentedPicker("Frequency", selection: $frequency) {
                        Text("Daily").tag(RecurrenceFrequency.daily)
                        Text("Weekly").tag(RecurrenceFrequency.weekly)
                        Text("Monthly").tag(RecurrenceFrequency.monthly)
                        Text("Yearly").tag(RecurrenceFrequency.yearly)
                    }
                    .onChange(of: frequency) { _, _ in
                        ensureWeeklyDay()
                        onChange()
                    }
                }
                CalendarStepperField(
                    label: "Every \(interval) \(frequency.name.lowercased())",
                    value: $interval,
                    range: 1...99,
                    onChange: onChange
                )
                if frequency == .weekly {
                    CalendarWeekdayPicker(selection: $weekdays, onChange: onChange)
                }
                CalendarToggleField(label: "End after a number of events", isOn: $hasCount) { enabled in
                    if enabled { hasUntil = false }
                    onChange()
                }
                if hasCount {
                    CalendarStepperField(
                        label: "\(count) events",
                        value: $count,
                        range: 1...999,
                        onChange: onChange
                    )
                }
                CalendarToggleField(label: "End on a date", isOn: $hasUntil) { enabled in
                    if enabled { hasCount = false }
                    onChange()
                }
                if hasUntil {
                    CalendarDateField(
                        title: "Recurrence end date",
                        selection: $untilDate,
                        displayedComponents: [.date],
                        timeZone: zone,
                        labelsHidden: false,
                        accessibilityIdentifier: "calendar-editor-recurrence-until",
                        onChange: onChange
                    )
                }
            }
        }
    }

    private func ensureWeeklyDay() {
        guard frequency == .weekly, weekdays.isEmpty else { return }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let day: Weekday = switch calendar.component(.weekday, from: startDate) {
        case 1: .sunday
        case 2: .monday
        case 3: .tuesday
        case 4: .wednesday
        case 5: .thursday
        case 6: .friday
        default: .saturday
        }
        weekdays.insert(day)
    }
}

struct CalendarWeekdayPicker: View {
    @Binding var selection: Set<Weekday>
    let onChange: () -> Void

    var body: some View {
        CalendarLabeledField("Days") {
            HStack(spacing: Space.xs) {
                ForEach(Weekday.allCases, id: \.self) { day in
                    Button {
                        if selection.contains(day) {
                            selection.remove(day)
                        } else {
                            selection.insert(day)
                        }
                        onChange()
                    } label: {
                        Text(String(day.name.prefix(1)))
                            .font(Typo.mono(TypeScale.xs))
                            .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                            .background(
                                selection.contains(day) ? DuskColors.accent50 : DuskColors.bgElev,
                                in: RoundedRectangle(cornerRadius: Radii.sm)
                            )
                    }
                    .buttonStyle(CalendarOverlayPressButtonStyle())
                    .accessibilityLabel(day.name.capitalized)
                    .accessibilityValue(selection.contains(day) ? "Selected" : "Not selected")
                }
            }
        }
    }
}

struct CalendarScopeChoices: View {
    let scopes: [CalendarMutationScope]
    let selected: CalendarMutationScope?
    let onChoose: (CalendarMutationScope) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Apply changes to")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink3)
            ForEach(scopes, id: \.self) { scope in
                Button { onChoose(scope) } label: {
                    HStack {
                        Image(systemName: selected == scope ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(selected == scope ? DuskColors.accent : DuskColors.ink3)
                        Text(CalendarOverlaySemantics.scopeLabel(scope))
                        Spacer()
                    }
                    .frame(minHeight: DesignMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CalendarOverlaySemantics.scopeAccessibilityLabel(scope, selected: selected == scope))
                .accessibilityIdentifier("calendar-scope-\(scope.name.lowercased())")
            }
        }
    }
}
