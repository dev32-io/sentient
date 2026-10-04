// ---------------------------------------------------------------------------
// ChatTitleBar — the top navigation bar for ChatView, extracted to keep
// ChatView.swift within the clean-code line limit.
//
// Layout: [hamburger] ··· [static avatar] ··· [bell] [new-chat].
// `chat-screen` belongs to the avatar leaf, preserving child control identifiers.
// ---------------------------------------------------------------------------
import SwiftUI

struct ChatTitleBar: View {
    let onOpenPanel: () -> Void
    let onOpenInbox: () -> Void
    let onNewChat: () -> Void

    var historyIsOpen = false
    @AccessibilityFocusState private var historyAccessibilityFocused: Bool
    @FocusState private var historyKeyboardFocused: Bool

    var body: some View {
        ZStack {
            brand
            HStack(spacing: Space.sm) {
                historyButton
                Spacer(minLength: ChatLayout.markSize + Space.sm)
                actions
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.sm)
        .onChange(of: historyIsOpen) { wasOpen, open in
            if wasOpen && !open {
                historyAccessibilityFocused = true
                historyKeyboardFocused = true
            }
        }
    }

    private var brand: some View {
        StaticSentientMark(size: ChatLayout.markSize)
            .background(DuskColors.bgElev, in: Circle())
            .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
            .accessibilityIdentifier("chat-screen")
    }

    private var historyButton: some View {
        DesignIconButton(systemName: "line.3.horizontal", label: "History",
                         accessibilityId: "history-open", action: onOpenPanel)
            .accessibilityFocused($historyAccessibilityFocused)
            .focused($historyKeyboardFocused)
    }

    private var actions: some View {
        HStack(spacing: Space.sm) {
            DesignIconButton(systemName: "bell", label: "Scheduled messages",
                             accessibilityId: "scheduled-inbox-open", action: onOpenInbox)
            DesignIconButton(systemName: "plus", label: "New chat",
                             accessibilityId: "new-chat", action: onNewChat)
        }
    }

}

enum ChatLayout {
    static let markSize: CGFloat = DesignMetrics.actionButtonVisualHeight
}
