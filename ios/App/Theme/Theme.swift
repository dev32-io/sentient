// ---------------------------------------------------------------------------
// Theme — the Dusk surface applied to the SwiftUI hierarchy.
//
// Dusk is a dark-only brand palette (DuskColors), so the theme forces a dark
// color scheme, paints the root background with the SDK `bg` token, and tints
// the accent. Mirrors the Android SentientTheme role (theme/Theme.kt): one
// fixed brand surface, no light variant, no dynamic color. Screens wrap their
// content in `.duskTheme()` so the palette + scheme are consistent.
// ---------------------------------------------------------------------------
import SwiftUI

private struct DuskTheme: ViewModifier {
    func body(content: Content) -> some View {
        content
            .tint(DuskColors.accent)
            .background(DuskColors.bg.ignoresSafeArea())
            .preferredColorScheme(.dark)
    }
}

extension View {
    /// Apply the Dusk dark brand surface (background + accent tint + dark scheme).
    func duskTheme() -> some View { modifier(DuskTheme()) }
}
