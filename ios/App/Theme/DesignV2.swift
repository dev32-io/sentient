import SwiftUI
import MobileData

/// Thin, additive Swift projection of `io.sentient.mobilesdk.design.v2`.
/// Values are intentionally read from MobileData rather than duplicated here.
enum DesignV2 {
    static let version = MobileData.DesignFoundationV2.shared.version
    static let contractSha256 = MobileData.DesignFoundationV2.shared.contractSha256

    enum ColorToken: CaseIterable {
        case bg, elevated, sunk, paper, line, lineSoft
        case ink, inkSecondary, inkTertiary, inkMuted
        case ember, emberSoft, emberDeep, amber, sage, sageSoft, clay
        case ok, warn, stop

        var argb: Int64 {
            let colors = MobileData.Colors_.shared
            return switch self {
            case .bg: colors.bg
            case .elevated: colors.elevated
            case .sunk: colors.sunk
            case .paper: colors.paper
            case .line: colors.line
            case .lineSoft: colors.lineSoft
            case .ink: colors.ink
            case .inkSecondary: colors.inkSecondary
            case .inkTertiary: colors.inkTertiary
            case .inkMuted: colors.inkMuted
            case .ember: colors.ember
            case .emberSoft: colors.emberSoft
            case .emberDeep: colors.emberDeep
            case .amber: colors.amber
            case .sage: colors.sage
            case .sageSoft: colors.sageSoft
            case .clay: colors.clay
            case .ok: colors.ok
            case .warn: colors.warn
            case .stop: colors.stop
            }
        }

        var color: Color { Color(argb: argb) }
    }

    enum Typography {
        static let xs = CGFloat(MobileData.TypeSizes.shared.xs)
        static let supporting = CGFloat(MobileData.TypeSizes.shared.sm)
        static let body = CGFloat(MobileData.TypeSizes.shared.base)
        static let large = CGFloat(MobileData.TypeSizes.shared.lg)
        static let title = CGFloat(MobileData.TypeSizes.shared.xl)
        static let display = CGFloat(MobileData.TypeSizes.shared.display)

        static let lineTight = MobileData.LineHeights.shared.tight
        static let lineNormal = MobileData.LineHeights.shared.normal
        static let lineRelaxed = MobileData.LineHeights.shared.relaxed

        static let displayFamily = DesignTypographyAdapter.displayFamily
        static let uiFamily = DesignTypographyAdapter.uiFamily
        static let monoFamily = DesignTypographyAdapter.monoFamily
    }

    enum Spacing {
        static let xs = CGFloat(MobileData.Spacing.shared.xs)
        static let sm = CGFloat(MobileData.Spacing.shared.sm)
        static let md = CGFloat(MobileData.Spacing.shared.md)
        static let lg = CGFloat(MobileData.Spacing.shared.lg)
        static let xl = CGFloat(MobileData.Spacing.shared.xl)
        static let xxl = CGFloat(MobileData.Spacing.shared.xxl)
        static let xxxl = CGFloat(MobileData.Spacing.shared.xxxl)
    }

    enum Radius {
        static let sm = CGFloat(MobileData.Radii_.shared.sm)
        static let md = CGFloat(MobileData.Radii_.shared.md)
        static let lg = CGFloat(MobileData.Radii_.shared.lg)
        static let xl = CGFloat(MobileData.Radii_.shared.xl)
        static let pill = MobileData.Pill.shared.isTruePill ? CGFloat.infinity : xl
    }

    enum Motion {
        static let feedback = Double(MobileData.Motion_.shared.feedbackMs) / 1_000
        static let state = Double(MobileData.Motion_.shared.stateTransitionMs) / 1_000
        static let respondingCadence = Double(MobileData.Motion_.shared.respondingCadenceMs) / 1_000

        static func animation(duration: Double, reduceMotion: Bool) -> Animation? {
            reduceMotion ? nil : .easeInOut(duration: duration)
        }
    }

    enum MaterialRole: CaseIterable, Hashable {
        case slateFace, slateFaceHover, slateFaceMuted, slateTopLight
        case slateContact, slateCast, slateEmberCast
        case slateShadow, slateShadowHover, slateShadowPressed, slateShadowDisabled
        case wellFace, wellShadow, wellShadowFocus, plateShadow, floatShadow

        var contractRecipe: String {
            let materials = MobileData.Materials.shared
            return switch self {
            case .slateFace: materials.slateFace
            case .slateFaceHover: materials.slateFaceHover
            case .slateFaceMuted: materials.slateFaceMuted
            case .slateTopLight: materials.slateTopLight
            case .slateContact: materials.slateContact
            case .slateCast: materials.slateCast
            case .slateEmberCast: materials.slateEmberCast
            case .slateShadow: materials.slateShadow
            case .slateShadowHover: materials.slateShadowHover
            case .slateShadowPressed: materials.slateShadowPressed
            case .slateShadowDisabled: materials.slateShadowDisabled
            case .wellFace: materials.wellFace
            case .wellShadow: materials.wellShadow
            case .wellShadowFocus: materials.wellShadowFocus
            case .plateShadow: materials.plateShadow
            case .floatShadow: materials.floatShadow
            }
        }
    }
}

