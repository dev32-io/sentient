// ---------------------------------------------------------------------------
// BubbleAnimations — the two presentation leaves used inside a MessageBubble:
// PulseDots (pre-first-token thinking pulse) and StreamingText (data-driven
// reveal of in-flight assistant text). Extracted from MessageBubble.swift so
// content-state rendering stays separate from the shared bubble shell.
// ---------------------------------------------------------------------------
import SwiftUI
import MarkdownUI

/// Three-dot thinking pulse — mirrors the Android PulseDots / webui PlaceholderPulse.
struct PulseDots: View {
    @State private var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: BubbleLayout.pulseGap) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(DuskColors.accent)
                    .frame(width: BubbleLayout.pulseDot, height: BubbleLayout.pulseDot)
                    .opacity(reduceMotion || pulsing ? 1 : 0.34)
                    .offset(y: reduceMotion || !pulsing ? 0 : -2)
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: BubbleLayout.pulseDuration)
                            .repeatForever()
                            .delay(Double(i) * BubbleLayout.pulseStagger),
                        value: pulsing
                    )
            }
        }
        .onAppear { pulsing = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in pulsing = !reduced }
        .accessibilityLabel("Assistant is thinking")
    }
}

/// Renders the in-flight assistant text directly from the data-layer substring.
/// The data layer (mobile-data Reveal ticker) advances `message.content` each
/// tick — this view just renders whatever substring it receives. No view-side
/// typewriter: double-revealing would lag/stall. The growing text is the
/// streaming affordance (webui/Android parity; no block cursor).
struct StreamingText: View {
    let content: String

    var body: some View {
        Markdown(content)
            .markdownTheme(.dusk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
