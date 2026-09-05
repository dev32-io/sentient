import CoreGraphics
import MobileData
import SwiftUI

/// The native material projection keeps the generated KMP recipe attached to the
/// SwiftUI recipe it drives. SwiftUI cannot consume CSS gradients or shadows
/// directly, so the component layer uses the native values below while this
/// adapter remains the single role-to-recipe mapping.
struct DesignMaterialNativeProjection: Equatable {
    enum Kind: String, CaseIterable {
        case slateFace
        case slateFaceHover
        case slateFaceMuted
        case slateTopLight
        case slateContact
        case slateCast
        case slateEmberCast
        case slateShadow
        case slateShadowHover
        case slateShadowPressed
        case slateShadowDisabled
        case wellFace
        case wellShadow
        case wellShadowFocus
        case plateShadow
        case floatShadow
    }

    let role: DesignV2.MaterialRole
    let kind: Kind
    let contractRecipe: String
}

/// Native values translated once from the reviewed KMP material recipes.
///
/// The numeric values are adaptation details, not a second token source: each
/// role is still identified by `DesignV2.MaterialRole`, whose recipe comes from
/// the generated MobileData projection.
enum DesignMaterialAdapter {
    static func nativeProjection(for role: DesignV2.MaterialRole) -> DesignMaterialNativeProjection {
        DesignMaterialNativeProjection(role: role, kind: kind(for: role), contractRecipe: role.contractRecipe)
    }

    static func kind(for role: DesignV2.MaterialRole) -> DesignMaterialNativeProjection.Kind {
        switch role {
        case .slateFace: .slateFace
        case .slateFaceHover: .slateFaceHover
        case .slateFaceMuted: .slateFaceMuted
        case .slateTopLight: .slateTopLight
        case .slateContact: .slateContact
        case .slateCast: .slateCast
        case .slateEmberCast: .slateEmberCast
        case .slateShadow: .slateShadow
        case .slateShadowHover: .slateShadowHover
        case .slateShadowPressed: .slateShadowPressed
        case .slateShadowDisabled: .slateShadowDisabled
        case .wellFace: .wellFace
        case .wellShadow: .wellShadow
        case .wellShadowFocus: .wellShadowFocus
        case .plateShadow: .plateShadow
        case .floatShadow: .floatShadow
        }
    }

    // slate-face / slate-face-hover
    static let slateRadialScale = CGSize(width: 0.82, height: 1.05)
    static let slateRadialCenterX = 0.5
    static let slateRadialCenterY = 0.52
    static let slateRadialStartRadiusFraction: CGFloat = 0
    static let slateRadialEndRadiusFraction: CGFloat = 1
    static let slateCenterStop = 0.42
    static let slateMutedFadeStop = 0.74
    static let slateFadeStop = 0.76
    static let slateCenterSunk = 0.20
    static let slateMutedCenterSunk = 0.16
    static let slateHoverCenterSunk = 0.23
    static let slateRingSunk = 0.12
    static let slateHoverRingSunk = 0.14
    static let slateTopLight = 0.07
    static let slateMutedBaseLight = 0.03
    static let slateBaseLight = 0.04
    static let slateHoverBaseLight = 0.06
    static let slateHoverGlow = 0.03
    static let slateDestructiveOverlay = 0.38
    static let slateContactY: CGFloat = 2
    static let slateCastY: CGFloat = 9
    static let slateCastBlur: CGFloat = 15
    static let slateCastInset: CGFloat = 10
    static let slateEmberY: CGFloat = 12
    static let slateEmberBlur: CGFloat = 20
    static let slateEmberInset: CGFloat = 16

    // well-face / well-shadow / well-shadow-focus. Inner occlusion uses
    // SwiftUI's native ShapeStyle inner shadow; this project targets iOS 18,
    // while the API has been available since iOS 16.
    static let wellMiddleStop = 0.56
    static let wellTopBlack = 0.05
    static let wellBottomElevated = 0.10
    static let wellInsetOpacity = 0.72
    static let wellInsetFocusOpacity = 0.76
    static let wellInsetBlur: CGFloat = 3
    static let wellInsetY: CGFloat = 3
    static let wellBottomHighlightFocused = 0.05
    static let wellBottomHighlight = 0.04
    static let wellFocusMix = 0.44
    static let wellLineOpacity = 0.45
    static let wellLineY: CGFloat = 1
    static let wellFocusRingOpacity = 0.18
    static let wellFocusCastOpacity = 0.48
    static let wellFocusCastY: CGFloat = 8
    static let wellFocusCastBlur: CGFloat = 4

