// ---------------------------------------------------------------------------
// BubbleAnimations — the two animated leaf views used inside a MessageBubble:
// PulseDots (pre-first-token thinking pulse) and StreamingText (typewriter
// reveal of in-flight assistant text). Extracted from MessageBubble.swift to
// keep that file under the clean-code size limit; both are module-internal and
// used only by MessageBubble.bubbleContent.
// ---------------------------------------------------------------------------
import SwiftUI
import MarkdownUI
import MobileData

/// Three-dot thinking pulse — mirrors the Android PulseDots / webui PlaceholderPulse.
struct PulseDots: View {
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
struct StreamingText: View {
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
