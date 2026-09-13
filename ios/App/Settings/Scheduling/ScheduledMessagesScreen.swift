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
        .sheet(isPresented: Binding(get: { editing != nil || presentingNew }, set: { if !$0 { editing = nil; presentingNew = false } })) {
            ScheduleEditor(
                draft: $draft,
                isSaving: vm.isMutating,
                saveError: vm.mutationError,
                onCancel: { editing = nil; presentingNew = false }
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
            ForEach(vm.schedules, id: \.scheduleId) { schedule in
                ScheduleSummaryCard(schedule: schedule, disabled: vm.isMutating, onEdit: {
                    editing = schedule; draft = ScheduleDraft(schedule: schedule)
                }, onToggle: { Task { await vm.toggle(schedule) } }, onDelete: { Task { await vm.delete(schedule) } })
            }
        }
    }
}

private extension ScheduledMessagesScreen {
    // Separate action avoids presenting a sentinel Schedule object.
    func beginNew() { presentingNew = true; editing = nil; draft = ScheduleDraft() }
}

private struct ScheduleSummaryCard: View {
    let schedule: Schedule
    let disabled: Bool
    let onEdit: () -> Void
    let onToggle: () -> Void
    let onDelete: () -> Void

    var body: some View {
        DesignCard(title: schedule.message, detail: schedule.nextRunAt.map { "Next: \($0)" } ?? "No next run", bodyStyle: .padded) {
            DesignSettingsRow(title: "Status") { DesignStatusBadge(title: schedule.enabled ? "Active" : "Paused", tint: schedule.enabled ? DuskColors.sage : DuskColors.ink3) }
            DesignActionButton(title: "Edit", role: .secondary, state: disabled ? .disabled : .normal, action: onEdit)
            DesignActionButton(title: schedule.enabled ? "Pause" : "Resume", role: .quiet, state: disabled ? .disabled : .normal, action: onToggle)
            DesignActionButton(title: "Delete", role: .destructive, state: disabled ? .disabled : .normal, action: onDelete)
        }
        .accessibilityIdentifier("schedule-\(schedule.scheduleId)")
    }
}

private struct ScheduleEditor: View {
    @Binding var draft: ScheduleDraft
    let isSaving: Bool
    let saveError: String?
    let onCancel: () -> Void
    let onSave: () async -> Void
    @State private var delay = "30"
    @State private var day = "1"
    @State private var absolute = ""
    @State private var recurringTime = "09:00"
    @State private var fieldErrors = ScheduleEditorFieldErrors()
    @FocusState private var messageFocused: Bool
    @FocusState private var numericFieldFocused: Bool

    var body: some View {
        NavigationStack {
            DesignPageChrome(title: "Schedule message", accessibilityId: "schedule-editor", showsBack: false) {
                if let saveError {
                    AsyncNotice(kind: .error, title: "Schedule not saved", detail: saveError)
                }
                DesignMultilineEditor(
                    title: "Message",
                    text: $draft.message,
                    error: draft.validationMessage,
                    accessibilityId: "schedule-message",
                    focused: $messageFocused
                )
                DesignSegmentedPicker(title: "Timing", options: ScheduleDraftMode.allCases.map { ($0, $0.rawValue) }, selection: $draft.mode)
                timingFields
                DesignField(title: "Time zone", text: $draft.timeZone, error: fieldErrors.timeZone, accessibilityId: "schedule-time-zone")
                DesignActionButton(
                    title: isSaving ? "Saving…" : "Save",
                    state: isSaving ? .loading : .normal,
                    accessibilityId: "schedule-save"
                ) {
                    messageFocused = false
                    numericFieldFocused = false
                    guard applyFields() else { return }
                    Task { await onSave() }
                }
                DesignActionButton(
                    title: "Cancel",
                    role: .quiet,
                    state: isSaving ? .disabled : .normal,
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
                    }
                    .accessibilityIdentifier("schedule-keyboard-done")
                }
            }
        }
        .onAppear {
            delay = String(draft.delayMinutes); day = String(draft.dayOfMonth)
            absolute = draft.date.ISO8601Format(.iso8601(timeZone: .current))
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"; formatter.timeZone = TimeZone(identifier: draft.timeZone)
            recurringTime = formatter.string(from: draft.localTime)
        }
    }

    @ViewBuilder private var timingFields: some View {
        switch draft.mode {
        case .once:
            DesignField(title: "Run at", prompt: "2026-08-01T15:30:00-07:00", text: $absolute, error: fieldErrors.absolute, accessibilityId: "schedule-once-at")
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
            DesignField(title: "Local time", prompt: "09:00", text: $recurringTime, error: fieldErrors.recurringTime, accessibilityId: "schedule-local-time")
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
            absolute: absolute,
            delay: delay,
            recurringTime: recurringTime,
            dayOfMonth: day,
            timeZone: draft.timeZone
        ).apply(to: &draft)
        return fieldErrors.isEmpty
    }

    private var weekdayOptions: [(Int, String)] {
        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            .enumerated().map { ($0.offset, $0.element) }
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
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"; formatter.timeZone = TimeZone(identifier: timing.timeZone)
            localTime = formatter.date(from: timing.localTime) ?? localTime
            dayOfMonth = Int(timing.dayOfMonth?.intValue ?? 1)
            if let first = timing.weekdays?.first,
               let index = [ScheduleWeekday.monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday].firstIndex(of: first) {
                weekday = index
            }
        }
    }
}