    // Canonical Canvas well recipe. These values intentionally coexist with
    // the legacy SwiftUI well adaptations above until later migration waves
    // move reviewed consumers individually.
    static let wellCSSMiddleStop: CGFloat = 0.56
    static let wellCSSTopBlack = 0.05
    static let wellCSSBottomElevated = 0.10
    static let wellCSSInsetOpacity = 0.72
    static let wellCSSInsetFocusOpacity = 0.76
    static let wellCSSInsetBlur: CGFloat = 6
    static let wellCSSInsetSpread: CGFloat = -2
    static let wellCSSInsetY: CGFloat = 3
    static let wellCSSBottomReflection = 0.07
    static let wellCSSBottomReflectionFocused = 0.08
    static let wellCSSBottomReflectionY: CGFloat = -1
    static let wellCSSFocusLineMix = 0.44
    static let wellCSSContactOpacity = 0.45
    static let wellCSSContactY: CGFloat = 1
    static let wellCSSHaloSpread: CGFloat = 3
    static let wellCSSFocusHaloOpacity = 0.18
    static let wellCSSFocusCastOpacity = 0.48
    static let wellCSSFocusCastBlur: CGFloat = 18
    static let wellCSSFocusCastY: CGFloat = 8
    static let wellCSSFocusCastSpread: CGFloat = -14
    static let wellCSSFocusOutlineWidth: CGFloat = 2
    static let wellCSSFocusOutlineOffset: CGFloat = 3
    static let wellValidatedErrorLineMix = 0.30
    static let wellValidatedErrorHaloOpacity = 0.14

    // Selection/range Canvas profiles. These are implementation projections
    // of the reviewed foundation CSS, not button-role aliases: their compact
    // faces and receivers differ materially from the canonical 40pt key.
    static let smallControlMaximumOverflow: CGFloat = 48
    static let smallControlMinimumSourcePixels: CGFloat = 1
    static let smallControlSelectionTravelDuration = 0.22
    static let smallControlTravelCurveX1 = 0.20
    static let smallControlTravelCurveY1 = 0.80
    static let smallControlTravelCurveX2 = 0.20
    static let smallControlTravelCurveY2 = 1.00

    // 34pt raised chip and selected receiver.
    static let chipVisualHeight: CGFloat = 34
    static let chipCastOpacity = 0.90
    static let chipCastBlur: CGFloat = 12
    static let chipCastY: CGFloat = 7
    static let chipCastInset: CGFloat = 10
    static let chipContactY: CGFloat = 1
    static let chipSelectedGlowOpacity = 0.58
    static let chipSelectedGlowBlur: CGFloat = 16
    static let chipSelectedGlowY: CGFloat = 8
    static let chipSelectedGlowInset: CGFloat = 14
    static let chipSelectedPressedInsetOpacity = 0.78
    static let chipSelectedPressedInsetBlur: CGFloat = 7
    static let chipSelectedPressedInsetY: CGFloat = 4
    static let chipSelectedPressedInsetSpread: CGFloat = -2

    // Generic selected compact receiver. Unlike the capsule-only selected-chip
    // profile, this preserves the existing radius-sm rounded-rectangle style.
    static let selectedCompactRestCastOpacity = 0.40
    static let selectedCompactRestCastBlur: CGFloat = 16
    static let selectedCompactRestCastY: CGFloat = 8
    static let selectedCompactRestCastInset: CGFloat = 14
    static let selectedCompactContactOpacity = 0.88
    static let selectedCompactContactY: CGFloat = 1
    static let selectedCompactContactInset: CGFloat = 1

    // 30pt segment selection slate.
    static let segmentSelectionHeight: CGFloat = 30
    static let segmentSelectionBorderAccentMix = 0.22

