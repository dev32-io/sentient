import MobileData
import SwiftUI

struct ScheduledInboxScreen: View {
    @State private var vm: ScheduledMessagesViewModel
    let onBack: () -> Void
    let onSelectSession: (String) -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void, onSelectSession: @escaping (String) -> Void) {
        _vm = State(initialValue: ScheduledMessagesViewModel(useCases: settings.schedules))
        self.onBack = onBack
        self.onSelectSession = onSelectSession
    }

    var body: some View {
        DesignPageChrome(title: "Messages", accessibilityId: "scheduled-inbox-screen", onBack: onBack) {
            switch vm.cardsState {
            case .loading where vm.cards.isEmpty:
                AsyncNotice(kind: .loading, title: "Loading messages")
            case .failed(let message) where vm.cards.isEmpty:
                AsyncNotice(kind: .error, title: "Messages unavailable", detail: message, retry: { Task { await vm.reload() } })
            default:
                if case .failed(let message) = vm.cardsState {
                    AsyncNotice(kind: .error, title: "Messages may be out of date", detail: message,
                                retry: { Task { await vm.reload() } }, actionTitle: "Reload")
                } else if case .loading = vm.cardsState, !vm.cards.isEmpty {
                    AsyncNotice(kind: .loading, title: "Refreshing messages")
                }
                if vm.cards.isEmpty {
                    AsyncNotice(kind: .empty, title: "No scheduled messages yet", detail: "Completed scheduled conversations appear here.")
                } else {
                    ForEach(vm.cards, id: \.occurrenceId) { card in
                        ScheduledSessionCardView(card: card) {
                            vm.select(card)
                            onSelectSession(card.sessionId)
                        }
                    }
                }
            }
        }
        .task { vm.start() }
    }
}

/// Compact session-backed result. It intentionally has no unread affordance or
/// retained conversation copy; the preview is bounded by the shared contract.
private struct ScheduledSessionCardView: View {
    let card: ScheduledSessionCard
    let action: () -> Void

    var body: some View {
        DesignSelectableCard(
            isSelected: false,
            accessibilityLabel: accessibilityLabel,
            accessibilityId: "scheduled-card-\(card.occurrenceId)",
            action: action
        ) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text(preview)
                    .designText(.body)
                    .foregroundStyle(DuskColors.ink)
                    .lineLimit(3)
                Text(card.completedAt)
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var preview: String {
        if let preview = card.preview { return String(preview.prefix(280)) }
        return card.status == .failed ? "Scheduled conversation failed" : "Scheduled conversation interrupted"
    }
    private var accessibilityLabel: String { "\(preview), \(card.completedAt)" }
}
