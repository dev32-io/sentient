import CoreGraphics
import MobileData

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
    static let slateRadialStartRadius: CGFloat = 0
    static let slateRadialEndRadius: CGFloat = 80
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
    static let slateMutedInk = 0.08
    static let slateContactY: CGFloat = 2
    static let slateCastY: CGFloat = 9
    static let slateCastBlur: CGFloat = 15
    static let slateEmberY: CGFloat = 12
    static let slateEmberBlur: CGFloat = 20

    // well-face / well-shadow / well-shadow-focus
    static let wellMiddleStop = 0.56
    static let wellTopBlack = 0.05
    static let wellBottomElevated = 0.10
    static let wellInsetOpacity = 0.72
    static let wellInsetFocusOpacity = 0.76
    static let wellInsetHeight: CGFloat = 6
    static let wellBottomHighlightFocused = 0.08
    static let wellBottomHighlight = 0.07
    static let wellFocusMix = 0.44
    static let wellLineOpacity = 0.45
    static let wellFocusRingOpacity = 0.18
    static let wellFocusCastOpacity = 0.48
    static let wellFocusCastY: CGFloat = 8
    static let wellFocusCastBlur: CGFloat = 18

    // plate-shadow / float-shadow
    static let plateCastY: CGFloat = 18
    static let plateCastBlur: CGFloat = 30
    static let floatCastY: CGFloat = 28
    static let floatCastBlur: CGFloat = 58
    static let floatEmberY: CGFloat = 24
    static let floatEmberBlur: CGFloat = 40

    // Slate native interaction states
    static let slateTopLightContrast = 0.13
    static let slatePressedTop = 0.42
    static let slatePressedBlack = 0.88
    static let slateRestBlack = 0.90
    static let slateDisabledBlack = 0.70
    static let slatePressedShadowRadius: CGFloat = 6
    static let slatePressedShadowY: CGFloat = 3
    static let slateActionGlow = 0.58
    static let slateDestructiveGlow = 0.72
    static let slateQuietGlow = 0.42
    static let slateDisabledBorder = 0.74
    static let slateDestructiveBorder = 0.76
    static let slateActionBorder = 0.64
    static let slateDestructivePressedContact = 0.30
    static let slateDestructiveContact = 0.38
    static let slatePressedContactOpacity = 0.90
    static let slateContactOpacity = 0.88
    static let slateElevatedTopLight = 0.10
    static let slateTopLightOpacity = 0.05
    static let slateElevatedContact = 0.86
    static let plateContactOpacity = 0.45
    static let slateElevatedContactY: CGFloat = 3
    static let slateRestContactY: CGFloat = 2
    static let slateElevatedBlack = 0.96
    static let slateElevatedEmber = 0.38
    static let slateNoEmber = 0.0
    static let selectDisabledOpacity = 0.5

    // User avatar native geometry
    static let avatarGlyphRatio = 0.34
    static let avatarGradientStartRadius: CGFloat = 1
    static let avatarSelectedBorder: CGFloat = 3
    static let avatarShadowOpacity = 0.72
    static let avatarShadowRadius: CGFloat = 8
    static let avatarShadowY: CGFloat = 5
    static let avatarDisabledOpacity = 0.48
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
enum DesignTypographyAdapter {
    static let displayFamily = nativeFamily(MobileData.Fonts_.shared.display)
    static let uiFamily = nativeFamily(MobileData.Fonts_.shared.ui)
    static let monoFamily = nativeFamily(MobileData.Fonts_.shared.mono)

    static func nativeFamily(_ fallbackList: String) -> String {
        fallbackList
            .split(separator: ",", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            ?? fallbackList.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