extension Color {
    fileprivate init(argb: Int64) {
        let byteMask: Int64 = 0xFF
        let channelMax = 255.0
        self.init(
            .sRGB,
            red: Double((argb >> 16) & byteMask) / channelMax,
            green: Double((argb >> 8) & byteMask) / channelMax,
            blue: Double(argb & byteMask) / channelMax,
            opacity: Double((argb >> 24) & byteMask) / channelMax
        )
    }
}

enum DesignTextRole {
    case telemetry, supporting, body, large, title, display

    var family: String {
        switch self {
        case .telemetry: DesignV2.Typography.monoFamily
        case .supporting, .body, .large: DesignV2.Typography.uiFamily
        case .title, .display: DesignV2.Typography.displayFamily
        }
    }

    var font: Font {
        switch self {
        case .telemetry:
            .custom(family, size: DesignV2.Typography.xs, relativeTo: .caption2)
        case .supporting:
            .custom(family, size: DesignV2.Typography.supporting, relativeTo: .footnote)
        case .body:
            .custom(family, size: DesignV2.Typography.body, relativeTo: .body)
        case .large:
            .custom(family, size: DesignV2.Typography.large, relativeTo: .headline)
        case .title:
            .custom(family, size: DesignV2.Typography.title, relativeTo: .title2)
        case .display:
            .custom(family, size: DesignV2.Typography.display, relativeTo: .largeTitle)
        }
    }

    var baseSize: CGFloat {
        switch self {
        case .telemetry: DesignV2.Typography.xs
        case .supporting: DesignV2.Typography.supporting
        case .body: DesignV2.Typography.body
        case .large: DesignV2.Typography.large
        case .title: DesignV2.Typography.title
        case .display: DesignV2.Typography.display
        }
    }

    var lineHeight: Double {
        switch self {
        case .title, .display: DesignV2.Typography.lineTight
        case .telemetry: DesignV2.Typography.lineRelaxed
        default: DesignV2.Typography.lineNormal
        }
    }
}

private struct DesignTextModifier: ViewModifier {
    let role: DesignTextRole

    func body(content: Content) -> some View {
        content
            .font(role.font)
            .lineSpacing(role.baseSize * CGFloat(role.lineHeight - 1))
            .environment(\.defaultMinListRowHeight, DesignMetrics.minimumTarget)
    }
}

extension View {
    func designText(_ role: DesignTextRole) -> some View { modifier(DesignTextModifier(role: role)) }
}

/// Named native layout values shared by components and allowed at page boundaries.
enum DesignMetrics {
    static let minimumTarget: CGFloat = 44
    static let hairline: CGFloat = 1
    static let focusRing: CGFloat = 3
    static let focusBorder: CGFloat = 2
    static let focusBorderInset: CGFloat = -3
    // The visual key is 40pt high; the enclosing native control still keeps
    // the 44pt minimum hit target below.
    static let buttonVisualHeight: CGFloat = 40
    static let buttonCornerRadius: CGFloat = 7
    static let buttonHorizontalPadding: CGFloat = 15
    static let buttonContentGap: CGFloat = 7
    static let buttonLabelSize: CGFloat = 15
    static let buttonPressTransition: Double = 0.07
    static let pressedDepth: CGFloat = 1
    static let categoryIconSlot: CGFloat = 26
    static let progressWidth: CGFloat = 64
    static let multilineEditorMinHeight: CGFloat = 160
    static let editorInset: CGFloat = 8
    static let editorPlaceholderInsetH: CGFloat = 14
    static let editorPlaceholderInsetV: CGFloat = 16
    static let narrowPreviewWidth: CGFloat = 320
    static let padPreviewWidth: CGFloat = 768
    static let dominantCardMinimumWidth: CGFloat = 144
    static let dominantCardMaximumWidth: CGFloat = 280
    static let dominantCardMinimumHeight: CGFloat = 220
    static let dominantCardGap: CGFloat = 14
    static let dominantLabelGap: CGFloat = 3
    static let dominantCardPaddingH: CGFloat = 14
    static let dominantCardPaddingV: CGFloat = 18
    static let dominantVisualSize: CGFloat = 104
    static let dominantAvatarSize: CGFloat = 82
    static let pinKeypadWidth: CGFloat = 276
    static let pinKeySize: CGFloat = 86
    static let pinKeyGap: CGFloat = 10
    static let pinDotSize: CGFloat = 14
    static let toggleWidth: CGFloat = 44
    static let toggleHeight: CGFloat = 28
    static let toggleKnobSize: CGFloat = 18
    static let toggleTravel: CGFloat = 16
    static let toggleAnimationDuration: Double = 0.20
    static let segmentGap: CGFloat = 3
    static let segmentBedPadding: CGFloat = 4
    static let segmentHeight: CGFloat = 34
    static let controlLabelSize: CGFloat = 14
    static let segmentLabelSize: CGFloat = 14
    static let segmentHorizontalPadding: CGFloat = 13
    static let segmentCornerRadius: CGFloat = 6
    static let checkboxSize: CGFloat = 22
    static let checkboxGap: CGFloat = 10
    static let checkboxCornerRadius: CGFloat = 6
    static let sliderTrackHeight: CGFloat = 8
    static let sliderThumbSize: CGFloat = 26
    static let sliderMinimumTrackWidth: CGFloat = 120
    static let sliderOutputWidth: CGFloat = 44
}
