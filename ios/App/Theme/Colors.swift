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
import MobileData

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

    // Derived. User chat-bubble fill = sage mixed 16% into paper, approximating
    // the webui color-mix(in oklab, sage 16%, paper) and matching the Android
    // `lerp(paper, sage, 0.16)`. Lerped on the raw ARGB tokens so the iOS-17
    // deployment target holds (Color.mix is iOS 18+).
    static let userBubble = lerpColor(Colors.shared.paper, Colors.shared.sage, 0.16)
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

/// Linear-interpolate between two packed-ARGB tokens at fraction `t` (0 = `from`,
/// 1 = `to`), per channel, returning a SwiftUI `Color`. Mirrors the Android
/// `lerp(from, to, t)` used for the user-bubble fill.
private func lerpColor(_ from: Int64, _ to: Int64, _ t: Double) -> Color {
    func channel(_ argb: Int64, _ shift: Int64) -> Double {
        Double((argb >> shift) & argbByteMask) / argbMaxChannel
    }
    func mix(_ shift: Int64) -> Double {
        channel(from, shift) + (channel(to, shift) - channel(from, shift)) * t
    }
    return Color(
        .sRGB,
        red: mix(argbRedShift),
        green: mix(argbGreenShift),
        blue: mix(0),
        opacity: mix(argbAlphaShift)
    )
}