    // 44x28 toggle track and 18pt knob.
    static let toggleKnobInset: CGFloat = 4
    static let toggleTrackBorderAccentMix = 0.52
    static let toggleTrackOnTopAccentSoftMix = 0.80
    static let toggleTrackGlowOpacity = 0.58
    static let toggleTrackGlowBlur: CGFloat = 16
    static let toggleTrackGlowY: CGFloat = 8
    static let toggleTrackGlowInset: CGFloat = 14
    static let toggleKnobOffBorderLineMix = 0.80

    // 22pt binary checkbox receiver/checked slate. Mixed-state visuals remain
    // unavailable until a product value owner is admitted.
    static let checkboxCheckedBorderAccentMix = 0.48
    static let checkboxCheckedLinearInkMix = 0.06
    static let checkboxCheckedRadialSunkMix = 0.22
    static let compactCircularRadialCenterX: CGFloat = 0.50
    static let compactCircularRadialCenterY: CGFloat = 0.55
    static let checkboxCheckedRadialFadeStop: CGFloat = 0.72
    static let checkboxCastOpacity = 0.90
    static let checkboxCastBlur: CGFloat = 12
    static let checkboxCastY: CGFloat = 7
    static let checkboxCastInset: CGFloat = 10
    static let checkboxGlowOpacity = 0.50
    static let checkboxGlowBlur: CGFloat = 15
    static let checkboxGlowY: CGFloat = 9
    static let checkboxGlowInset: CGFloat = 12

    // 8pt slider track and 26pt graphite thumb.
    static let sliderProgressAccentMix = 0.58
    static let sliderThumbLinearInkMix = 0.05
    static let sliderThumbRadialSunkMix = 0.22
    static let sliderThumbRadialFadeStop: CGFloat = 0.72
    static let sliderThumbGlowOpacity = 0.44
    static let sliderThumbGlowBlur: CGFloat = 16
    static let sliderThumbGlowY: CGFloat = 10
    static let sliderThumbGlowInset: CGFloat = 13
    static let sliderDisabledSaturation = 0.30
    static let sliderDisabledOpacity = 0.58

    // plate-shadow / float-shadow. CSS negative spread is represented as an
    // inset shadow source shape rather than by changing blur until it looks
    // approximately right.
    static let plateInnerLightBlur: CGFloat = 0.5
    static let plateInnerLightY: CGFloat = 1
    static let plateCastY: CGFloat = 18
    static let plateCastBlur: CGFloat = 30
    static let plateCastInset: CGFloat = 22
    static let floatCastY: CGFloat = 28
    static let floatCastBlur: CGFloat = 58
    static let floatCastInset: CGFloat = 22
    static let floatEmberY: CGFloat = 24
    static let floatEmberBlur: CGFloat = 40
    static let floatEmberInset: CGFloat = 30

