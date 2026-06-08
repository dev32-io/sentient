// ---------------------------------------------------------------------------
// PendingBubble — optimistic user-side bubble while the outbox entry is in
// QUEUED, SENT, or FAILED state. Mirrors the Android PendingBubble
// (android/.../chat/MessageList.kt). Reconciled away by ChatRepository once
// the gateway echoes back the committed feed entry carrying the matching
// pendingId. Rendered as a trailing user-aligned bubble with an inline status
// chip below the bubble body.
//
// accessibilityIdentifiers: msg-status-queued / msg-status-sent /
// msg-status-failed — mirrors Android testTags.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct PendingBubble: View {
    let msg: PendingMessage
    var userName: String = "You"
    var onRetry: () -> Void = {}

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Spacer(minLength: BubbleLayout.edgeMin)
            VStack(alignment: .trailing, spacing: Space.xs) {
                // Sender label — mirrors MessageMeta for the user role.
                Text(userName)
                    .font(.system(size: TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
                bubbleBody
                statusChip
            }
            userAvatar
        }
        .frame(maxWidth: .infinity)
    }

    // ── Avatar ────────────────────────────────────────────────────────────────

    private var userAvatar: some View {
        UserAvatar(name: userName, size: BubbleLayout.avatarSize)
            .padding(.leading, Space.md)
    }

    // ── Bubble body ──────────────────────────────────────────────────────────

    private var bubbleBody: some View {
        Text(msg.text)
            .font(.system(size: TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .padding(Space.padMsg)
            .frame(maxWidth: Space.msgMax, alignment: .leading)
            .background(BubbleLayout.userBg)
            .clipShape(pendingShape)
            .overlay(pendingShape.stroke(DuskColors.lineSoft, lineWidth: 1))
            .fixedSize(horizontal: false, vertical: true)
    }

    // Flush the top-trailing corner (user bubble shape — mirrors MessageBubble).
    private var pendingShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: Radii.lg, bottomLeadingRadius: Radii.lg,
            bottomTrailingRadius: Radii.lg, topTrailingRadius: BubbleLayout.flushCorner
        )
    }

    // ── Status chip ──────────────────────────────────────────────────────────

    @ViewBuilder
    private var statusChip: some View {
        if msg.status == .queued {
            chipLabel("queued", color: DuskColors.ink3)
                .accessibilityIdentifier("msg-status-queued")
        } else if msg.status == .sent {
            chipLabel("✓ sent", color: DuskColors.ok)
                .accessibilityIdentifier("msg-status-sent")
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
            .font(.system(size: TypeScale.sm))
            .foregroundStyle(color)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            PendingBubble(msg: PendingMessage(id: "1", text: "Hello, how are you?", status: .queued), userName: "Alice")
            PendingBubble(msg: PendingMessage(id: "2", text: "Can you help me with this?", status: .sent), userName: "Alice")
            PendingBubble(msg: PendingMessage(id: "3", text: "This message failed to send.", status: .failed), userName: "Alice")
        }
        .padding()
    }
    .background(DuskColors.bg)
}
