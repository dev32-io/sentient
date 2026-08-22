import SwiftUI
import MobileData

/// Integration wrapper that removes covered content from accessibility and hit
/// testing while keeping the controlled host independent of CalendarScreen.
struct CalendarOverlayContainer<Content: View>: View {
    let state: CalendarUiState
    let origin: CalendarOverlayOrigin
    let actions: CalendarOverlayActions
    @ViewBuilder let content: () -> Content

    var body: some View {
        let overlayOpen = CalendarOverlaySemantics.isOpen(state)
        ZStack {
            content()
                .allowsHitTesting(!overlayOpen)
                .accessibilityHidden(overlayOpen)
            CalendarOverlayHost(state: state, origin: origin, actions: actions)
        }
    }
}

/// Controlled overlay stack for CalendarScreen integration. It renders shared
/// mutation state and forwards every user action through the supplied closures.
struct CalendarOverlayHost: View {
    let state: CalendarUiState
    let origin: CalendarOverlayOrigin
    let actions: CalendarOverlayActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            if let outcome = state.outcome {
                CalendarOutcomeSheet(outcome: outcome, onClose: actions.acknowledgeOutcome)
                    .transition(sheetTransition)
            } else if let conflict = state.conflict {
                CalendarConflictSheet(
                    conflict: conflict,
                    error: state.mutation.error,
                    onReread: actions.rereadConflict,
                    onReview: actions.reviewConflict,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let confirmation = state.deleteConfirmation {
                CalendarDeleteSheet(
                    confirmation: confirmation,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onChooseScope: actions.chooseScope,
                    onDelete: actions.confirmDelete,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let editor = state.editor {
                CalendarEditorSheet(
                    editor: editor,
                    canSave: CalendarOverlaySemantics.canSave(state, draft: editor.draft) &&
                        (editor.applicableScopes.count == 1 || editor.selectedScope != nil),
                    canDelete: state.mutationAvailability.canDelete,
                    isOffline: state.isOffline,
                    isSubmitting: state.mutation.isSubmitting,
                    error: state.mutation.error,
                    onUpdate: actions.updateDraft,
                    onChooseScope: actions.chooseScope,
                    onSave: actions.save,
                    onDelete: actions.requestDelete,
                    onCancel: actions.close
                )
                .transition(sheetTransition)
            } else if let preview = state.preview {
                CalendarPreviewSheet(
                    occurrence: preview,
                    canEdit: state.mutationAvailability.canEdit,
                    isOffline: state.isOffline,
                    onEdit: { actions.edit(preview) },
                    onClose: actions.close
                )
                .transition(sheetTransition)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: Motion.normal), value: state.mutation.phase)
        .onChange(of: CalendarOverlaySemantics.isOpen(state)) { oldValue, newValue in
            if oldValue && !newValue { actions.restoreFocus(origin) }
        }
    }

    private var sheetTransition: AnyTransition {
        reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity)
    }
}

private struct CalendarSheet<Content: View>: View {
    let dismissOnScrim: Bool
    let onDismiss: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @GestureState private var dragOffset: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                DuskColors.bg.opacity(0.62)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { if dismissOnScrim { onDismiss() } }
                    .accessibilityHidden(true)

