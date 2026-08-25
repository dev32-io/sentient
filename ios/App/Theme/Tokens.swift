import CoreGraphics
import MobileData

/// Compatibility projections. Existing pages keep these names while receiving
/// the additive v2 values; v1 remains untouched in KMP for Android consumers.
enum Space {
    static let xs = DesignV2.Spacing.xs
    static let sm = DesignV2.Spacing.sm
    static let md = DesignV2.Spacing.md
    static let lg = DesignV2.Spacing.lg
    static let xl = DesignV2.Spacing.xl
    static let xxl = DesignV2.Spacing.xxl
    static let xxxl = DesignV2.Spacing.xxxl
    // Structural chat geometry is not part of v2; retain the existing named v1 values.
    static let padMsg = CGFloat(MobileData.Space.shared.padMsg)
    static let gapMsg = CGFloat(MobileData.Space.shared.gapMsg)
    static let msgMax = CGFloat(MobileData.Space.shared.msgMax)
}

enum Radii {
    static let sm = DesignV2.Radius.sm
    static let md = DesignV2.Radius.md
    static let lg = DesignV2.Radius.lg
    static let xl = DesignV2.Radius.xl
    static let pill = DesignV2.Radius.pill
}

enum TypeScale {
    static let xs = DesignV2.Typography.xs
    static let sm = DesignV2.Typography.supporting
    static let base = DesignV2.Typography.body
    static let lg = DesignV2.Typography.large
    static let xl = DesignV2.Typography.title
    static let display = DesignV2.Typography.display
    static let lineTight = DesignV2.Typography.lineTight
    static let lineNormal = DesignV2.Typography.lineNormal
    static let lineRelaxed = DesignV2.Typography.lineRelaxed
}

enum Motion {
    static let fast = DesignV2.Motion.feedback
    static let normal = DesignV2.Motion.state
    // Domain-specific animation cadences remain on their existing named contract.
    static let wave = Double(MobileData.Motion.shared.waveMs) / 1_000
    static let cursor = Double(MobileData.Motion.shared.cursorMs) / 1_000
}

enum SplashLayout {
    static let markSize: CGFloat = 96
    static let minDisplay: Double = 1.5
    static let fadeOut: Double = Motion.normal
}
