// ---------------------------------------------------------------------------
// Colors — the Dusk palette projected from the shared SDK tokens into SwiftUI.
//
// The single source of truth is `MobileSdk`'s `Colors` Kotlin object (const
// ARGB Longs, 0xFFRRGGBB). SKIE exposes that object to Swift as the class
// `Colors` whose constants read back as `Int64` (the bridged Kotlin `Long`),
// accessed via the companion: `Colors.shared.bg`. This file converts each
// packed-ARGB Int64 into a SwiftUI `Color` ONCE so views read typed values and
// never touch the raw SDK constants. Dusk is a dark-only brand palette — there
// is no light variant.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

/// The Dusk palette as SwiftUI `Color`s, mapped from the SDK's `Colors` tokens.
///
/// Mirrors the Android `DuskColorScheme` mapping (theme/Theme.kt): same token →
/// role intent, just expressed as a flat namespace instead of a Material
/// `ColorScheme`. SwiftUI has no Material slot model, so the raw token names are
/// preserved and views pick the role they need.
enum DuskColors {
    // Surfaces — layered bg depth.
    static let bg = color(Colors.shared.bg)
    static let bgElev = color(Colors.shared.bgElev)
    static let bgSunk = color(Colors.shared.bgSunk)
    static let paper = color(Colors.shared.paper)

    // Lines.
    static let line = color(Colors.shared.line)
    static let lineSoft = color(Colors.shared.lineSoft)

    // Ink (text).
    static let ink = color(Colors.shared.ink)
    static let ink2 = color(Colors.shared.ink2)
    static let ink3 = color(Colors.shared.ink3)
    static let ink4 = color(Colors.shared.ink4)

    // Accents.
    static let accent = color(Colors.shared.accent)
    static let accentSoft = color(Colors.shared.accentSoft)
    static let accent50 = color(Colors.shared.accent50)
    static let amber = color(Colors.shared.amber)
    static let sage = color(Colors.shared.sage)
    static let sageSoft = color(Colors.shared.sageSoft)
    static let clay = color(Colors.shared.clay)

    // Status.
    static let ok = color(Colors.shared.ok)
    static let warn = color(Colors.shared.warn)
    static let stop = color(Colors.shared.stop)
}

private let argbByteMask: Int64 = 0xFF
private let argbMaxChannel = 255.0
private let argbAlphaShift: Int64 = 24
private let argbRedShift: Int64 = 16
private let argbGreenShift: Int64 = 8

/// Convert a packed-ARGB SDK token (`Int64`, 0xFFRRGGBB) into a SwiftUI `Color`.
/// Channels are normalised to the 0...1 range the sRGB initializer expects.
private func color(_ argb: Int64) -> Color {
    let alpha = Double((argb >> argbAlphaShift) & argbByteMask) / argbMaxChannel
    let red = Double((argb >> argbRedShift) & argbByteMask) / argbMaxChannel
    let green = Double((argb >> argbGreenShift) & argbByteMask) / argbMaxChannel
    let blue = Double(argb & argbByteMask) / argbMaxChannel
    return Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
}
