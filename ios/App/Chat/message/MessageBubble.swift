// MessageBubble — one rendered chat message, mirroring the Android MessageBubble
// (android/.../chat/MessageBubble.kt) and the webui MessageBubble
// (gateway/webui/src/components/chat/message-bubble.tsx + components.css).
//
// Layout per role:
//  - assistant: avatar (SentientMark) leading, bubble flush-top-LEADING (6pt),
//    other corners Radii.lg (18pt); paper background.
//  - user: avatar (tinted initial circle) trailing, bubble flush-top-TRAILING
//    (6pt), other corners Radii.lg; sage-mixed-into-paper background (webui
//    color-mix(sage 16%, paper), approximated by interpolation).
// Both: 1pt lineSoft border, padMsg (18pt) text padding, ink text, capped at
// msgMax width. A streaming assistant message with no text yet shows the
// three-dot pulse; once text arrives it renders the already-revealed substring
// from the data layer (no view-side typewriter — mobile-data Reveal ticker drives
// content growth; growing text is the streaming affordance, webui parity);
// a cut-short reply shows an interrupted marker.
//
// Markdown: GFM via MarkdownUI (swift-markdown-ui), themed to Dusk
// (Theme.dusk) — mirrors the webui `marked` render path.
//
// accessibilityIdentifier `message-bubble-<index>` mirrors the Android testTag.
import SwiftUI
import MarkdownUI
import MobileData

struct MessageBubble: View {
    let message: ChatMessage
    let index: Int
    /// Avatar animation mode — only the live streaming assistant bubble animates;
    /// committed bubbles pass `.idle` (static), mirroring the Android avatarMode.
    var avatarMode: MarkMode = .idle
    /// Display name shown in the meta row above the bubble.
    var userName: String = "You"

