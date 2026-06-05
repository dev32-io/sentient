// ---------------------------------------------------------------------------
// ChatLoadingView — centred spinner + label shown on the empty message list
// while the chat is connecting or waiting for the first session to start.
//
// Rendered by ChatView via an .overlay when messages are empty and
// chatLoadingState != .none. Binds to LoadingAffordance values; does NOT
// show for .none (caller's responsibility to gate).
//
// accessibilityIdentifier: chat-loading (used for UI regression assertions).
// ---------------------------------------------------------------------------
import SwiftUI

struct ChatLoadingView: View {
    let state: LoadingAffordance

    private var label: String {
        switch state {
        case .connecting: return "Connecting…"
        case .sessionStarting: return "Starting a new chat…"
        case .none: return ""
        }
    }

    var body: some View {
        VStack(spacing: Space.md) {
            ProgressView()
                .tint(DuskColors.accent)
            Text(label)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
        }
        .accessibilityIdentifier("chat-loading")
    }
}

// ── Previews ──────────────────────────────────────────────────────────────

#Preview("Connecting") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        ChatLoadingView(state: .connecting)
    }
}

#Preview("Session starting") {
    ZStack {
        DuskColors.bg.ignoresSafeArea()
        ChatLoadingView(state: .sessionStarting)
    }
}
