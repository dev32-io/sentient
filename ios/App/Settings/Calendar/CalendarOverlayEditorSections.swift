import SwiftUI
import MobileData

struct CalendarDraftFields: View {
    @Binding var draft: CalendarMutationDraft
    let titleFocused: FocusState<Bool>.Binding
    let onUpdate: (CalendarMutationDraft) -> Void

    @State private var title: String
    @State private var details: String
    @State private var group: String
    @State private var tags: String
    @State private var allDay: Bool
    @State private var startDate: Date
    @State private var endDate: Date
    @State private var hasEnd: Bool
    @State private var repeats: Bool
    @State private var frequency: RecurrenceFrequency
    @State private var interval: Int
    @State private var count: Int
    @State private var hasCount: Bool
    @State private var untilDate: Date
    @State private var hasUntil: Bool
    @State private var weekdays: Set<Weekday>

    private let zone: TimeZone

    init(
        draft: Binding<CalendarMutationDraft>,
        titleFocused: FocusState<Bool>.Binding,
        onUpdate: @escaping (CalendarMutationDraft) -> Void
    ) {
        _draft = draft
        self.titleFocused = titleFocused
        self.onUpdate = onUpdate
        let value = draft.wrappedValue
        let zone = CalendarOverlayDateCodec.timeZone(for: value)
        self.zone = zone
        let start = CalendarOverlayDateCodec.date(from: value.start, allDay: value.allDay, timeZone: zone) ?? Date()
        let end = value.end.flatMap {
            CalendarOverlayDateCodec.date(from: $0, allDay: value.allDay, timeZone: zone)
        } ?? start
        let recurrence = value.recurrence
        _title = State(initialValue: value.title)
        _details = State(initialValue: value.descriptionText)
        _group = State(initialValue: value.group ?? "")
        _tags = State(initialValue: value.tags.joined(separator: ", "))
        _allDay = State(initialValue: value.allDay)
        _startDate = State(initialValue: start)
        _endDate = State(initialValue: end)
        _hasEnd = State(initialValue: value.end != nil)
        _repeats = State(initialValue: recurrence != nil)
        _frequency = State(initialValue: recurrence?.frequency ?? .weekly)
        _interval = State(initialValue: Int(recurrence?.interval?.intValue ?? 1))
        _count = State(initialValue: Int(recurrence?.count?.intValue ?? 1))
        _hasCount = State(initialValue: recurrence?.count != nil)
        let untilValue = recurrence?.until.flatMap {
            CalendarOverlayDateCodec.date(from: $0, allDay: true, timeZone: zone)
        }
        _untilDate = State(initialValue: untilValue ?? start)
        _hasUntil = State(initialValue: recurrence?.until != nil)
        _weekdays = State(initialValue: Set(recurrence?.weekdays ?? []))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarDraftDetailsSection(
                title: $title,
                details: $details,
                allDay: $allDay,
                titleFocused: titleFocused,
                onChange: { emit() }
            )
            CalendarDraftScheduleSection(
                allDay: $allDay,
                startDate: $startDate,
                endDate: $endDate,
                hasEnd: $hasEnd,
                zone: zone,
                onChange: { emit() }
            )
            CalendarDraftClassificationSection(
                scope: scopeBinding,
                visibility: visibilityBinding,
                importance: importanceBinding,
                group: $group,
                tags: $tags,
                onChange: { emit() }
            )
            CalendarDraftRecurrenceSection(
                repeats: $repeats,
                frequency: $frequency,
                interval: $interval,
                count: $count,
                hasCount: $hasCount,
                untilDate: $untilDate,
                hasUntil: $hasUntil,
                weekdays: $weekdays,
                startDate: startDate,
                zone: zone,
                onChange: { emit() }
            )
        }
    }

    private var scopeBinding: Binding<CalendarScope> {
        Binding(get: { draft.scope }, set: { emit(scope: $0) })
    }

    private var visibilityBinding: Binding<MobileData.Visibility> {
        Binding(get: { draft.visibility }, set: { emit(visibility: $0) })
    }

    private var importanceBinding: Binding<Importance> {
        Binding(get: { draft.importance }, set: { emit(importance: $0) })
    }

    private func emit(
        scope: CalendarScope? = nil,
        visibility: MobileData.Visibility? = nil,
        importance: Importance? = nil
    ) {
        let recurrence = repeats
            ? StructuredRecurrence(
                frequency: frequency,
                interval: KotlinInt(int: Int32(interval)),
                weekdays: frequency == .weekly && !weekdays.isEmpty
                    ? Weekday.allCases.filter(weekdays.contains)
                    : nil,
                count: hasCount ? KotlinInt(int: Int32(count)) : nil,
                until: hasUntil
                    ? CalendarOverlayDateCodec.wireValue(
                        from: untilDate,
                        allDay: true,
                        timeZone: zone
                    )
                    : nil
            )
            : nil
        let updated = CalendarMutationDraft(
            title: title,
            description: details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : details,
            allDay: allDay,
            start: CalendarOverlayDateCodec.wireValue(
                from: startDate,
                allDay: allDay,
                timeZone: zone
            ),
            end: hasEnd
                ? CalendarOverlayDateCodec.wireValue(
                    from: max(endDate, startDate),
                    allDay: allDay,
                    timeZone: zone
                )
                : nil,
            scope: scope ?? draft.scope,
            visibility: visibility ?? draft.visibility,
            importance: importance ?? draft.importance,
            group: group.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : group,
            tags: tags
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty },
            recurrence: recurrence,
            eventId: draft.eventId,
            occurrenceId: draft.occurrenceId,
            originalStart: draft.originalStart,
            expectedRevision: draft.expectedRevision,
            inputTimeZoneId: draft.inputTimeZoneId,
            recurring: draft.recurring
        )
        draft = updated
        onUpdate(updated)
    }
}

