// ---------------------------------------------------------------------------
// SentientMark — the Sentient brand atom. ALWAYS static.
//
// Art is the ONE shared asset (SentientMark.imageset, rasterized from
// gateway/webui/public/sentient-mark.svg via scripts/gen-brand-assets.sh — the
// same SVG webui renders). No hand-drawn gradients, no animation here.
//
// The "Sentient is active" ripple is NOT part of the mark — it's a separate
// `AvatarRipple` overlay applied ONLY at the chat assistant avatar (see
// MessageBubble) + the splash. The top bar / any other mark stays static.
//
// `mode` is accepted for call-site compatibility (callers pass the cognition
// mode) but does not affect rendering — the mark is the same image in every mode.
// ---------------------------------------------------------------------------
import SwiftUI

/// Renders the static Sentient mark at `size`. `mode` is ignored (see file note).
struct SentientMark: View {
    var size: CGFloat = SentientMarkLayout.defaultSize
    var mode: MarkMode = .idle

    var body: some View {
        Image("SentientMark")
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Mark sizing. Atom geometry itself lives in the SVG.
enum SentientMarkLayout {
    static let defaultSize: CGFloat = 28
}

#Preview {
    VStack(spacing: 28) {
        SentientMark(size: 96)
        SentientMark(size: 28)
    }
    .padding(64)
    .background(Color(.sRGB, red: 0.169, green: 0.149, blue: 0.129, opacity: 1)) // #2B2621
}
