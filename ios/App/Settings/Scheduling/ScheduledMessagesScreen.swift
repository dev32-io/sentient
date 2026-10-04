import MobileData
import SwiftUI

struct ScheduledMessagesScreen: View {
    @State private var vm: ScheduledMessagesViewModel
    @State private var editing: Schedule?
    @State private var draft = ScheduleDraft()
    let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: ScheduledMessagesViewModel(useCases: settings.schedules))
        self.onBack = onBack
    }

    var body: some View {
        DesignPageChrome(title: "Scheduled messages", accessibilityId: "scheduled-messages-screen", onBack: onBack) {
            if let error = vm.mutationError {
                AsyncNotice(kind: .error, title: "Change not saved", detail: error)
            } else if vm.isMutating {
                AsyncNotice(kind: .loading, title: "Saving schedule")
            }
            DesignActionButton(title: "Schedule a message", accessibilityId: "schedule-add", action: beginNew)
            scheduleContent
        }
        .sheet(isPresented: Binding(get: { editing != nil || presentingNew }, set: { if !$0 && !vm.isMutating { editing = nil; presentingNew = false } })) {
            ScheduleEditor(
                draft: $draft,
                isSaving: vm.isMutating,
                saveError: vm.mutationError,
                onCancel: { guard !vm.isMutating else { return }; editing = nil; presentingNew = false }
            ) {
                let saved: Bool
                if let editing { saved = await vm.update(editing, draft: draft) }
                else { saved = await vm.create(draft) }
                if saved { editing = nil; presentingNew = false }
            }
        }
        .task { vm.start() }
    }

    @State private var presentingNew = false

    @ViewBuilder private var scheduleContent: some View {
        switch vm.scheduleState {
        case .loading where vm.schedules.isEmpty: AsyncNotice(kind: .loading, title: "Loading schedules")
        case .failed(let message) where vm.schedules.isEmpty:
            AsyncNotice(kind: .error, title: "Schedules unavailable", detail: message, retry: { Task { await vm.reload() } }, actionTitle: "Try again")
        default:
            if case .failed(let message) = vm.scheduleState {
                AsyncNotice(kind: .error, title: "Schedules may be out of date", detail: message,
                            retry: { Task { await vm.reload() } }, actionTitle: "Reload")
            } else if case .loading = vm.scheduleState, !vm.schedules.isEmpty {
                AsyncNotice(kind: .loading, title: "Refreshing schedules")
            }
            if vm.schedules.isEmpty { AsyncNotice(kind: .empty, title: "No scheduled messages", detail: "Create a one-time or recurring message.") }
            LazyVStack(spacing: Space.lg) {
                ForEach(vm.schedules, id: \.scheduleId) { schedule in
                    ScheduleSummaryCard(schedule: schedule, disabled: vm.isMutating, onEdit: {
                        editing = schedule; draft = ScheduleDraft(schedule: schedule)
                    }, onToggle: { Task { await vm.toggle(schedule) } }, onDelete: { Task { await vm.delete(schedule) } })
                }
            }
        }
    }
}

private extension ScheduledMessagesScreen {
    // Separate action avoids presenting a sentinel Schedule object.
    func beginNew() { presentingNew = true; editing = nil; draft = ScheduleDraft() }
}

struct ScheduleSummaryCard: View {
    let schedule: Schedule
    let disabled: Bool
    let onEdit: () -> Void
    let onToggle: () -> Void
    let onDelete: () -> Void

    var body: some View {
        DesignCard(title: schedule.message, detail: ScheduleDisplay.summary(schedule), bodyStyle: .padded) {
            DesignSettingsRow(title: "Status") { DesignStatusBadge(title: schedule.enabled ? "Active" : "Paused", tint: schedule.enabled ? DuskColors.sage : DuskColors.ink3) }
            DesignActionButton(title: "Edit", role: .secondary, state: disabled ? .disabled : .normal, action: onEdit)
            DesignActionButton(title: schedule.enabled ? "Pause" : "Resume", role: .quiet, state: disabled ? .disabled : .normal, action: onToggle)
            DesignActionButton(title: "Delete", role: .destructive, state: disabled ? .disabled : .normal, action: onDelete)
        }
        .accessibilityIdentifier("schedule-\(schedule.scheduleId)")
    }
}

struct ScheduleEditor: View {
    @Binding var draft: ScheduleDraft
    let isSaving: Bool
    let saveError: String?
    let onCancel: () -> Void
    let onSave: () async -> Void
    @State private var delay = "30"
    @State private var day = "1"
    @State private var recurringTime = "09:00"
    @State private var submitting = false
    @State private var fieldErrors = ScheduleEditorFieldErrors()
    @FocusState private var messageFocused: Bool
    @FocusState private var numericFieldFocused: Bool
    @FocusState private var zoneFocused: Bool

    private var busy: Bool { isSaving || submitting }