    // Action-button adaptations of the reviewed CSS recipes. These values keep
    // variant-specific color mixes and shadow layers in the shared material
    // projection instead of scattering them through individual controls.
    static let slateSecondaryInkMix = 0.09
    static let slateQuietBorderBackgroundMix = 0.16
    static let slateDisabledBaseInkMix = 0.08
    static let slateActionRestBlack = 0.92
    static let slateTopLightRest = 0.07
    static let slateActionTopLight = 0.24
    static let slateDestructiveTopLight = 0.13
    static let slateHoverTopLight = 0.13
    static let slateDestructiveHoverTopLight = 0.16
    static let slateDisabledTopLight = 0.05
    static let slateDisabledContactMix = 0.28
    static let slateDisabledContactY: CGFloat = 1
    static let slatePressedBlack = 0.88
    static let slateRestBlack = 0.90
    static let slateDisabledBlack = 0.70
    static let slateDisabledShadowRadius: CGFloat = 9
    static let slateDisabledShadowY: CGFloat = 5
    static let slateDisabledShadowInset: CGFloat = 8
    static let slatePressedShadowRadius: CGFloat = 6
    static let slatePressedShadowY: CGFloat = 3
    static let slatePressedShadowInset: CGFloat = 5
    static let slateHoverShadowRadius: CGFloat = 18
    static let slateHoverShadowY: CGFloat = 11
    static let slateHoverShadowInset: CGFloat = 10
    static let slateHoverEmberBlur: CGFloat = 22
    static let slateHoverEmberY: CGFloat = 14
    static let slateHoverEmberInset: CGFloat = 14
    static let slateHoverBlack = 0.94
    static let slateDestructiveGlowBlur: CGFloat = 22
    static let slateDestructiveGlowY: CGFloat = 13
    static let slateDestructiveGlowInset: CGFloat = 14
    // Glow alpha can follow the reviewed recipe because the inset source now
    // supplies the negative spread that keeps it localized.
    static let slateDefaultGlow = 0.42
    static let slateActionGlow = 0.58
    static let slateSecondaryGlow = slateDefaultGlow
    static let slateDestructiveGlow = 0.72
    static let slateQuietGlow = slateDefaultGlow
    static let slateHoverGlowOpacity = 0.48
    static let slateDestructiveHoverGlowOpacity = 0.78
    static let slateSecondaryContactMix = 0.12
    static let slateActionContactMix = 0.22
    static let slateDestructiveContactMix = 0.38
    static let slateInteractiveContactMix = 0.10
    static let slateDestructiveHoverContactMix = 0.46
    static let slatePressedInsetOpacity = 0.42
    static let slatePressedInsetBlur: CGFloat = 3
    static let slatePressedInsetY: CGFloat = 2
    static let slateDisabledBorder = 0.74
    static let slateDestructiveBorder = 0.76
    static let slateActionBorder = 0.64
    static let slateContactOpacity = 0.88
    static let slateElevatedTopLight = 0.10
    static let slateTopLightOpacity = 0.05
    static let slateElevatedContact = 0.86
    static let plateElevatedContactMix = 0.14
    static let plateRestContactMix = 0.22
    static let slateElevatedContactY: CGFloat = 3
    static let slateRestContactY: CGFloat = 2
    static let slateElevatedBlack = 0.96
    static let slateElevatedEmber = 0.38

    // Common composite media-card adaptation. Rest uses the quiet plate
    // surface; pointer hover tightens the face toward the sunk canvas.
    static let mediaCardElevatedMix = 0.12
    static let mediaCardHoverSunkMix = 0.18
    static let mediaCardHoverContactMix = 0.10
    static let mediaCardHoverBlack = 0.94
    static let mediaCardHoverShadowRadius: CGFloat = 28
    static let mediaCardHoverShadowInset: CGFloat = 23
    static let mediaCardRestBlack = 0.90
    static let selectDisabledOpacity = 0.5

    // User avatar native geometry
    static let avatarGradientStartRadius: CGFloat = 1
    static let avatarSelectedBorder: CGFloat = 4
    static let avatarShadowOpacity = 0.90
    static let avatarShadowRadius: CGFloat = 1.5
    static let avatarShadowY: CGFloat = 6
    static let avatarDisabledOpacity = 0.58
}

/// Compatibility name for tests and older component call sites. It only
/// forwards to the adapter; material values are not re-declared here.
enum DesignMaterialMetrics {
    static let slateRadialScale = DesignMaterialAdapter.slateRadialScale
    static let slateRadialCenterY = DesignMaterialAdapter.slateRadialCenterY
    static let slateCenterStop = DesignMaterialAdapter.slateCenterStop
    static let slateFadeStop = DesignMaterialAdapter.slateFadeStop
    static let slateCenterSunk = DesignMaterialAdapter.slateCenterSunk
    static let slateRingSunk = DesignMaterialAdapter.slateRingSunk
    static let slateTopLight = DesignMaterialAdapter.slateTopLight
    static let slateContactY = DesignMaterialAdapter.slateContactY
    static let slateCastY = DesignMaterialAdapter.slateCastY
    static let slateCastBlur = DesignMaterialAdapter.slateCastBlur
    static let slateEmberY = DesignMaterialAdapter.slateEmberY
    static let slateEmberBlur = DesignMaterialAdapter.slateEmberBlur
    static let wellMiddleStop = DesignMaterialAdapter.wellMiddleStop
    static let wellTopBlack = DesignMaterialAdapter.wellTopBlack
    static let wellBottomElevated = DesignMaterialAdapter.wellBottomElevated
    static let wellInsetOpacity = DesignMaterialAdapter.wellInsetOpacity
    static let plateCastY = DesignMaterialAdapter.plateCastY
    static let plateCastBlur = DesignMaterialAdapter.plateCastBlur
    static let floatCastY = DesignMaterialAdapter.floatCastY
    static let floatCastBlur = DesignMaterialAdapter.floatCastBlur
}