struct CalendarDraftDetailsSection: View {
    @Binding var title: String
    @Binding var details: String
    @Binding var allDay: Bool
    let titleFocused: FocusState<Bool>.Binding
    let onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarLabeledField("Title") {
                CalendarTitleField(
                    text: $title,
                    focused: titleFocused,
                    accessibilityIdentifier: "calendar-editor-title",
                    onChange: onChange
                )
            }
            CalendarLabeledField("Description") {
                CalendarMultilineTextField(
                    prompt: "Add details",
                    text: $details,
                    accessibilityIdentifier: "calendar-editor-description",
                    onChange: onChange
                )
            }
            CalendarToggleField(
                label: "All-day",
                isOn: $allDay,
                accessibilityIdentifier: "calendar-editor-all-day",
                onChange: { _ in onChange() }
            )
        }
    }
}

struct CalendarDraftScheduleSection: View {
    @Binding var allDay: Bool
    @Binding var startDate: Date
    @Binding var endDate: Date
    @Binding var hasEnd: Bool
    let zone: TimeZone
    let onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarLabeledField("Starts") {
                CalendarDateField(
                    title: "Starts",
                    selection: $startDate,
                    displayedComponents: allDay ? [.date] : [.date, .hourAndMinute],
                    timeZone: zone,
                    accessibilityIdentifier: "calendar-editor-start",
                    onChange: onChange
                )
            }
            CalendarToggleField(label: "Set an end", isOn: $hasEnd) { enabled in
                if enabled && endDate <= startDate {
                    endDate = startDate.addingTimeInterval(allDay ? 86_400 : 3_600)
                }
                onChange()
            }
            if hasEnd {
                CalendarLabeledField("Ends") {
                    CalendarDateField(
                        title: "Ends",
                        selection: $endDate,
                        minimumDate: startDate,
                        displayedComponents: allDay ? [.date] : [.date, .hourAndMinute],
                        timeZone: zone,
                        accessibilityIdentifier: "calendar-editor-end",
                        onChange: onChange
                    )
                }
            }
            Text("Time zone: \(zone.localizedName(for: .generic, locale: .current) ?? zone.identifier)")
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
        }
    }
}

struct CalendarDraftClassificationSection: View {
    @Binding var scope: CalendarScope
    @Binding var visibility: MobileData.Visibility
    @Binding var importance: Importance
    @Binding var group: String
    @Binding var tags: String
    let onChange: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarLabeledField("Calendar") {
                CalendarSegmentedPicker("Calendar", selection: $scope) {
                    Text("Private").tag(CalendarScope.private)
                    Text("Household").tag(CalendarScope.household)
                }
            }
            CalendarLabeledField("Visibility") {
                CalendarSegmentedPicker("Visibility", selection: $visibility) {
                    ForEach(MobileData.Visibility.allCases, id: \.self) {
                        Text($0.calendarDisplayName).tag($0)
                    }
                }
            }
            CalendarLabeledField("Importance") {
                CalendarSegmentedPicker("Importance", selection: $importance) {
                    ForEach(Importance.allCases, id: \.self) {
                        Text($0.calendarDisplayName).tag($0)
                    }
                }
            }
            CalendarLabeledField("Group") {
                CalendarTextField(prompt: "Optional group", text: $group, onChange: onChange)
            }
            CalendarLabeledField("Tags") {
                CalendarTextField(
                    prompt: "Comma-separated tags",
                    text: $tags,
                    autocapitalization: .never,
                    onChange: onChange
                )
            }
        }
    }
}
