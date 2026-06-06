// ---------------------------------------------------------------------------
// Tokens — SwiftUI-side mapping of the SDK's non-color design tokens.
//
// The SDK owns Space/Radii/TypeScale/Motion as plain Int (dp/ms) / Double
// (sp / line-height) constants in its `Space`/`Radii`/`TypeScale`/`Motion`
// Kotlin objects. SKIE exposes each as a class read via its companion
// (`Space.shared.md`), with the Kotlin `Int` bridged to `Int32` and `Double`
// to `Double`. This file converts them to SwiftUI `CGFloat` ONCE, here, so
// views read typed values and never reach back into the SDK constants —
// mirroring the Android `SentientTokens` bundle (theme/Tokens.kt).
// ---------------------------------------------------------------------------
import CoreGraphics
import MobileData

/// Spacing scale in points, mapped from the SDK's `Space` (px → pt 1:1).
enum Space {
    static let xs = cg(MobileData.Space.shared.xs)
    static let sm = cg(MobileData.Space.shared.sm)
    static let md = cg(MobileData.Space.shared.md)
    static let lg = cg(MobileData.Space.shared.lg)
    static let xl = cg(MobileData.Space.shared.xl)
    static let xxl = cg(MobileData.Space.shared.xxl)
    static let xxxl = cg(MobileData.Space.shared.xxxl)
    static let padMsg = cg(MobileData.Space.shared.padMsg)
    static let gapMsg = cg(MobileData.Space.shared.gapMsg)
    static let msgMax = cg(MobileData.Space.shared.msgMax)
}

/// Corner-radius scale in points, mapped from the SDK's `Radii`.
enum Radii {
    static let sm = cg(MobileData.Radii.shared.sm)
    static let md = cg(MobileData.Radii.shared.md)
    static let lg = cg(MobileData.Radii.shared.lg)
    static let xl = cg(MobileData.Radii.shared.xl)
    static let pill = cg(MobileData.Radii.shared.pill)
}

/// Font sizes (points) + unitless line-height multipliers, from `TypeScale`.
enum TypeScale {
    static let xs = CGFloat(MobileData.TypeScale.shared.xs)
    static let sm = CGFloat(MobileData.TypeScale.shared.sm)
    static let base = CGFloat(MobileData.TypeScale.shared.base)
    static let lg = CGFloat(MobileData.TypeScale.shared.lg)
    static let xl = CGFloat(MobileData.TypeScale.shared.xl)
    static let display = CGFloat(MobileData.TypeScale.shared.display)
    static let lineTight = CGFloat(MobileData.TypeScale.shared.lineTight)
    static let lineNormal = CGFloat(MobileData.TypeScale.shared.lineNormal)
    static let lineRelaxed = CGFloat(MobileData.TypeScale.shared.lineRelaxed)
}

/// Motion durations in seconds, converted from the SDK's millisecond `Motion`.
enum Motion {
    static let fast = seconds(MobileData.Motion.shared.fastMs)
    static let normal = seconds(MobileData.Motion.shared.normalMs)
    static let wave = seconds(MobileData.Motion.shared.waveMs)
    static let cursor = seconds(MobileData.Motion.shared.cursorMs)
}

/// Layout constants for the in-app animated splash overlay.
enum SplashLayout {
    /// Diameter of the SentientMark on the splash screen, in points.
    static let markSize: CGFloat = 96
    /// Minimum time (seconds) the splash is visible on each show.
    static let minDisplay: Double = 2.0
    /// Fade-out duration (seconds); mirrors Motion.normal.
    static let fadeOut: Double = Motion.normal
}

private let msPerSecond = 1000.0

/// SKIE bridges the SDK's Kotlin `Int` constants to Swift `Int32`; widen to CGFloat.
private func cg(_ value: Int32) -> CGFloat { CGFloat(value) }

/// Convert an SDK millisecond duration (`Int32`) to seconds for SwiftUI animation APIs.
private func seconds(_ ms: Int32) -> Double { Double(ms) / msPerSecond }
