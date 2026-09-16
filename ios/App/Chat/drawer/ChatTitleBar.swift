// ---------------------------------------------------------------------------
// ChatTitleBar — the top navigation bar for ChatView, extracted to keep
// ChatView.swift within the clean-code line limit.
//
// Layout: [hamburger] ··· [SentientMark · title] ··· [new-chat "+"].
// `chat-screen` accessibilityIdentifier sits on the title leaf (not the
// container) so it doesn't shadow inner element ids.
// ---------------------------------------------------------------------------
import SwiftUI

struct ChatTitleBar: View {
    let onOpenPanel: () -> Void
    let onOpenInbox: () -> Void
    let onNewChat: () -> Void

    private static let title = "Sentient"

    var body: some View {
        HStack(spacing: Space.sm) {
            Button(action: onOpenPanel) {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: TypeScale.lg))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("History")
            .accessibilityIdentifier("history-open")
            Spacer()
            HStack(spacing: Space.sm) {
                StaticSentientMark(size: ChatLayout.markSize)
                Text(Self.title)
                    .font(Typo.display(TypeScale.lg, .semibold))
                    .foregroundStyle(DuskColors.ink)
                    .accessibilityIdentifier("chat-screen")
            }
            Spacer()
            DesignIconButton(
                systemName: "bell",
                label: "Scheduled messages",
                accessibilityId: "scheduled-inbox-open",
                action: onOpenInbox
            )
            Button(action: onNewChat) {
                Image(systemName: "plus")
                    .font(.system(size: TypeScale.lg))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New chat")
            .accessibilityIdentifier("new-chat")
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
    }
}

enum ChatLayout {
    static let markSize: CGFloat = 26
}
