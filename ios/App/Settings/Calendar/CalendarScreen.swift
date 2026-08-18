import SwiftUI
import MobileData

struct CalendarScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void
    @State private var vm: CalendarViewModel
    @State private var newTitle = ""
    @State private var newDate = ""
    @State private var deleteTarget: CalendarEvent?

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: CalendarViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Calendar", screenId: "settings-calendar-screen") {
            if case .failed(let message) = vm.mutation {
                SoulInlineError(message: message)
                    .accessibilityIdentifier("settings-calendar-operation-error")
            }
            createForm
            switch vm.phase {
            case .loading: SoulLoadingRow()
            case .failed(let message):
                SoulInlineError(message: message)
                Button("Retry") { Task { await vm.load() } }
                    .accessibilityIdentifier("settings-calendar-retry")
            case .ready:
                if vm.events.isEmpty {
                    Text("No events in the next year.")
                        .foregroundStyle(DuskColors.ink4)
                        .accessibilityIdentifier("settings-calendar-empty")
                } else {
                    VStack(spacing: Space.xs) {
                        ForEach(vm.events, id: \.rowID) { event in
                            CalendarEventRow(
                                event: event,
                                disabled: vm.mutation == .saving,
                                onUpdate: { title, date in
                                    Task { await vm.update(event: event, title: title, date: date) }
                                },
                                onDelete: { deleteTarget = event }
                            )
                            .id("\(event.rowID)-\(event.updatedAt)")
                        }
                    }
                    .accessibilityIdentifier("settings-calendar-list")
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await vm.load() } } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(vm.mutation == .saving)
                .accessibilityIdentifier("settings-calendar-refresh")
            }
        }
        .task { await vm.load() }
        .confirmationDialog(
            "Delete calendar event?",
            isPresented: Binding(
                get: { deleteTarget != nil },
                set: { if !$0 { deleteTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                guard let target = deleteTarget else { return }
                deleteTarget = nil
                Task { await vm.delete(event: target) }
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        }
    }

    private var createForm: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                TextField("Event", text: $newTitle)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("settings-calendar-title")
                TextField("Date (YYYY-MM-DD)", text: $newDate)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("settings-calendar-date")
            }
            Button("Add") {
                let title = newTitle
                let date = newDate
                Task {
                    await vm.create(title: title, date: date)
                    if case .failed = vm.mutation {
                        // Keep the draft visible so the user can correct/retry it.
                    } else {
                        newTitle = ""
                        newDate = ""
                    }
                }
            }
            .disabled(vm.mutation == .saving)
            .accessibilityIdentifier("settings-calendar-add")
        }
    }
}

private struct CalendarEventRow: View {
    let event: CalendarEvent
    let disabled: Bool
    let onUpdate: (String, String) -> Void
    let onDelete: () -> Void
    @State private var title: String
    @State private var date: String

    init(
        event: CalendarEvent,
        disabled: Bool,
        onUpdate: @escaping (String, String) -> Void,
        onDelete: @escaping () -> Void
    ) {
        self.event = event
        self.disabled = disabled
        self.onUpdate = onUpdate
        self.onDelete = onDelete
        _title = State(initialValue: event.title)
        _date = State(initialValue: CalendarDisplayFormatter.editorText(event.start))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(event.calendarStartText)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink4)
                .accessibilityIdentifier("settings-calendar-start-\(event.rowID)")
            HStack(spacing: Space.sm) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    TextField("Event", text: $title)
                        .textFieldStyle(.roundedBorder)
                    TextField("Date / time", text: $date)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("settings-calendar-date-\(event.rowID)")
                }
                Button("Save") { onUpdate(title, date) }
                    .disabled(disabled)
                    .accessibilityIdentifier("settings-calendar-update-\(event.rowID)")
                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .disabled(disabled)
                .accessibilityIdentifier("settings-calendar-delete-\(event.rowID)")
            }
        }
        .padding(.vertical, Space.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-calendar-event-\(event.rowID)")
    }
}

#Preview {
    Text("Calendar requires a live SettingsComponent")
}