    /// Bubble width cap, injected by MessageList from the live viewport width so a
    /// non-wrapping tool-pill strip can't drag the bubble off the screen edge.
    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    private var isUser: Bool { message.role == "user" }
    private var isSpeaking: Bool { !isUser && avatarMode == .speaking }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                VStack(alignment: .trailing, spacing: Space.xs) {
                    MessageMeta(message: message, userName: userName)
                    bubbleBody
                }
                userAvatar
            } else {
                SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                    .overlay(AvatarRipple(active: avatarMode != .idle))
                    .padding(.trailing, Space.md)
                VStack(alignment: .leading, spacing: Space.xs) {
                    MessageMeta(message: message, userName: userName)
                    bubbleBody
                }
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
        // Index-based id for all bubbles; assistant rows additionally get
        // "assistant-bubble" so Maestro can assert any assistant reply appeared.
        .accessibilityIdentifier(isUser ? "message-bubble-\(index)" : "assistant-bubble")
    }

    // ── Avatar ────────────────────────────────────────────────────────────────

    /// User → initial on terra/amber accent circle (webui parity).
    private var userAvatar: some View {
        UserAvatar(name: userName, size: BubbleLayout.avatarSize)
            .padding(.leading, Space.md)
    }

    // ── Body ──────────────────────────────────────────────────────────────────

    private var bubbleBody: some View {
        bubbleContent
            .padding(Space.padMsg)
            .frame(maxWidth: bubbleMaxWidth, alignment: .leading)
            .background {
                ZStack {
                    isUser ? BubbleLayout.userBg : DuskColors.paper
                    // Terra sweep composited ON TOP of the opaque fill but under the
                    // text; a plain second `.background` would sit behind the fill and
                    // be occluded (paper is opaque).
                    if isSpeaking { BubbleSpeakingWave() }
                }
            }
            .clipShape(bubbleShape)
            .overlay(bubbleShape.stroke(DuskColors.lineSoft, lineWidth: 1))
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var bubbleContent: some View {
        // One layout for all phases: the body (pulse while still thinking →
        // revealed text → committed markdown) with the tool-pill strip below.
        // Pills render even in the empty-text think window so a running tool
        // surfaces live, before any answer text arrives (webui parity — show
        // info as early as possible).
        VStack(alignment: .leading, spacing: Space.xs) {
            if message.streaming && message.content.isEmpty {
                PulseDots()
            } else if message.streaming {
                StreamingText(content: message.content)
            } else {
                committedText
            }
            if !message.tools.isEmpty { ToolPillStrip(tools: message.tools) }
        }
    }

    private var committedText: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Markdown(message.content)
                .markdownTheme(.dusk)
                .frame(maxWidth: .infinity, alignment: .leading)
            if cutoffLabel != nil { interruptedMarker }
        }
    }

    private var interruptedMarker: some View {
        Label(cutoffLabel ?? "", systemImage: "stop.circle")
            .font(.system(size: TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .accessibilityIdentifier("message-cutoff-\(index)")
    }

    /// Cut-short marker copy (nil when not cut short). The two gestures read
    /// differently on purpose and match webui's InterruptChip word-for-word:
    /// "interrupted" is the Stop button, "barge-in" is the user talking over the
    /// reply. Collapsing them told the user their tap stopped a reply their
    /// voice had already cut off.
    private var cutoffLabel: String? {
        switch message.cutoffKind {
        case "barge-in": return "barge-in"
        case "interrupt": return "interrupted"
        default: return nil
        }
    }

    /// Flush the corner nearest the sender (Android FLUSH_CORNER = 6pt).
    private var bubbleShape: UnevenRoundedRectangle {
        let r = Radii.lg
        let flush = BubbleLayout.flushCorner
        if isUser {
            return UnevenRoundedRectangle(
                topLeadingRadius: r, bottomLeadingRadius: r,
                bottomTrailingRadius: r, topTrailingRadius: flush
            )
        }
        return UnevenRoundedRectangle(
            topLeadingRadius: flush, bottomLeadingRadius: r,
            bottomTrailingRadius: r, topTrailingRadius: r
        )
    }
}

// PulseDots + StreamingText live in BubbleAnimations.swift (kept out of this file
// for the clean-code size limit).

/// Bubble layout constants. `userBg` approximates the webui
/// color-mix(in oklab, sage 16%, paper) via sRGB interpolation, matching the
/// Android `lerp(paper, sage, 0.16)`. (Color.mix is iOS 18+, so the token wrapper
/// does the lerp on the raw ARGB values, keeping the iOS-17 deployment target.)
enum BubbleLayout {
    static let flushCorner: CGFloat = 6
    static let avatarSize: CGFloat = 28
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 6
    static let pulseGap: CGFloat = 4
    static let pulseStagger: Double = 0.18
    static let userBg = DuskColors.userBubble
}

#Preview {
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let sampleTools: [TaskSnapshotItem] = [
        TaskSnapshotItem(
            toolCallId: "t1", toolName: "web_search",
            turnId: "c1", status: "finished",
            argsPreview: #"{"query":"current weather in Tokyo"}"#,
            startedAtMs: now, endedAtMs: KotlinLong(value: now + 1200), taskId: nil
        ),
        TaskSnapshotItem(
            toolCallId: "t2", toolName: "calendar_read",
            turnId: "c1", status: "running",
            argsPreview: #"{"date":"2026-06-04"}"#,
            startedAtMs: now + 1200, endedAtMs: nil, taskId: nil
        ),
        TaskSnapshotItem(
            toolCallId: "t3", toolName: "send_message",
            turnId: "c1", status: "failed",
            argsPreview: "",
            startedAtMs: now + 500, endedAtMs: KotlinLong(value: now + 800), taskId: nil
        ),
    ]
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            MessageBubble(
                message: ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, turnId: nil, messageId: nil, pendingId: nil, tools: [], entryId: "preview-u0"),
                index: 0,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 1, role: "assistant", content: "Hi there! How can I help?", streaming: false, cutoffKind: nil, turnId: nil, messageId: nil, pendingId: nil, tools: [], entryId: "preview-a1"),
                index: 1,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 2, role: "assistant", content: "", streaming: true, cutoffKind: nil, turnId: nil, messageId: nil, pendingId: nil, tools: [], entryId: "preview-a2"),
                index: 2,
                userName: "Alice"
            )
            // streaming + content → data-layer substring rendered directly, no cursor
            MessageBubble(
                message: ChatMessage(ts: now + 3, role: "assistant", content: "Streaming text reveals progressively...", streaming: true, cutoffKind: nil, turnId: nil, messageId: nil, pendingId: nil, tools: [], entryId: "preview-a3"),
                index: 3,
                avatarMode: .thinking,
                userName: "Alice"
            )
            MessageBubble(
                message: ChatMessage(ts: now + 4, role: "assistant", content: "Cut off here", streaming: false, cutoffKind: "interrupt", turnId: nil, messageId: nil, pendingId: nil, tools: [], entryId: "preview-a4"),
                index: 4,
                userName: "Alice"
            )
            // Tool pill strip — committed message with three tools (finished/running/failed).
            MessageBubble(
                message: ChatMessage(
                    ts: now + 5, role: "assistant",
                    content: "I checked the weather and your calendar.",
                    streaming: false, cutoffKind: nil, turnId: "c1",
                    messageId: nil, pendingId: nil, tools: sampleTools, entryId: "preview-a5"
                ),
                index: 5,
                userName: "Alice"
            )
            // Tool pill strip — streaming message with tools still running.
            MessageBubble(
                message: ChatMessage(
                    ts: now + 6, role: "assistant",
                    content: "Working on it...",
                    streaming: true, cutoffKind: nil, turnId: "c1",
                    messageId: nil, pendingId: nil, tools: [sampleTools[1]], entryId: "preview-a6"
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