                ScrollView {
                    VStack(alignment: .leading, spacing: Space.lg) {
                        Capsule()
                            .fill(DuskColors.line)
                            .frame(width: CalendarOverlaySemantics.handleSize.width,
                                   height: CalendarOverlaySemantics.handleSize.height)
                            .frame(maxWidth: .infinity)
                            .accessibilityHidden(true)
                        content()
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.md)
                    .padding(.bottom, max(Space.xl, proxy.safeAreaInsets.bottom + Space.md))
                }
                .scrollDismissesKeyboard(.interactively)
                .frame(maxWidth: .infinity,
                       maxHeight: proxy.size.height * CalendarOverlaySemantics.maximumHeightFraction)
                .background(DuskColors.paper)
                .clipShape(.rect(topLeadingRadius: CalendarOverlaySemantics.topRadius,
                                 topTrailingRadius: CalendarOverlaySemantics.topRadius))
                .overlay(alignment: .top) {
                    UnevenRoundedRectangle(topLeadingRadius: CalendarOverlaySemantics.topRadius,
                                           topTrailingRadius: CalendarOverlaySemantics.topRadius)
                        .stroke(DuskColors.lineSoft, lineWidth: 1)
                        .allowsHitTesting(false)
                }
                .shadow(color: DuskColors.bg.opacity(0.74), radius: 35, y: -11)
                .offset(y: dismissOnScrim ? max(0, dragOffset) : 0)
                .gesture(dismissOnScrim ? dismissGesture : nil)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape, onDismiss)
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: dismissOnScrim)
    }

    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragOffset) { value, offset, _ in offset = max(0, value.translation.height) }
            .onEnded { value in
                if value.translation.height > 90 || value.predictedEndTranslation.height > 160 { onDismiss() }
            }
    }
}

struct CalendarPreviewSheet: View {
    let occurrence: EffectiveOccurrence
    let canEdit: Bool
    let isOffline: Bool
    let onEdit: () -> Void
    let onClose: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: true, onDismiss: onClose) {
            CalendarSheetHeader(kicker: "EVENT PREVIEW", title: occurrence.title, onClose: onClose)
                .accessibilityFocused($headingFocused)
            Text(CalendarOverlayDateCodec.displayRange(start: occurrence.start, end: occurrence.end))
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
            if let description = occurrence.description_, !description.isEmpty {
                Text(description)
                    .font(Typo.ui(TypeScale.base))
                    .foregroundStyle(DuskColors.ink2)
            }
            CalendarMetadata(rows: previewRows)
            if isOffline {
                CalendarStatusNotice(kind: .offline, message: "Connect to edit this event.")
            }
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Close", action: onClose)
                CalendarPrimaryButton(title: "Edit", disabled: !canEdit || isOffline, action: onEdit)
            }
        }
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-preview-sheet")
    }

    private var previewRows: [(String, String)] {
        var rows = [
            ("Calendar", occurrence.scope.calendarDisplayName),
            ("Visibility", occurrence.visibility.calendarDisplayName),
            ("Importance", occurrence.importance.calendarDisplayName)
        ]
        if let group = occurrence.group, !group.isEmpty { rows.append(("Group", group)) }
        if !occurrence.tags.isEmpty { rows.append(("Tags", occurrence.tags.joined(separator: ", "))) }
        if let recurrence = CalendarOverlaySemantics.recurrenceSummary(occurrence.recurrence) {
            rows.append(("Repeats", recurrence))
        }
        return rows
    }
}

struct CalendarEditorSheet: View {
    let editor: CalendarMutationEditorState
    let canSave: Bool
    let canDelete: Bool
    let isOffline: Bool
    let isSubmitting: Bool
    let error: CalendarMutationError?
    let onUpdate: (CalendarMutationDraft) -> Void
    let onChooseScope: (CalendarMutationScope) -> Void
    let onSave: (CalendarMutationDraft) -> Void
    let onDelete: () -> Void
    let onCancel: () -> Void

    @State private var draft: CalendarMutationDraft
    @FocusState private var titleFocused: Bool

    init(editor: CalendarMutationEditorState, canSave: Bool, canDelete: Bool, isOffline: Bool,
         isSubmitting: Bool, error: CalendarMutationError?,
         onUpdate: @escaping (CalendarMutationDraft) -> Void,
         onChooseScope: @escaping (CalendarMutationScope) -> Void,
         onSave: @escaping (CalendarMutationDraft) -> Void,
         onDelete: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.editor = editor
        self.canSave = canSave
        self.canDelete = canDelete
        self.isOffline = isOffline
        self.isSubmitting = isSubmitting
        self.error = error
        self.onUpdate = onUpdate
        self.onChooseScope = onChooseScope
        self.onSave = onSave
        self.onDelete = onDelete
        self.onCancel = onCancel
        _draft = State(initialValue: editor.draft)
    }

