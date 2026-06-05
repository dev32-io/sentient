// ---------------------------------------------------------------------------
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
// three-dot pulse; once text arrives it reveals text via the typewriter engine
// (no block cursor — growing text is the streaming affordance, webui parity);
// a cut-short reply shows an interrupted marker.
//
// Markdown: GFM via MarkdownUI (swift-markdown-ui), themed to Dusk
// (Theme.dusk) — mirrors the webui `marked` render path.
//
// accessibilityIdentifier `message-bubble-<index>` mirrors the Android testTag.
// ---------------------------------------------------------------------------
import SwiftUI
import MarkdownUI
import MobileSdk

struct MessageBubble: View {
    let message: ChatMessage
    let index: Int
    /// Avatar animation mode — only the live streaming assistant bubble animates;
    /// committed bubbles pass `.idle` (static), mirroring the Android avatarMode.
    var avatarMode: MarkMode = .idle

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if isUser {
                Spacer(minLength: BubbleLayout.edgeMin)
                bubbleBody
                userAvatar
            } else {
                SentientMark(size: BubbleLayout.avatarSize, mode: avatarMode)
                    .padding(.trailing, Space.md)
                bubbleBody
                Spacer(minLength: BubbleLayout.edgeMin)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("message-bubble-\(index)")
    }

    // ── Avatar ────────────────────────────────────────────────────────────────

    /// User → tinted initial circle (matches the Android sageSoft placeholder).
    private var userAvatar: some View {
        Circle()
            .fill(DuskColors.sageSoft)
            .frame(width: BubbleLayout.avatarSize, height: BubbleLayout.avatarSize)
            .padding(.leading, Space.md)
    }

    // ── Body ──────────────────────────────────────────────────────────────────

    private var bubbleBody: some View {
        bubbleContent
            .padding(Space.padMsg)
            .frame(maxWidth: Space.msgMax, alignment: .leading)
            .background(isUser ? BubbleLayout.userBg : DuskColors.paper)
            .clipShape(bubbleShape)
            .overlay(bubbleShape.stroke(DuskColors.lineSoft, lineWidth: 1))
            .fixedSize(horizontal: false, vertical: true)
    }

    // Tool pills (message.tools) are wired into both branches in a later task (6.1).
    @ViewBuilder
    private var bubbleContent: some View {
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

    /// Interrupt / barge-in cut-short marker copy (nil when not cut short).
    private var cutoffLabel: String? {
        switch message.cutoffKind {
        case "interrupt", "barge-in": return "interrupted"
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

/// Three-dot thinking pulse — mirrors the Android PulseDots / webui PlaceholderPulse.
private struct PulseDots: View {
    @State private var pulsing = false

    var body: some View {
        HStack(spacing: BubbleLayout.pulseGap) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(DuskColors.accent.opacity(0.4))
                    .frame(width: BubbleLayout.pulseDot, height: BubbleLayout.pulseDot)
                    .scaleEffect(pulsing ? 1.0 : 0.6)
                    .animation(
                        .easeInOut(duration: Motion.wave)
                            .repeatForever()
                            .delay(Double(i) * BubbleLayout.pulseStagger),
                        value: pulsing
                    )
            }
        }
        .onAppear { pulsing = true }
        .accessibilityLabel("Assistant is thinking")
    }
}

/// Reveals streamed assistant text via the typewriter engine.
/// No block cursor (webui parity); the growing text IS the streaming affordance.
/// Reduced-motion: renders the full content immediately.
private struct StreamingText: View {
    let content: String
    @State private var twState = TypewriterState()
    @State private var lastDate: Date? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let chars = Array(content)
        Group {
            if reduceMotion {
                Markdown(content).markdownTheme(.dusk)
            } else {
                TimelineView(.animation) { tl in
                    Markdown(String(chars.prefix(twState.visibleCount)))
                        .markdownTheme(.dusk)
                        .onChange(of: tl.date) { _, newDate in
                            let dt = lastDate.map { newDate.timeIntervalSince($0) } ?? 0
                            let now = newDate.timeIntervalSinceReferenceDate
                            twState = typewriterTick(
                                twState, target: chars,
                                streamComplete: false, dt: dt, now: now
                            )
                            lastDate = newDate
                        }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Bubble layout constants. `userBg` approximates the webui
/// color-mix(in oklab, sage 16%, paper) via sRGB interpolation, matching the
/// Android `lerp(paper, sage, 0.16)`. (Color.mix is iOS 18+, so the token wrapper
/// does the lerp on the raw ARGB values, keeping the iOS-17 deployment target.)
private enum BubbleLayout {
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
    ScrollView {
        VStack(spacing: Space.gapMsg) {
            MessageBubble(
                message: ChatMessage(ts: now, role: "user", content: "hello", streaming: false, cutoffKind: nil, cycleId: nil, tools: []),
                index: 0
            )
            MessageBubble(
                message: ChatMessage(ts: now + 1, role: "assistant", content: "Hi there! How can I help?", streaming: false, cutoffKind: nil, cycleId: nil, tools: []),
                index: 1
            )
            MessageBubble(
                message: ChatMessage(ts: now + 2, role: "assistant", content: "", streaming: true, cutoffKind: nil, cycleId: nil, tools: []),
                index: 2
            )
            // streaming + content → typewriter reveal, no cursor
            MessageBubble(
                message: ChatMessage(ts: now + 3, role: "assistant", content: "Streaming text reveals progressively...", streaming: true, cutoffKind: nil, cycleId: nil, tools: []),
                index: 3,
                avatarMode: .thinking
            )
            MessageBubble(
                message: ChatMessage(ts: now + 4, role: "assistant", content: "Cut off here", streaming: false, cutoffKind: "interrupt", cycleId: nil, tools: []),
                index: 4
            )
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
}