    var body: some View {
        NavigationStack {
            DesignPageChrome(title: "Schedule message", accessibilityId: "schedule-editor", showsBack: false) {
                if let saveError {
                    AsyncNotice(kind: .error, title: "Schedule not saved", detail: saveError)
                }
                Group {
                    DesignMultilineEditor(
                        title: "Message",
                        text: $draft.message,
                        error: draft.validationMessage,
                        accessibilityId: "schedule-message",
                        focused: $messageFocused
                    )
                    DesignSegmentedPicker(title: "Timing", options: ScheduleDraftMode.allCases.map { ($0, $0.rawValue) }, selection: $draft.mode)
                    timingFields
                    DesignField(title: "Time zone", text: $draft.timeZone, error: fieldErrors.timeZone, accessibilityId: "schedule-time-zone", focused: $zoneFocused)
                }
                .disabled(busy)
                DesignActionButton(
                    title: busy ? "Saving…" : "Save",
                    state: busy ? .loading : .normal,
                    accessibilityId: "schedule-save"
                ) {
                    messageFocused = false
                    numericFieldFocused = false
                    zoneFocused = false
                    guard applyFields() else { return }
                    submitting = true
                    Task {
                        await onSave()
                        submitting = false
                    }
                }
                DesignActionButton(
                    title: "Cancel",
                    role: .quiet,
                    state: busy ? .disabled : .normal,
                    accessibilityId: "schedule-cancel",
                    action: onCancel
                )
            }
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        messageFocused = false
                        numericFieldFocused = false
                        zoneFocused = false
                    }
                    .accessibilityIdentifier("schedule-keyboard-done")
                }
            }
        }
        .interactiveDismissDisabled(busy)
        .accessibilityAction(.escape) { if !busy { onCancel() } }
        .onChange(of: draft.timeZone) { _, _ in
            if draft.mode == .recurring { _ = applyFields() }
        }
        .onChange(of: draft.mode) { _, mode in
            // Reconcile the native picker with retained wall-clock intent after zone edits in other modes.
            if mode == .recurring { _ = applyFields() }
        }
        .onAppear {
            delay = String(draft.delayMinutes); day = String(draft.dayOfMonth)
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "HH:mm"; formatter.timeZone = TimeZone(identifier: draft.timeZone)
            recurringTime = formatter.string(from: draft.localTime)
        }
    }

    @ViewBuilder private var timingFields: some View {
        switch draft.mode {
        case .once:
            DesignDatePicker(title: "Run at", selection: $draft.date,
                             displayedComponents: [.date, .hourAndMinute],
                             timeZone: TimeZone(identifier: draft.timeZone) ?? .current,
                             error: fieldErrors.absolute, accessibilityId: "schedule-once-at")
        case .delay:
            DesignField(
                title: "Minutes from now",
                text: $delay,
                accessibilityId: "schedule-delay",
                focused: $numericFieldFocused
            )
            .keyboardType(.numberPad)
        case .recurring:
            DesignSelect(title: "Frequency", options: ScheduleDraftFrequency.allCases.map { ($0, $0.rawValue) }, selection: $draft.frequency)
            DesignDatePicker(title: "Local time", selection: $draft.localTime,
                             displayedComponents: [.hourAndMinute],
                             timeZone: TimeZone(identifier: draft.timeZone) ?? .current,
                             error: fieldErrors.recurringTime, accessibilityId: "schedule-local-time")
                .onChange(of: draft.localTime) { _, value in
                    guard let zone = TimeZone(identifier: draft.timeZone) else { return }
                    recurringTime = ScheduleDisplay.localTime(value, zone: zone)
                }
            DesignSelect(title: "Weekday", options: weekdayOptions, selection: $draft.weekday, isEnabled: draft.frequency == .weekly)
            DesignField(
                title: "Day of month",
                text: $day,
                accessibilityId: "schedule-month-day",
                isEnabled: draft.frequency == .monthly,
                focused: $numericFieldFocused
            )
            .keyboardType(.numberPad)
        }
    }

    private func applyFields() -> Bool {
        fieldErrors = ScheduleEditorFields(
            absolute: draft.date.ISO8601Format(),
            delay: delay,
            recurringTime: recurringTime,
            dayOfMonth: day,
            timeZone: draft.timeZone
        ).apply(to: &draft)
        return fieldErrors.isEmpty
    }

    private var weekdayOptions: [(Int, String)] {
        let formatter = DateFormatter()
        formatter.locale = .current
        return (0..<7).map { ($0, formatter.weekdaySymbols[($0 + 1) % 7]) }
    }
}

extension ScheduleDraft {
    init(schedule: Schedule) {
        self.init(); message = schedule.message
        switch onEnum(of: schedule.timing) {
        case .once(let timing): mode = .once; date = (try? Date(timing.at, strategy: .iso8601)) ?? date
        case .recurring(let timing):
            mode = .recurring; timeZone = timing.timeZone
            frequency = switch timing.frequency { case .daily: .daily; case .weekly: .weekly; case .monthly: .monthly }
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "HH:mm"; formatter.timeZone = TimeZone(identifier: timing.timeZone)
            localTime = formatter.date(from: timing.localTime) ?? localTime
            dayOfMonth = Int(timing.dayOfMonth?.intValue ?? 1)
            if let first = timing.weekdays?.first,
               let index = [ScheduleWeekday.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday].firstIndex(of: first) {
                weekday = index
            }
        }
    }
}