    var body: some View {
        CalendarSheet(dismissOnScrim: !isSubmitting, onDismiss: onCancel) {
            CalendarSheetHeader(
                kicker: editor.isCreate ? "NEW EVENT" : "EDIT EVENT",
                title: editor.isCreate ? "Add event" : "Edit event",
                onClose: onCancel
            )
            CalendarDraftFields(draft: $draft, titleFocused: $titleFocused, onUpdate: onUpdate)
            if editor.applicableScopes.count > 1 {
                CalendarScopeChoices(scopes: editor.applicableScopes, selected: editor.selectedScope,
                                     onChoose: onChooseScope)
            }
            if isOffline {
                CalendarStatusNotice(kind: .offline,
                    message: "Connection required. Your draft stays open, but it can’t be saved offline.")
            }
            if let error {
                CalendarStatusNotice(kind: error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(error))
                    .accessibilityLabel(CalendarOverlaySemantics.errorAccessibilityLabel(error))
                    .accessibilityIdentifier("calendar-editor-error")
            }
            if editor.isEdit && canDelete {
                Button("Delete event", role: .destructive, action: onDelete)
                    .font(Typo.ui(TypeScale.base, .semibold))
                    .foregroundStyle(DuskColors.stop)
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(isOffline || isSubmitting)
                    .accessibilityHint(isOffline ? "Connection required" : "")
                    .accessibilityIdentifier("calendar-editor-delete")
            }
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Cancel", disabled: isSubmitting, action: onCancel)
                CalendarPrimaryButton(title: isSubmitting ? "Saving…" : "Save",
                                      disabled: !canSave || isOffline || isSubmitting) { onSave(draft) }
                    .accessibilityIdentifier("calendar-editor-save")
            }
        }
        .interactiveDismissDisabled(isSubmitting)
        .onAppear { titleFocused = true }
        .accessibilityIdentifier("calendar-editor-sheet")
    }
}

private struct CalendarDraftFields: View {
    @Binding var draft: CalendarMutationDraft
    var titleFocused: FocusState<Bool>.Binding
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

