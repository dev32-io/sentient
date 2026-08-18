import SwiftUI
import MobileData

struct CalendarScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void
    @State private var vm: CalendarViewModel

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: CalendarViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Calendar", screenId: "settings-calendar-screen") {
            if let error = vm.mutationError { SoulInlineError(message: error) }
            switch vm.phase {
            case .loading: SoulLoadingRow()
            case .failed(let message): SoulInlineError(message: message)
            case .ready:
                if vm.events.isEmpty {
                    Text("No events in the next three months.")
                        .foregroundStyle(DuskColors.ink4)
                        .accessibilityIdentifier("settings-calendar-empty")
                } else {
                    VStack(spacing: Space.xs) {
                        ForEach(vm.events, id: \.id) { event in
                            eventRow(event)
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
                .accessibilityIdentifier("settings-calendar-refresh")
            }
        }
        .task { await vm.load() }
    }

    private func eventRow(_ event: CalendarEvent) -> some View {
        HStack(alignment: .top, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(event.title).font(Typo.ui(TypeScale.base)).foregroundStyle(DuskColors.ink)
                Text(event.calendarStartText)
                    .font(Typo.mono(TypeScale.sm)).foregroundStyle(DuskColors.ink4)
            }
            Spacer()
        }
        .padding(.vertical, Space.sm)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings-calendar-event-\(event.id)")
    }
}

private extension CalendarEvent {
    var calendarStartText: String {
        switch onEnum(of: start) {
        case .allDay(let value): return value.date
        case .timed(let value): return value.instant
        }
    }
}

#Preview {
    Text("Calendar requires a live SettingsComponent")
}