/// Generated KMP typography families are fallback lists. SwiftUI needs the
/// first installed family, so this is the only native family projection.
extension Color {
    /// Mirrors CSS `color-mix(in oklab, …)` with SwiftUI's perceptual color
    /// interpolation instead of component-wise UIKit sRGB interpolation.
    func overlaying(_ overlay: Color, opacity: Double) -> Color {
        mix(with: overlay, by: opacity, in: .perceptual)
    }
}

/// Geometry for a CSS-style drop shadow with negative spread. SwiftUI's view
/// shadow has no spread parameter, so renderers draw the source shape inset by
/// this amount before applying the native blur and offset.
struct DesignDropShadowGeometry: Equatable {
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat
    let sourceInset: CGFloat

    init(radius: CGFloat, x: CGFloat = 0, y: CGFloat, sourceInset: CGFloat) {
        self.radius = radius
        self.x = x
        self.y = y
        self.sourceInset = sourceInset
    }
}

enum DesignMaterialShadowGeometry {
    static let slateRest = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateCastBlur,
        y: DesignMaterialAdapter.slateCastY,
        sourceInset: DesignMaterialAdapter.slateCastInset
    )
    static let slateGlow = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateEmberBlur,
        y: DesignMaterialAdapter.slateEmberY,
        sourceInset: DesignMaterialAdapter.slateEmberInset
    )
    static let slateActionGlow = DesignDropShadowGeometry(
        radius: 22,
        y: 13,
        sourceInset: 13
    )
    static let slateDestructiveGlow = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateDestructiveGlowBlur,
        y: DesignMaterialAdapter.slateDestructiveGlowY,
        sourceInset: DesignMaterialAdapter.slateDestructiveGlowInset
    )
    static let slateDestructiveHoverGlow = DesignDropShadowGeometry(
        radius: 24,
        y: 14,
        sourceInset: 13
    )
    static let slateHover = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateHoverShadowRadius,
        y: DesignMaterialAdapter.slateHoverShadowY,
        sourceInset: DesignMaterialAdapter.slateHoverShadowInset
    )
    static let slateHoverGlow = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateHoverEmberBlur,
        y: DesignMaterialAdapter.slateHoverEmberY,
        sourceInset: DesignMaterialAdapter.slateHoverEmberInset
    )
    static let slatePressed = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slatePressedShadowRadius,
        y: DesignMaterialAdapter.slatePressedShadowY,
        sourceInset: DesignMaterialAdapter.slatePressedShadowInset
    )
    static let slateDisabled = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.slateDisabledShadowRadius,
        y: DesignMaterialAdapter.slateDisabledShadowY,
        sourceInset: DesignMaterialAdapter.slateDisabledShadowInset
    )
    static let plate = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.plateCastBlur,
        y: DesignMaterialAdapter.plateCastY,
        sourceInset: DesignMaterialAdapter.plateCastInset
    )
    static let mediaCardHover = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.mediaCardHoverShadowRadius,
        y: DesignMaterialAdapter.plateCastY,
        sourceInset: DesignMaterialAdapter.mediaCardHoverShadowInset
    )
    static let float = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.floatCastBlur,
        y: DesignMaterialAdapter.floatCastY,
        sourceInset: DesignMaterialAdapter.floatCastInset
    )
    static let floatGlow = DesignDropShadowGeometry(
        radius: DesignMaterialAdapter.floatEmberBlur,
        y: DesignMaterialAdapter.floatEmberY,
        sourceInset: DesignMaterialAdapter.floatEmberInset
    )
}

enum DesignTypographyAdapter {
    static let displayFamily = nativeFamily(MobileData.Fonts_.shared.display)
    static let uiFamily = nativeFamily(MobileData.Fonts_.shared.ui)
    static let uiMediumFace = bundledFace(family: uiFamily, weight: "Medium")
    static let monoFamily = nativeFamily(MobileData.Fonts_.shared.mono)

    static func nativeFamily(_ fallbackList: String) -> String {
        fallbackList
            .split(separator: ",", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            ?? fallbackList.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func bundledFace(family: String, weight: String) -> String {
        "\(family.filter { !$0.isWhitespace })-\(weight)"
    }
}