    init(draft: Binding<CalendarMutationDraft>, titleFocused: FocusState<Bool>.Binding,
         onUpdate: @escaping (CalendarMutationDraft) -> Void) {
        _draft = draft
        self.titleFocused = titleFocused
        self.onUpdate = onUpdate
        let value = draft.wrappedValue
        let zone = CalendarOverlayDateCodec.timeZone(for: value)
        self.zone = zone
        let start = CalendarOverlayDateCodec.date(from: value.start, allDay: value.allDay, timeZone: zone) ?? Date()
        let end = value.end.flatMap { CalendarOverlayDateCodec.date(from: $0, allDay: value.allDay, timeZone: zone) } ?? start
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
        let untilValue = recurrence?.until.flatMap { CalendarOverlayDateCodec.date(from: $0, allDay: true, timeZone: zone) }
        _untilDate = State(initialValue: untilValue ?? start)
        _hasUntil = State(initialValue: recurrence?.until != nil)
        _weekdays = State(initialValue: Set(recurrence?.weekdays ?? []))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            CalendarLabeledField("Title") {
                TextField("Event title", text: $title)
                    .focused(titleFocused)
                    .submitLabel(.next)
                    .onChange(of: title) { _, _ in emit() }
                    .calendarInput()
                    .accessibilityIdentifier("calendar-editor-title")
            }
            CalendarLabeledField("Description") {
                TextField("Add details", text: $details, axis: .vertical)
                    .lineLimit(3...7)
                    .onChange(of: details) { _, _ in emit() }
                    .calendarInput()
                    .accessibilityIdentifier("calendar-editor-description")
            }
            Toggle("All-day", isOn: $allDay)
                .tint(DuskColors.accent)
                .onChange(of: allDay) { _, _ in emit() }
            CalendarLabeledField("Starts") {
                DatePicker("Starts", selection: $startDate,
                           displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                    .labelsHidden()
                    .environment(\.timeZone, zone)
                    .onChange(of: startDate) { _, _ in emit() }
                    .accessibilityIdentifier("calendar-editor-start")
            }
            Toggle("Set an end", isOn: $hasEnd)
                .tint(DuskColors.accent)
                .onChange(of: hasEnd) { _, enabled in
                    if enabled && endDate <= startDate {
                        endDate = startDate.addingTimeInterval(allDay ? 86_400 : 3_600)
                    }
                    emit()
                }
            if hasEnd {
                CalendarLabeledField("Ends") {
                    DatePicker("Ends", selection: $endDate,
                               in: startDate...,
                               displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                        .labelsHidden()
                        .environment(\.timeZone, zone)
                        .onChange(of: endDate) { _, _ in emit() }
                        .accessibilityIdentifier("calendar-editor-end")
                }
            }
            Text("Time zone: \(zone.localizedName(for: .generic, locale: .current) ?? zone.identifier)")
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(DuskColors.ink3)
            CalendarLabeledField("Calendar") {
                Picker("Calendar", selection: fieldBinding(\.scope)) {
                    Text("Private").tag(CalendarScope.private)
                    Text("Household").tag(CalendarScope.household)
                }.pickerStyle(.segmented)
            }
            CalendarLabeledField("Visibility") {
                Picker("Visibility", selection: fieldBinding(\.visibility)) {
                    ForEach(MobileData.Visibility.allCases, id: \.self) { Text($0.calendarDisplayName).tag($0) }
                }.pickerStyle(.segmented)
            }
            CalendarLabeledField("Importance") {
                Picker("Importance", selection: fieldBinding(\.importance)) {
                    ForEach(Importance.allCases, id: \.self) { Text($0.calendarDisplayName).tag($0) }
                }.pickerStyle(.segmented)
            }
            CalendarLabeledField("Group") {
                TextField("Optional group", text: $group)
                    .onChange(of: group) { _, _ in emit() }.calendarInput()
            }
            CalendarLabeledField("Tags") {
                TextField("Comma-separated tags", text: $tags)
                    .textInputAutocapitalization(.never)
                    .onChange(of: tags) { _, _ in emit() }.calendarInput()
            }
            recurrenceFields
        }
    }

    @ViewBuilder private var recurrenceFields: some View {
        Toggle("Repeats", isOn: $repeats)
            .tint(DuskColors.accent)
            .onChange(of: repeats) { _, enabled in
                if enabled {
                    if !hasCount && !hasUntil { hasCount = true }
                    ensureWeeklyDay()
                }
                emit()
            }
        if repeats {
            CalendarLabeledField("Frequency") {
                Picker("Frequency", selection: $frequency) {
                    Text("Daily").tag(RecurrenceFrequency.daily)
                    Text("Weekly").tag(RecurrenceFrequency.weekly)
                    Text("Monthly").tag(RecurrenceFrequency.monthly)
                    Text("Yearly").tag(RecurrenceFrequency.yearly)
                }
                .pickerStyle(.segmented)
                .onChange(of: frequency) { _, _ in
                    ensureWeeklyDay()
                    emit()
                }
            }
            Stepper("Every \(interval) \(frequency.name.lowercased())", value: $interval, in: 1...99)
                .onChange(of: interval) { _, _ in emit() }
            if frequency == .weekly {
                CalendarWeekdayPicker(selection: $weekdays, onChange: { emit() })
            }
            Toggle("End after a number of events", isOn: $hasCount)
                .tint(DuskColors.accent).onChange(of: hasCount) { _, enabled in
                    if enabled { hasUntil = false }
                    emit()
                }
            if hasCount {
                Stepper("\(count) events", value: $count, in: 1...999)
                    .onChange(of: count) { _, _ in emit() }
            }
            Toggle("End on a date", isOn: $hasUntil)
                .tint(DuskColors.accent).onChange(of: hasUntil) { _, enabled in
                    if enabled { hasCount = false }
                    emit()
                }
            if hasUntil {
                DatePicker("Recurrence end date", selection: $untilDate, displayedComponents: .date)
                    .environment(\.timeZone, zone)
                    .onChange(of: untilDate) { _, _ in emit() }
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

    private func fieldBinding<T>(_ keyPath: KeyPath<CalendarMutationDraft, T>) -> Binding<T> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in
            if keyPath == \CalendarMutationDraft.scope { emit(scope: value as? CalendarScope) }
            else if keyPath == \CalendarMutationDraft.visibility { emit(visibility: value as? MobileData.Visibility) }
            else if keyPath == \CalendarMutationDraft.importance { emit(importance: value as? Importance) }
        })
    }

    private func emit(scope: CalendarScope? = nil, visibility: MobileData.Visibility? = nil, importance: Importance? = nil) {
        let recurrence = repeats ? StructuredRecurrence(
            frequency: frequency,
            interval: KotlinInt(int: Int32(interval)),
            weekdays: frequency == .weekly && !weekdays.isEmpty ? Weekday.allCases.filter(weekdays.contains) : nil,
            count: hasCount ? KotlinInt(int: Int32(count)) : nil,
            until: hasUntil ? CalendarOverlayDateCodec.wireValue(from: untilDate, allDay: true, timeZone: zone) : nil
        ) : nil
        let updated = CalendarMutationDraft(
            title: title,
            description: details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : details,
            allDay: allDay,
            start: CalendarOverlayDateCodec.wireValue(from: startDate, allDay: allDay, timeZone: zone),
            end: hasEnd ? CalendarOverlayDateCodec.wireValue(from: max(endDate, startDate), allDay: allDay, timeZone: zone) : nil,
            scope: scope ?? draft.scope,
            visibility: visibility ?? draft.visibility,
            importance: importance ?? draft.importance,
            group: group.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : group,
            tags: tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
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

private struct CalendarWeekdayPicker: View {
    @Binding var selection: Set<Weekday>
    let onChange: () -> Void

    var body: some View {
        CalendarLabeledField("Days") {
            HStack(spacing: Space.xs) {
                ForEach(Weekday.allCases, id: \.self) { day in
                    Button {
                        if selection.contains(day) { selection.remove(day) } else { selection.insert(day) }
                        onChange()
                    } label: {
                        Text(String(day.name.prefix(1)))
                            .font(Typo.mono(TypeScale.xs))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(selection.contains(day) ? DuskColors.accent50 : DuskColors.bgElev,
                                        in: RoundedRectangle(cornerRadius: Radii.sm))
                    }
                    .buttonStyle(CalendarOverlayPressButtonStyle())
                    .accessibilityLabel(day.name.capitalized)
                    .accessibilityValue(selection.contains(day) ? "Selected" : "Not selected")
                }
            }
        }
    }
}

private struct CalendarScopeChoices: View {
    let scopes: [CalendarMutationScope]
    let selected: CalendarMutationScope?
    let onChoose: (CalendarMutationScope) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Apply changes to")
                .font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink3)
            ForEach(scopes, id: \.self) { scope in
                Button { onChoose(scope) } label: {
                    HStack {
                        Image(systemName: selected == scope ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(selected == scope ? DuskColors.accent : DuskColors.ink3)
                        Text(CalendarOverlaySemantics.scopeLabel(scope))
                        Spacer()
                    }
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(CalendarOverlaySemantics.scopeAccessibilityLabel(scope, selected: selected == scope))
                .accessibilityIdentifier("calendar-scope-\(scope.name.lowercased())")
            }
        }
    }
}

struct CalendarDeleteSheet: View {
    let confirmation: CalendarDeleteConfirmationState
    let isOffline: Bool
    let isSubmitting: Bool
    let error: CalendarMutationError?
    let onChooseScope: (CalendarMutationScope) -> Void
    let onDelete: (CalendarMutationScope?) -> Void
    let onCancel: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            CalendarSheetHeader(kicker: "CONFIRM DELETE", title: "Delete event?", onClose: onCancel)
                .accessibilityFocused($headingFocused)
            Text("This action can’t be undone.")
                .font(Typo.ui(TypeScale.base)).foregroundStyle(DuskColors.ink2)
            if confirmation.applicableScopes.count > 1 {
                CalendarScopeChoices(scopes: confirmation.applicableScopes,
                                     selected: confirmation.selectedScope,
                                     onChoose: onChooseScope)
            }
            if isOffline {
                CalendarStatusNotice(kind: .offline, message: "Connect to delete this event.")
            }
            if let error {
                CalendarStatusNotice(kind: error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(error))
            }
            HStack(spacing: Space.sm) {
                CalendarSecondaryButton(title: "Cancel", disabled: isSubmitting, action: onCancel)
                CalendarDestructiveButton(title: isSubmitting ? "Deleting…" : "Delete",
                    disabled: isOffline || isSubmitting ||
                        (confirmation.applicableScopes.count > 1 && confirmation.selectedScope == nil)) {
                        onDelete(confirmation.selectedScope)
                    }
            }
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-delete-sheet")
    }
}

struct CalendarConflictSheet: View {
    let conflict: CalendarConflictReviewState
    let error: CalendarMutationError?
    let onReread: () -> Void
    let onReview: (CalendarMutationDraft) -> Void
    let onCancel: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            CalendarSheetHeader(kicker: "CALENDAR CHANGED", title: "Review the latest version", onClose: onCancel)
                .accessibilityFocused($headingFocused)
            Text("Someone changed this event after you opened it. Reread it, review your draft, then save again.")
                .font(Typo.ui(TypeScale.base)).foregroundStyle(DuskColors.ink2)
            if let error {
                CalendarStatusNotice(kind: .conflict, message: CalendarOverlaySemantics.errorMessage(error))
            }
            if conflict.authoritativeEvent == nil {
                CalendarPrimaryButton(title: conflict.rereadInFlight ? "Rereading…" : "Reread event",
                                      disabled: conflict.rereadInFlight, action: onReread)
            } else if !conflict.reviewed {
                CalendarPrimaryButton(title: "Review my changes", disabled: false) {
                    onReview(conflict.draft)
                }
            } else {
                CalendarStatusNotice(kind: .success, message: "Latest version reviewed. You can save again.")
            }
            CalendarSecondaryButton(title: "Cancel", action: onCancel)
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-conflict-sheet")
    }
}

struct CalendarOutcomeSheet: View {
    let outcome: any CalendarMutationOutcome
    let onClose: () -> Void

