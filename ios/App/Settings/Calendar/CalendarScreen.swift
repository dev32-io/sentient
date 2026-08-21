import SwiftUI
import MobileData

/// Route shell only. Calendar geometry and policy come from shared projections;
/// this native surface renders the currently supported semantic states.
struct CalendarScreen: View {
    let experience: CalendarExperience?
    let onBack: () -> Void

    var body: some View {
        if let experience {
            CalendarExperienceScreen(experience: experience, onBack: onBack)
        } else {
            SettingsPageScaffold(title: "Calendar", screenId: "settings-calendar-screen") {
                SoulInlineError(message: "Calendar is unavailable.")
                    .accessibilityIdentifier("settings-calendar-unavailable")
            }
        }
    }
}

private struct CalendarExperienceScreen: View {
    let onBack: () -> Void
    @State private var vm: CalendarViewModel

    init(experience: CalendarExperience, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: CalendarViewModel(experience: experience))
    }

    var body: some View {
        SettingsPageScaffold(title: "Calendar", screenId: "settings-calendar-screen") {
            if let state = vm.state {
                if state.isOffline {
                    Text(state.content == .unavailableOffline ? "Calendar unavailable offline." : "Showing saved calendar data.")
                        .foregroundStyle(DuskColors.ink4)
                        .accessibilityIdentifier("settings-calendar-offline")
                }
                if let error = state.error {
                    SoulInlineError(message: error.userMessage)
                        .accessibilityIdentifier("settings-calendar-error")
                }

                switch state.content {
                case .loading:
                    SoulLoadingRow()
                case .empty:
                    Text("No matching events.")
                        .foregroundStyle(DuskColors.ink4)
                        .accessibilityIdentifier("settings-calendar-empty")
                case .unavailableOffline:
                    SoulInlineError(message: "This date range is not available offline.")
                case .error:
                    SoulInlineError(message: state.error?.userMessage ?? "Calendar is unavailable.")
                case .content:
                    VStack(spacing: Space.xs) {
                        ForEach(state.visibleEvents, id: \.actionIdentity.stableKey) { event in
                            Button {
                                if let occurrence = state.occurrences.first(where: {
                                    $0.eventId == event.eventId && $0.occurrenceId == event.occurrenceId
                                }) {
                                    vm.openPreview(occurrence)
                                }
                            } label: {
                                HStack {
                                    Text(event.title)
                                    Spacer()
                                    Text(event.start.rawValue)
                                        .font(Typo.mono(TypeScale.sm))
                                        .foregroundStyle(DuskColors.ink4)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(event.accessibilityLabel)
                            .accessibilityIdentifier("settings-calendar-event-\(event.actionIdentity.stableKey)")
                        }
                    }
                    .accessibilityIdentifier("settings-calendar-list")
                }

                if state.mutationAvailability.canCreate {
                    Button("Add") { vm.add() }
                        .accessibilityIdentifier("settings-calendar-add")
                }
            } else {
                SoulLoadingRow()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { vm.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(vm.state?.isRefreshing == true)
                    .accessibilityIdentifier("settings-calendar-refresh")
            }
        }
        .onDisappear { vm.dispose() }
    }
}

#Preview {
    Text("Calendar requires a session CalendarExperience")
}
