// ---------------------------------------------------------------------------
// Typo — design font tokens.
//
// Family names are sourced from the shared SDK (MobileData.Fonts) so iOS,
// Android, and webui agree on the same strings. The registered PostScript /
// family names must match the bundled .ttf files in App/Resources/Fonts/.
// Falls back to the system font if a family is missing so the UI never
// renders blank.
//
// SKIE bridges the Kotlin `object Fonts` as a class accessed via `.shared`;
// each `const val` becomes a readonly `String` property — same pattern as
// `MobileData.Space.shared.xs` in Tokens.swift.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

enum Typo {
    /// Brand display / wordmark — Fraunces (serif). Default weight: semibold.
    static func display(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom(MobileData.Fonts.shared.display, size: size).weight(weight)
    }

    /// Body / UI text — DM Sans (sans-serif). Default weight: regular.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(MobileData.Fonts.shared.ui, size: size).weight(weight)
    }

    /// Monospace — JetBrains Mono. Used for tool argsPreview / code.
    static func mono(_ size: CGFloat) -> Font {
        .custom(MobileData.Fonts.shared.mono, size: size)
    }
}