    @AccessibilityFocusState private var headingFocused: Bool

    var body: some View {
        CalendarSheet(dismissOnScrim: false, onDismiss: {}) {
            switch onEnum(of: outcome) {
            case .success(let success):
                CalendarSheetHeader(kicker: "COMPLETE", title: successTitle(success.operation), onClose: onClose)
                    .accessibilityFocused($headingFocused)
                CalendarStatusNotice(kind: .success, message: "The calendar is up to date.")
            case .failure(let failure):
                CalendarSheetHeader(kicker: "COULDN’T COMPLETE", title: "Calendar change failed", onClose: onClose)
                    .accessibilityFocused($headingFocused)
                CalendarStatusNotice(kind: failure.error.isPermission ? .permission : .error,
                                     message: CalendarOverlaySemantics.errorMessage(failure.error))
                    .accessibilityLabel(CalendarOverlaySemantics.errorAccessibilityLabel(failure.error))
            }
            CalendarPrimaryButton(title: "Done", disabled: false, action: onClose)
        }
        .interactiveDismissDisabled(true)
        .onAppear { headingFocused = true }
        .accessibilityIdentifier("calendar-outcome-sheet")
    }

    private func successTitle(_ operation: CalendarMutationOperation) -> String {
        switch operation {
        case .create: "Event added"
        case .update: "Event updated"
        case .delete: "Event deleted"
        }
    }
}

private struct CalendarSheetHeader: View {
    let kicker: String
    let title: String
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(kicker)
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
                    .tracking(1)
                Text(title)
                    .font(Typo.display(29, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.sm)
            Button(action: onClose) {
                Image(systemName: "xmark").frame(width: 44, height: 44)
            }
            .buttonStyle(CalendarOverlayPressButtonStyle())
            .accessibilityLabel("Close")
            .accessibilityIdentifier("calendar-overlay-close")
        }
    }
}

