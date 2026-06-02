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
import MobileSdk

/// Spacing scale in points, mapped from the SDK's `Space` (px → pt 1:1).
enum Space {
    static let xs = cg(MobileSdk.Space.shared.xs)
    static let sm = cg(MobileSdk.Space.shared.sm)
    static let md = cg(MobileSdk.Space.shared.md)
    static let lg = cg(MobileSdk.Space.shared.lg)
    static let xl = cg(MobileSdk.Space.shared.xl)
    static let xxl = cg(MobileSdk.Space.shared.xxl)
    static let xxxl = cg(MobileSdk.Space.shared.xxxl)
    static let padMsg = cg(MobileSdk.Space.shared.padMsg)
    static let gapMsg = cg(MobileSdk.Space.shared.gapMsg)
    static let msgMax = cg(MobileSdk.Space.shared.msgMax)
}

/// Corner-radius scale in points, mapped from the SDK's `Radii`.
enum Radii {
    static let sm = cg(MobileSdk.Radii.shared.sm)
    static let md = cg(MobileSdk.Radii.shared.md)
    static let lg = cg(MobileSdk.Radii.shared.lg)
    static let xl = cg(MobileSdk.Radii.shared.xl)
    static let pill = cg(MobileSdk.Radii.shared.pill)
}

/// Font sizes (points) + unitless line-height multipliers, from `TypeScale`.
enum TypeScale {
    static let xs = CGFloat(MobileSdk.TypeScale.shared.xs)
    static let sm = CGFloat(MobileSdk.TypeScale.shared.sm)
    static let base = CGFloat(MobileSdk.TypeScale.shared.base)
    static let lg = CGFloat(MobileSdk.TypeScale.shared.lg)
    static let xl = CGFloat(MobileSdk.TypeScale.shared.xl)
    static let display = CGFloat(MobileSdk.TypeScale.shared.display)
    static let lineTight = CGFloat(MobileSdk.TypeScale.shared.lineTight)
    static let lineNormal = CGFloat(MobileSdk.TypeScale.shared.lineNormal)
    static let lineRelaxed = CGFloat(MobileSdk.TypeScale.shared.lineRelaxed)
}

/// Motion durations in seconds, converted from the SDK's millisecond `Motion`.
enum Motion {
    static let fast = seconds(MobileSdk.Motion.shared.fastMs)
    static let normal = seconds(MobileSdk.Motion.shared.normalMs)
    static let wave = seconds(MobileSdk.Motion.shared.waveMs)
    static let cursor = seconds(MobileSdk.Motion.shared.cursorMs)
}

private let msPerSecond = 1000.0

/// SKIE bridges the SDK's Kotlin `Int` constants to Swift `Int32`; widen to CGFloat.
private func cg(_ value: Int32) -> CGFloat { CGFloat(value) }

/// Convert an SDK millisecond duration (`Int32`) to seconds for SwiftUI animation APIs.
private func seconds(_ ms: Int32) -> Double { Double(ms) / msPerSecond }
