// MessageBubble — the committed/live message content composite.
//
// MessageBubble owns role-specific content only. MessageBubbleShell owns the
// shared row geometry, avatar, material, metadata, grouping, and accessibility
// contract used by both committed and pending user bubbles.
//
// Layout and behavior remain the established chat contract:
//  - assistant content uses the Sentient mark on the leading edge and paper;
//  - user content uses the user avatar on the trailing edge and sage-mixed paper;
//  - streaming assistant content shows the thinking pulse until revealed text
//    arrives, then renders the data-layer substring directly;
//  - committed content remains GFM Markdown with the Dusk theme and cutoff
//    markers.
import SwiftUI
import MarkdownUI
import MobileData

struct MessageBubble: View {
    let message: ChatMessage
    let index: Int
    var total: Int = 1
    var continuation = false
    /// Avatar animation mode — only the live streaming assistant bubble animates;
    /// committed bubbles pass `.idle`, mirroring the Android avatarMode.
    var avatarMode: SentientIdentityState = .idle
    /// Display name shown in the meta row above the bubble.
    var userName: String = "You"

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        MessageBubbleShell(
            role: isUser ? .user : .assistant,
            name: isUser ? userName : "Sentient",
            timestamp: message.ts,
            isStreaming: message.streaming,
            cutoffLabel: messageCutoffLabel(for: message.cutoffKind),
            index: index,
            total: total,
            continuation: continuation,
            avatarMode: avatarMode,
            accessibilityIdentifier: isUser ? "message-bubble-\(index)" : "assistant-bubble"
        ) {
            bubbleContent
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        // One layout for all phases: pulse while still thinking → revealed
        // text → committed markdown. Tool rows no longer render here — they
        // moved to the composer's task strip, which has no bubble to anchor to
        // (a mid-turn steer can split one turn's rows across bubbles with no
        // stable owner).
        if message.streaming && message.content.isEmpty {
            PulseDots()
        } else if message.streaming {
            StreamingText(content: message.content)
        } else {
            committedText
        }
    }

    private var committedText: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Markdown(message.content)
                .markdownTheme(.dusk)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if messageCutoffLabel(for: message.cutoffKind) != nil {
                interruptedMarker
            }
        }
    }

    private var interruptedMarker: some View {
        Label(messageCutoffLabel(for: message.cutoffKind) ?? "", systemImage: "stop.circle")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .accessibilityIdentifier("message-cutoff-\(index)")
    }
}

/// Cut-short marker copy (nil when not cut short). The two gestures read
/// differently on purpose and match webui's InterruptChip word-for-word:
/// "interrupted" is the Stop button, "barge-in" is the user talking over the
/// reply. Collapsing them told the user their tap stopped a reply their voice
/// had already cut off.
func messageCutoffLabel(for cutoffKind: String?) -> String? {
    switch cutoffKind {
    case "barge-in": return "barge-in"
    case "interrupt": return "interrupted"
    default: return nil
    }
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            MessageBubble(
                message: ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-u0"),
                index: 0,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 1, role: "assistant", content: "Hi there! How can I help?", streaming: false, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a1"),
                index: 1,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 2, role: "assistant", content: "", streaming: true, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a2"),
                index: 2,
                userName: "Alice"
            )
            // streaming + content → data-layer substring rendered directly, no cursor
            MessageBubble(
                message: ChatMessage(ts: now + 3, role: "assistant", content: "Streaming text reveals progressively...", streaming: true, cutoffKind: nil, turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a3"),
                index: 3,
                avatarMode: .thinking,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 4, role: "assistant", content: "Cut off here", streaming: false, cutoffKind: "interrupt", turnId: nil, replyId: nil, pendingId: nil, entryId: "preview-a4"),
                index: 4,
                userName: "Alice"
            )
            // Committed message with a turnId — tool rows for this turn render in
            // the composer's task strip (ComposerTaskStrip), not on the bubble.
            MessageBubble(
                message: ChatMessage(
                    ts: now + 5, role: "assistant",
                    content: "I checked the weather and your calendar.",
                    streaming: false, cutoffKind: nil, turnId: "c1",
                    replyId: nil, pendingId: nil, entryId: "preview-a5"
                ),
                index: 5,
                userName: "Alice"
            )
            // Streaming message with a turnId — same note as above.
            MessageBubble(
                message: ChatMessage(
                    ts: now + 6, role: "assistant",
                    content: "Working on it...",
                    streaming: true, cutoffKind: nil, turnId: "c1",
                    replyId: nil, pendingId: nil, entryId: "preview-a6"
                ),
                index: 6,
                avatarMode: .thinking,
                userName: "Alice"
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
}
