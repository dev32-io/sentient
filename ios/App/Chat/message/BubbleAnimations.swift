// ---------------------------------------------------------------------------
// Pre-first-token thinking pulse. Text uses MessageDocumentSurface in all phases.
// ---------------------------------------------------------------------------
import SwiftUI

/// Three-dot thinking pulse — mirrors the Android PulseDots / webui PlaceholderPulse.
struct PulseDots: View {
    @State private var pulsing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var bodyLineHeight =
        DesignTextRole.body.baseSize * CGFloat(DesignTextRole.body.lineHeight)

    var body: some View {
        HStack(spacing: BubbleLayout.pulseGap) {
            ForEach(0..<3, id: \.self) { _ in
                Circle()
                    .fill(DuskColors.accent)
                    .frame(width: BubbleLayout.pulseDot, height: BubbleLayout.pulseDot)
                    .opacity(reduceMotion || pulsing ? 1 : 0.3)
                    .scaleEffect(reduceMotion ? 1 : (pulsing ? 1.1 : 0.9))
                    .animation(
                        reduceMotion ? nil : .easeInOut(duration: BubbleLayout.pulseDuration / 2)
                            .repeatForever(),
                        value: pulsing
                    )
            }
        }
        .frame(height: bodyLineHeight, alignment: .leading)
        .onAppear { pulsing = !reduceMotion }
        .onChange(of: reduceMotion) { _, reduced in pulsing = !reduced }
        .accessibilityLabel("Assistant is thinking")
    }
}
