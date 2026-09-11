// ---------------------------------------------------------------------------
// PendingBubble — optimistic user-side bubble while the outbox entry is in
// QUEUED or FAILED state. There is NO "sent" state: the bubble is reconciled
// AWAY (cache.remove) on its committed echo, never promoted to a "✓ sent" chip.
//
// MessageBubbleShell owns the shared user-row geometry, avatar, material,
// metadata, width, and accessibility. This view supplies only plain-text
// outbox content and its retry/status footer.
//
// accessibilityIdentifiers: msg-status-queued / msg-status-failed — mirrors
// Android testTags.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct PendingBubble: View {
    let msg: PendingMessage
    var userName: String = "You"
    var onRetry: () -> Void = {}
    /// Chronology position is supplied by MessageList; defaults keep direct
    /// previews and existing internal callers source-compatible.
    var index: Int = 0
    var total: Int = 1

    var body: some View {
        MessageBubbleShell(
            role: .user,
            name: userName,
            timestamp: nil,
            isStreaming: false,
            cutoffLabel: nil,
            index: index,
            total: total,
            continuation: false,
            avatarMode: .idle,
            metadataMuted: true
        ) {
            Text(msg.text)
                .font(Typo.ui(TypeScale.base))
                .foregroundStyle(DuskColors.ink)
        } footer: {
            statusChip
        }
    }

    // ── Status chip ──────────────────────────────────────────────────────────

    @ViewBuilder
    private var statusChip: some View {
        if msg.status == .queued {
            chipLabel("Sending…", color: DuskColors.ink3)
                .accessibilityIdentifier("msg-status-queued")
        } else {
            // FAILED — tappable retry chip.
            Button(action: onRetry) {
                chipLabel("↺ Retry", color: DuskColors.stop)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("msg-status-failed")
        }
    }

    private func chipLabel(_ text: String, color: Color) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(color)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

#Preview {
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            PendingBubble(msg: PendingMessage(id: "1", text: "Hello, how are you?", status: .queued, sentAtMs: nil), userName: "Alice")
            PendingBubble(msg: PendingMessage(id: "3", text: "This message failed to send.", status: .failed, sentAtMs: nil), userName: "Alice")
        }
        .padding()
    }
    .background(DuskColors.bg)
}
