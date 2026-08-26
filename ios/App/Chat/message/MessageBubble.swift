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
    var total: Int = 1
    var continuation = false
    /// Avatar animation mode — only the live streaming assistant bubble animates;
    /// committed bubbles pass `.idle` (static), mirroring the Android avatarMode.
    var avatarMode: SentientIdentityState = .idle
    /// Display name shown in the meta row above the bubble.
    var userName: String = "You"

    /// Bubble width cap, injected by MessageList from the live viewport width so a
    /// non-wrapping tool-pill strip can't drag the bubble off the screen edge.
    @Environment(\.bubbleMaxWidth) private var bubbleMaxWidth

    private var isUser: Bool { message.role == "user" }
    private var isSpeaking: Bool { !isUser && avatarMode == .responding }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                VStack(alignment: .trailing, spacing: Space.xs) {
                    if !continuation { MessageMeta(message: message, userName: userName) }
                    bubbleBody
                }
                avatarColumn(user: true)
            } else {
                avatarColumn(user: false)
                VStack(alignment: .leading, spacing: Space.xs) {
                    if !continuation { MessageMeta(message: message, userName: userName) }
                    bubbleBody
                }
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
        // Index-based id for all bubbles; assistant rows additionally get
        // "assistant-bubble" so Maestro can assert any assistant reply appeared.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityChronology)
        .accessibilityIdentifier(isUser ? "message-bubble-\(index)" : "assistant-bubble")
    }

    // ── Avatar ────────────────────────────────────────────────────────────────

    @ViewBuilder
    private func avatarColumn(user: Bool) -> some View {
        if continuation {
            Color.clear
                .frame(width: BubbleLayout.avatarSize + Space.md, height: 1)
                .accessibilityHidden(true)
        } else if user {
            UserAvatar(name: userName, size: BubbleLayout.avatarSize)
                .padding(.leading, Space.md)
                .accessibilityHidden(true)
        } else {
            SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                .overlay(AvatarRipple(active: avatarMode != .idle))
                .padding(.trailing, Space.md)
                .accessibilityHidden(true)
        }
    }

    private var accessibilityChronology: String {
        let author = isUser ? userName : "Sentient"
        let position = "Message \(index + 1) of \(max(total, index + 1)) from \(author)"
        guard !message.streaming else { return "\(position), responding" }
        let time = Date(timeIntervalSince1970: Double(message.ts) / 1000).formatted(date: .omitted, time: .shortened)
        return "\(position) at \(time)\(cutoffLabel.map { ", \($0)" } ?? "")"
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
        // One layout for all phases: pulse while still thinking → revealed
        // text → committed markdown. Tool rows no longer render here — they
        // moved to the composer's task strip (ComposerTaskStrip), which has no
        // bubble to anchor to (a mid-turn steer can split one turn's rows
        // across bubbles with no stable owner).
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
    static let standardOffset: CGFloat = .zero
    static let continuationPullup = -Space.lg
    static let flushCorner: CGFloat = 6
    static let avatarSize: CGFloat = DesignMetrics.minimumTarget
    static let edgeMin: CGFloat = 12
    static let pulseDot: CGFloat = 6
    static let pulseGap: CGFloat = 4
    static let pulseStagger: Double = 0.18
    static let userBg = DuskColors.userBubble
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