private struct CalendarMetadata: View {
    let rows: [(String, String)]

    var body: some View {
        VStack(spacing: Space.md) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: Space.md) {
                    Text(row.0).foregroundStyle(DuskColors.ink3).frame(width: 82, alignment: .leading)
                    Text(row.1).foregroundStyle(DuskColors.ink2).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(Typo.ui(TypeScale.sm))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(row.0), \(row.1)")
            }
        }
        .padding(.vertical, Space.lg)
        .overlay(alignment: .top) { Divider().overlay(DuskColors.lineSoft) }
        .overlay(alignment: .bottom) { Divider().overlay(DuskColors.lineSoft) }
    }
}

private enum CalendarNoticeKind { case offline, permission, conflict, error, success }

private struct CalendarStatusNotice: View {
    let kind: CalendarNoticeKind
    let message: String

    var body: some View {
        Label(message, systemImage: icon)
            .font(Typo.ui(TypeScale.sm, .medium))
            .foregroundStyle(color)
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: Radii.md))
            .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch kind {
        case .offline: "wifi.slash"
        case .permission: "lock.fill"
        case .conflict: "arrow.triangle.2.circlepath"
        case .error: "exclamationmark.triangle.fill"
        case .success: "checkmark.circle.fill"
        }
    }
    private var color: Color {
        switch kind {
        case .offline, .conflict: DuskColors.warn
        case .permission, .error: DuskColors.stop
        case .success: DuskColors.ok
        }
    }
}

private struct CalendarLabeledField<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title; self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink3)
            content()
        }
    }
}

private extension View {
    func calendarInput() -> some View {
        font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .padding(.horizontal, Space.md)
            .frame(minHeight: 48)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
    }
}

private struct CalendarPrimaryButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(title, action: action)
            .buttonStyle(CalendarActionButtonStyle(fill: DuskColors.accent, foreground: DuskColors.bg))
            .disabled(disabled)
    }
}
private struct CalendarSecondaryButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(title, action: action)
            .buttonStyle(CalendarActionButtonStyle(fill: .clear, foreground: DuskColors.ink))
            .disabled(disabled)
    }
}
private struct CalendarDestructiveButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(title, role: .destructive, action: action)
            .buttonStyle(CalendarActionButtonStyle(fill: DuskColors.stop, foreground: DuskColors.ink))
            .disabled(disabled)
    }
}

private struct CalendarActionButtonStyle: ButtonStyle {
    let fill: Color
    let foreground: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity, minHeight: CalendarOverlaySemantics.actionHeight)
            .background(fill, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft))
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}

private struct CalendarOverlayPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: Motion.fast), value: configuration.isPressed)
    }
}

private extension CalendarOverlayDateCodec {
    static func displayRange(start: String, end: String?) -> String {
        if let end, !end.isEmpty { return "\(start) – \(end)" }
        return start
    }
}
