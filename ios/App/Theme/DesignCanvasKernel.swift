import CoreGraphics
import SwiftUI

/// CSS box-shadow blur is a Gaussian with sigma = blur / 2 (CSS Backgrounds
/// §6.1.2). Paint each authored layer once: opacity is not an energy multiplier.
/// The exterior-mask construction keeps inset occlusion inside the face without
/// relying on a shadow filter's source-atop behavior on an unseeded layer.
enum DesignCanvasEffects {
    static func blurSigma(_ cssBlur: CGFloat) -> CGFloat { max(0, cssBlur) / 2 }

    static func overflow(blur: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> CGFloat {
        ceil(3 * blurSigma(blur) + max(abs(x), abs(y))) + 1
    }

    static func outerShadow(
        in context: inout GraphicsContext,
        sourcePath: Path,
        color: Color,
        blur: CGFloat,
        x: CGFloat = 0,
        y: CGFloat = 0
    ) {
        guard !sourcePath.isEmpty else { return }
        let source = sourcePath.applying(CGAffineTransform(translationX: x, y: y))
        context.drawLayer { layer in
            if blur > 0 { layer.addFilter(.blur(radius: blurSigma(blur))) }
            layer.fill(source, with: .color(color))
        }
    }

    static func insetShadow(
        in context: inout GraphicsContext,
        facePath: Path,
        sourcePath: Path,
        color: Color,
        blur: CGFloat,
        x: CGFloat = 0,
        y: CGFloat = 0
    ) {
        let sigma = blurSigma(blur)
        let translated = sourcePath.applying(CGAffineTransform(translationX: x, y: y))
        let extent = 3 * sigma + max(abs(x), abs(y)) + 1
        var exterior = Path(facePath.boundingRect.union(translated.boundingRect).insetBy(dx: -extent, dy: -extent))
        exterior.addPath(translated)
        var clipped = context
        clipped.clip(to: facePath)
        clipped.drawLayer { layer in
            layer.clipToLayer { mask in
                if sigma > 0 { mask.addFilter(.blur(radius: sigma)) }
                mask.fill(exterior, with: .color(.white), style: FillStyle(eoFill: true))
            }
            layer.fill(facePath, with: .color(color))
        }
    }
}

/// The one contour vocabulary used by every Canvas pass.
enum DesignCanvasShape: Equatable {
    case roundedRectangle(cornerRadius: CGFloat)
    case continuousRoundedRectangle(cornerRadius: CGFloat)
    case capsule
    case circle

    func path(in rect: CGRect, inset: CGFloat = 0) -> Path {
        // CGRect standardizes over-inset dimensions; reject the collapsed
        // CSS source before that can turn it into a reflected nonempty shape.
        guard rect.width - 2 * inset > 0, rect.height - 2 * inset > 0 else { return Path() }
        let insetRect = rect.insetBy(dx: inset, dy: inset)

        switch self {
        case .roundedRectangle(let cornerRadius):
            // Foundation keys use the established circular corner, not the
            // visually different continuous/squircle contour.
            return RoundedRectangle(
                cornerRadius: max(0, cornerRadius - inset),
                style: .circular
            ).path(in: insetRect)
        case .continuousRoundedRectangle(let cornerRadius):
            // Selected compact wrappers predate the canonical key contour and
            // retain their reviewed continuous radius-sm geometry explicitly.
            return RoundedRectangle(
                cornerRadius: max(0, cornerRadius - inset),
                style: .continuous
            ).path(in: insetRect)
        case .capsule:
            return Capsule(style: .circular).path(in: insetRect)
        case .circle:
            let diameter = min(insetRect.width, insetRect.height)
            return Circle().path(in: CGRect(
                x: insetRect.midX - diameter / 2,
                y: insetRect.midY - diameter / 2,
                width: diameter,
                height: diameter
            ))
        }
    }

    func cgPath(in rect: CGRect, inset: CGFloat = 0) -> CGPath {
        path(in: rect, inset: inset).cgPath
    }
}

/// Paint order is a contract: lower entries are composited first.
enum DesignCanvasPass: String, CaseIterable {
    case glow
    case cast
    case contact
    case linearFace
    case radialConcavity
    case directionalTopLight
    case pressedInnerOcclusion
    case insideBorder
    case focusRing

    static let ordered = allCases
}

/// Broad shared surfaces use a quieter pipeline than actionable slates. The
/// face remains flat paper while the ordered edge and depth passes establish
/// plate or float elevation.
enum DesignCanvasSurfacePass: String, CaseIterable {
    case emberCast
    case cast
    case contact
    case paperFace
    case directionalTopLight
    case insideBorder

    static let ordered = allCases
}

enum DesignCanvasSurfaceTier: Equatable {
    case plate
    case float
}

/// Receiving surfaces use their own physical pipeline. A validated error is a
/// scoped common-composite profile, not a generic field-error precedence rule.
enum DesignCanvasWellPass: String, CaseIterable, Hashable {
    case stateCast
    case stateHalo
    case contact
    case linearFace
    case upperInnerOcclusion
    case lowerInnerReflection
    case insideBorder
    case focusOutline

    static let ordered = allCases
}

enum DesignCanvasWellProfile: Equatable {
    case standard
    case validatedError
}

/// Focus, enabled state, and the explicitly authorized validation profile are
/// independent inputs so the native owner can compose focus with validation.
struct DesignCanvasWellState: Equatable {
    var isFocused: Bool
    var isDisabled: Bool
    var profile: DesignCanvasWellProfile

    init(
        isFocused: Bool = false,
        isDisabled: Bool = false,
        profile: DesignCanvasWellProfile = .standard
    ) {
        self.isFocused = isFocused
        self.isDisabled = isDisabled
        self.profile = profile
    }

    static let rest = DesignCanvasWellState()
    static let focus = DesignCanvasWellState(isFocused: true)
    static let validatedError = DesignCanvasWellState(profile: .validatedError)
    static let disabled = DesignCanvasWellState(isDisabled: true)
    static let focusValidatedError = DesignCanvasWellState(
        isFocused: true,
        profile: .validatedError
    )
}

struct DesignCanvasWellAnimationValues: Equatable {
    var focus: CGFloat
    var validatedError: CGFloat

    init(focus: CGFloat, validatedError: CGFloat) {
        self.focus = focus.clamped
        self.validatedError = validatedError.clamped
    }

    init(state: DesignCanvasWellState) {
        self.init(
            focus: state.isFocused ? 1 : 0,
            validatedError: state.profile == .validatedError ? 1 : 0
        )
    }
}

/// CSS inset spread is not an outer-shadow source inset. With inverted alpha,
/// a negative spread moves the source contour outward, delaying the blurred
/// occlusion as it travels back into the clipped face.
struct DesignCanvasInsetShadowGeometry: Equatable {
    let radius: CGFloat
    let x: CGFloat
    let y: CGFloat
    let spread: CGFloat

    var sourceInset: CGFloat { spread }

    func sourceRect(in faceRect: CGRect) -> CGRect {
        faceRect.insetBy(dx: sourceInset, dy: sourceInset)
    }

    func sourcePath(shape: DesignCanvasShape, in faceRect: CGRect) -> Path {
        shape.path(in: faceRect, inset: sourceInset)
    }
}

/// Independent interaction flags preserve focus while hover/press material is
/// applied. Disabled overrides the material flags, but does not erase the
/// caller's explicit focus semantic.
struct DesignCanvasControlState: Equatable {
    var isHovered: Bool
    var isPressed: Bool
    var isFocused: Bool
    var isDisabled: Bool

    init(
        isHovered: Bool = false,
        isPressed: Bool = false,
        isFocused: Bool = false,
        isDisabled: Bool = false
    ) {
        self.isHovered = isHovered
        self.isPressed = isPressed
        self.isFocused = isFocused
        self.isDisabled = isDisabled
    }

    static let rest = DesignCanvasControlState()
    static let hover = DesignCanvasControlState(isHovered: true)
    static let pressed = DesignCanvasControlState(isPressed: true)
    static let disabled = DesignCanvasControlState(isDisabled: true)
}

struct DesignCanvasAnimationValues: Equatable {
    var hover: CGFloat
    var press: CGFloat
    var focus: CGFloat

    init(hover: CGFloat, press: CGFloat, focus: CGFloat) {
        self.hover = hover.clamped
        self.press = press.clamped
        self.focus = focus.clamped
    }

    init(state: DesignCanvasControlState) {
        self.init(
            hover: state.isHovered ? 1 : 0,
            press: state.isPressed ? 1 : 0,
            focus: state.isFocused ? 1 : 0
        )
    }
}

enum DesignCanvasGlowTone: Equatable { case ember, destructive }
enum DesignCanvasContactTone: Equatable { case line, accent, destructive }
enum DesignCanvasRadialStyle: Equatable { case concaveThreeStop, mutedTwoStop }

enum DesignCanvasTransition: CaseIterable {
    case hover
    case focus
    case press
    case pressRelease
    case material

    func duration(reduceMotion: Bool) -> Double? {
        guard !reduceMotion else { return nil }
        return switch self {
        case .hover, .focus: DesignV2.Motion.feedback
        case .press: 0.07
        case .pressRelease: 0.09
        case .material: DesignV2.Motion.state
        }
    }

    func animation(reduceMotion: Bool) -> Animation? {
        guard let duration = duration(reduceMotion: reduceMotion) else { return nil }
        return .timingCurve(0.25, 0.1, 0.25, 1, duration: duration)
    }
}

struct DesignCanvasShadowRecipe {
    let color: Color
    let opacity: Double
    let geometry: DesignDropShadowGeometry
}

/// Pure projection of the approved plate and float recipes. Surface chrome has
/// no interaction state; native containers continue to own content and layout.
struct DesignCanvasSurfaceRecipe {
    let tier: DesignCanvasSurfaceTier
    let increasedContrast: Bool
    let shadowProjection: DesignMaterialNativeProjection
    let face: Color
    let insideBorder: Color
    let insideBorderLineWidth: CGFloat
    let topLight: Color
    let topLightOpacity: Double
    let contact: DesignCanvasShadowRecipe
    let cast: DesignCanvasShadowRecipe
    let emberCast: DesignCanvasShadowRecipe?

    static func make(
        tier: DesignCanvasSurfaceTier,
        increasedContrast: Bool = false
    ) -> DesignCanvasSurfaceRecipe {
        let isFloat = tier == .float
        return DesignCanvasSurfaceRecipe(
            tier: tier,
            increasedContrast: increasedContrast,
            shadowProjection: DesignMaterialAdapter.nativeProjection(
                for: isFloat ? .floatShadow : .plateShadow
            ),
            face: DuskColors.paper,
            insideBorder: increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft,
            insideBorderLineWidth: DesignMetrics.hairline,
            topLight: DuskColors.ink,
            // Keep the established native float projection while the plate
            // follows the exact quiet top-edge light from the foundation CSS.
            topLightOpacity: isFloat
                ? DesignMaterialAdapter.slateElevatedTopLight
                : DesignMaterialAdapter.slateTopLightOpacity,
            contact: DesignCanvasShadowRecipe(
                color: DuskColors.bgSunk.overlaying(
                    DuskColors.line,
                    opacity: isFloat
                        ? DesignMaterialAdapter.plateElevatedContactMix
                        : DesignMaterialAdapter.plateRestContactMix
                ),
                opacity: 1,
                geometry: DesignDropShadowGeometry(
                    radius: 0,
                    y: isFloat
                        ? DesignMaterialAdapter.slateElevatedContactY
                        : DesignMaterialAdapter.slateRestContactY,
                    sourceInset: DesignMetrics.hairline
                )
            ),
            cast: DesignCanvasShadowRecipe(
                color: .black,
                opacity: isFloat
                    ? DesignMaterialAdapter.slateElevatedBlack
                    : DesignMaterialAdapter.slateRestBlack,
                geometry: isFloat
                    ? DesignMaterialShadowGeometry.float
                    : DesignMaterialShadowGeometry.plate
            ),
            emberCast: isFloat
                ? DesignCanvasShadowRecipe(
                    color: DuskColors.accent,
                    opacity: DesignMaterialAdapter.slateElevatedEmber,
                    geometry: DesignMaterialShadowGeometry.floatGlow
                )
                : nil
        )
    }
}

/// Pure receiving-surface projection. It contains no content, responder, or
/// accessibility state. Disabled resolves to the unchanged rest chrome, while
/// the validated-error profile remains explicitly scoped for future use by
/// `ValidatedField` rather than becoming universal field authority.
struct DesignCanvasWellRecipe {
    let state: DesignCanvasWellState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let animationValues: DesignCanvasWellAnimationValues

    let faceProjection: DesignMaterialNativeProjection
    let shadowProjection: DesignMaterialNativeProjection
    let isValidatedErrorProfile: Bool
    let effectiveFocus: CGFloat
    let effectiveValidatedError: CGFloat

    let stateCast: DesignCanvasShadowRecipe
    let stateHaloColor: Color
    let stateHaloOpacity: Double
    let stateHaloSpread: CGFloat
    let contact: DesignCanvasShadowRecipe
    let faceTop: Color
    let faceMiddle: Color
    let faceBottom: Color
    let faceMiddleStop: CGFloat
    let upperInnerOcclusionColor: Color
    let upperInnerOcclusionOpacity: Double
    let upperInnerOcclusion: DesignCanvasInsetShadowGeometry
    let lowerInnerReflectionColor: Color
    let lowerInnerReflectionOpacity: Double
    let lowerInnerReflectionY: CGFloat
    let lowerInnerReflectionInset: CGFloat
    let border: Color
    let borderLineWidth: CGFloat
    let focusOutline: Color
    let focusOutlineOpacity: Double
    let focusOutlineLineWidth: CGFloat
    let focusOutlineOffset: CGFloat

    static func make(
        state: DesignCanvasWellState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false,
        animationValues suppliedValues: DesignCanvasWellAnimationValues? = nil
    ) -> DesignCanvasWellRecipe {
        let values = suppliedValues ?? DesignCanvasWellAnimationValues(state: state)
        // A disabled native editor cannot become first responder. Keep its
        // decorative surface identical to rest without flattening opacity.
        let focus: CGFloat = state.isDisabled ? 0 : values.focus
        let validatedError: CGFloat = state.isDisabled ? 0 : values.validatedError
        // The approved validated-error CSS retains rest well-shadow material;
        // focus remains visible only through the separate native outline.
        let focusedMaterial = focus * (1 - validatedError)

        let restBorder = increasedContrast ? DuskColors.ink3 : DuskColors.line
        let focusedBorder = DuskColors.accent.overlaying(
            DuskColors.line,
            opacity: DesignMaterialAdapter.wellCSSFocusLineMix
        )
        let validatedErrorBorder = DuskColors.stop.overlaying(
            DuskColors.line,
            opacity: DesignMaterialAdapter.wellValidatedErrorLineMix
        )
        let border = restBorder
            .wellInterpolated(to: focusedBorder, amount: focus)
            .wellInterpolated(to: validatedErrorBorder, amount: validatedError)

        let focusHaloOpacity = DesignMaterialAdapter.wellCSSFocusHaloOpacity * Double(focus)
        let haloOpacity = Double.lerp(
            focusHaloOpacity,
            DesignMaterialAdapter.wellValidatedErrorHaloOpacity,
            by: validatedError
        )

        return DesignCanvasWellRecipe(
            state: state,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            animationValues: values,
            faceProjection: DesignMaterialAdapter.nativeProjection(for: .wellFace),
            shadowProjection: DesignMaterialAdapter.nativeProjection(
                for: focusedMaterial > 0 ? .wellShadowFocus : .wellShadow
            ),
            isValidatedErrorProfile: state.profile == .validatedError,
            effectiveFocus: focus,
            effectiveValidatedError: validatedError,
            stateCast: DesignCanvasShadowRecipe(
                color: DuskColors.accent,
                opacity: DesignMaterialAdapter.wellCSSFocusCastOpacity
                    * Double(focusedMaterial),
                geometry: DesignDropShadowGeometry(
                    radius: DesignMaterialAdapter.wellCSSFocusCastBlur,
                    y: DesignMaterialAdapter.wellCSSFocusCastY,
                    sourceInset: abs(DesignMaterialAdapter.wellCSSFocusCastSpread)
                )
            ),
            stateHaloColor: DuskColors.accent.wellInterpolated(
                to: DuskColors.stop,
                amount: validatedError
            ),
            stateHaloOpacity: haloOpacity,
            stateHaloSpread: DesignMaterialAdapter.wellCSSHaloSpread,
            contact: DesignCanvasShadowRecipe(
                color: DuskColors.line,
                opacity: DesignMaterialAdapter.wellCSSContactOpacity
                    * Double(1 - focusedMaterial),
                geometry: DesignDropShadowGeometry(
                    radius: 0,
                    y: DesignMaterialAdapter.wellCSSContactY,
                    sourceInset: 0
                )
            ),
            faceTop: DuskColors.bgSunk.overlaying(
                .black,
                opacity: DesignMaterialAdapter.wellCSSTopBlack
            ),
            faceMiddle: DuskColors.bgSunk,
            faceBottom: DuskColors.bgSunk.overlaying(
                DuskColors.bgElev,
                opacity: DesignMaterialAdapter.wellCSSBottomElevated
            ),
            faceMiddleStop: DesignMaterialAdapter.wellCSSMiddleStop,
            upperInnerOcclusionColor: .black,
            upperInnerOcclusionOpacity: Double.lerp(
                DesignMaterialAdapter.wellCSSInsetOpacity,
                DesignMaterialAdapter.wellCSSInsetFocusOpacity,
                by: focusedMaterial
            ),
            upperInnerOcclusion: DesignCanvasInsetShadowGeometry(
                radius: DesignMaterialAdapter.wellCSSInsetBlur,
                x: 0,
                y: DesignMaterialAdapter.wellCSSInsetY,
                spread: DesignMaterialAdapter.wellCSSInsetSpread
            ),
            lowerInnerReflectionColor: DuskColors.ink,
            lowerInnerReflectionOpacity: Double.lerp(
                DesignMaterialAdapter.wellCSSBottomReflection,
                DesignMaterialAdapter.wellCSSBottomReflectionFocused,
                by: focusedMaterial
            ),
            lowerInnerReflectionY: DesignMaterialAdapter.wellCSSBottomReflectionY,
            lowerInnerReflectionInset: DesignMetrics.hairline,
            border: border,
            borderLineWidth: DesignMetrics.hairline,
            focusOutline: DuskColors.accent,
            focusOutlineOpacity: Double(focus),
            focusOutlineLineWidth: DesignMaterialAdapter.wellCSSFocusOutlineWidth,
            focusOutlineOffset: DesignMaterialAdapter.wellCSSFocusOutlineOffset
        )
    }
}

/// Pure role/state projection. The native control owns transition policy and
/// requests an interaction-specific `DesignCanvasTransition`; the recipe owns
/// all scalar and color interpolation so consumers do not reproduce material math.
struct DesignCanvasMaterialRecipe {
    let role: DesignButtonRole
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let animationValues: DesignCanvasAnimationValues

    let faceProjection: DesignMaterialNativeProjection
    let shadowProjection: DesignMaterialNativeProjection
    let glowTone: DesignCanvasGlowTone
    let contactTone: DesignCanvasContactTone
    let contactMix: Double
    let radialStyle: DesignCanvasRadialStyle

    let linearTop: Color
    let linearBottom: Color
    let radialCenter: Color
    let radialRing: Color?
    let radialCenterStop: CGFloat?
    let radialFadeStop: CGFloat
    let border: Color
    let topLight: Color
    let topLightOpacity: Double
    let pressedInnerOcclusion: Color
    let pressedInnerOcclusionOpacity: Double
    let focusRing: Color
    let focusOpacity: Double
    let focusLineWidth: CGFloat
    let glow: DesignCanvasShadowRecipe?
    let cast: DesignCanvasShadowRecipe
    let contact: DesignCanvasShadowRecipe

    static func make(
        role: DesignButtonRole,
        state: DesignCanvasControlState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false,
        animationValues suppliedValues: DesignCanvasAnimationValues? = nil,
        baseColor: Color? = nil
    ) -> DesignCanvasMaterialRecipe {
        let values = suppliedValues ?? DesignCanvasAnimationValues(state: state)
        // Disabled material is seated and static. Focus remains independent so
        // an owning semantic control can explicitly retain its focus signal.
        let hover = state.isDisabled ? 0 : values.hover
        let press = state.isDisabled ? 0 : values.press
        let focus = values.focus
        let glowColor = role == .destructive ? DuskColors.stop : DuskColors.accent

        let resolvedBase: Color = if state.isDisabled {
            DuskColors.bgElev.overlaying(
                DuskColors.ink4,
                opacity: DesignMaterialAdapter.slateDisabledBaseInkMix
            )
        } else {
            switch role {
            case .action:
                DuskColors.accent
            case .secondary:
                DuskColors.paper.overlaying(
                    DuskColors.ink2,
                    opacity: DesignMaterialAdapter.slateSecondaryInkMix
                )
            case .quiet:
                DuskColors.bgElev
            case .destructive:
                DuskColors.paper.overlaying(
                    DuskColors.stop,
                    opacity: DesignMaterialAdapter.slateDestructiveOverlay
                )
            }
        }

        let base = state.isDisabled ? resolvedBase : (baseColor ?? resolvedBase)

        let restLinearTop = state.isDisabled
            ? base.overlaying(DuskColors.ink4, opacity: DesignMaterialAdapter.slateMutedBaseLight)
            : base.overlaying(DuskColors.ink, opacity: DesignMaterialAdapter.slateBaseLight)
        let hoverLinearTop = base.overlaying(DuskColors.ink, opacity: DesignMaterialAdapter.slateHoverBaseLight)
        let linearTop = restLinearTop.interpolated(to: hoverLinearTop, amount: hover)
        let linearBottom = base.interpolated(
            to: base.overlaying(glowColor, opacity: DesignMaterialAdapter.slateHoverGlow),
            amount: hover
        )

        let centerSunk = state.isDisabled
            ? DesignMaterialAdapter.slateMutedCenterSunk
            : CGFloat.lerp(
                DesignMaterialAdapter.slateCenterSunk,
                DesignMaterialAdapter.slateHoverCenterSunk,
                by: hover
            )
        let ringSunk = CGFloat.lerp(
            DesignMaterialAdapter.slateRingSunk,
            DesignMaterialAdapter.slateHoverRingSunk,
            by: hover
        )
        let radialCenter = base.overlaying(DuskColors.bgSunk, opacity: centerSunk)

        let restCastGeometry = DesignMaterialShadowGeometry.slateRest
        let hoverCastGeometry = DesignMaterialShadowGeometry.slateHover
        let pressedCastGeometry = DesignMaterialShadowGeometry.slatePressed
        let interactiveCastGeometry = restCastGeometry
            .interpolated(to: hoverCastGeometry, amount: hover)
            .interpolated(to: pressedCastGeometry, amount: press)
        let restCastOpacity = role == .action
            ? DesignMaterialAdapter.slateActionRestBlack
            : DesignMaterialAdapter.slateRestBlack
        let interactiveCastOpacity = Double.lerp(
            Double.lerp(restCastOpacity, DesignMaterialAdapter.slateHoverBlack, by: hover),
            DesignMaterialAdapter.slatePressedBlack,
            by: press
        )

        let restGlowOpacity: Double = switch role {
        case .action: DesignMaterialAdapter.slateActionGlow
        case .secondary: DesignMaterialAdapter.slateSecondaryGlow
        case .quiet: DesignMaterialAdapter.slateQuietGlow
        case .destructive: DesignMaterialAdapter.slateDestructiveGlow
        }
        let hoverGlowOpacity = role == .destructive
            ? DesignMaterialAdapter.slateDestructiveHoverGlowOpacity
            : DesignMaterialAdapter.slateHoverGlowOpacity
        let restGlowGeometry: DesignDropShadowGeometry = switch role {
        case .action: DesignMaterialShadowGeometry.slateActionGlow
        case .secondary, .quiet: DesignMaterialShadowGeometry.slateGlow
        case .destructive: DesignMaterialShadowGeometry.slateDestructiveGlow
        }
        let hoverGlowGeometry = role == .destructive
            ? DesignMaterialShadowGeometry.slateDestructiveHoverGlow
            : DesignMaterialShadowGeometry.slateHoverGlow
        let glowOpacity = Double.lerp(
            Double.lerp(restGlowOpacity, hoverGlowOpacity, by: hover),
            0,
            by: press
        )

        let disabledContact = (
            color: DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDisabledContactMix
            ),
            tone: DesignCanvasContactTone.line,
            mix: DesignMaterialAdapter.slateDisabledContactMix
        )
        let restContact = state.isDisabled
            ? disabledContact
            : contactEndpoint(role: role, hovered: false, pressed: false)
        let hoverContact = state.isDisabled
            ? disabledContact
            : contactEndpoint(role: role, hovered: true, pressed: false)
        let pressedContact = state.isDisabled
            ? disabledContact
            : contactEndpoint(role: role, hovered: state.isHovered, pressed: true)
        let contactColor = restContact.color
            .interpolated(to: hoverContact.color, amount: hover)
            .interpolated(to: pressedContact.color, amount: press)
        let contactMix = Double.lerp(
            Double.lerp(restContact.mix, hoverContact.mix, by: hover),
            pressedContact.mix,
            by: press
        )
        let contactTone = press == 1
            ? pressedContact.tone
            : hover == 1 ? hoverContact.tone : restContact.tone

        let restBorder = border(role: role, disabled: state.isDisabled, increasedContrast: increasedContrast)
        let border = restBorder.interpolated(to: .clear, amount: hover)
        let restTopLight = topLight(role: role, disabled: state.isDisabled, hovered: false)
        let hoverTopLight = topLight(role: role, disabled: false, hovered: true)

        let faceRole: DesignV2.MaterialRole = state.isDisabled
            ? .slateFaceMuted
            : state.isHovered ? .slateFaceHover : .slateFace
        let shadowRole: DesignV2.MaterialRole = state.isDisabled
            ? .slateShadowDisabled
            : state.isPressed
                ? .slateShadowPressed
                : state.isHovered ? .slateShadowHover : .slateShadow

        return DesignCanvasMaterialRecipe(
            role: role,
            state: state,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            animationValues: values,
            faceProjection: DesignMaterialAdapter.nativeProjection(for: faceRole),
            shadowProjection: DesignMaterialAdapter.nativeProjection(for: shadowRole),
            glowTone: role == .destructive ? .destructive : .ember,
            contactTone: contactTone,
            contactMix: contactMix,
            radialStyle: state.isDisabled ? .mutedTwoStop : .concaveThreeStop,
            linearTop: linearTop,
            linearBottom: linearBottom,
            radialCenter: radialCenter,
            radialRing: state.isDisabled
                ? nil
                : base.overlaying(DuskColors.bgSunk, opacity: ringSunk),
            radialCenterStop: state.isDisabled ? nil : DesignMaterialAdapter.slateCenterStop,
            radialFadeStop: state.isDisabled
                ? DesignMaterialAdapter.slateMutedFadeStop
                : DesignMaterialAdapter.slateFadeStop,
            border: border,
            topLight: restTopLight.interpolated(to: hoverTopLight, amount: hover),
            topLightOpacity: Double(1 - press),
            pressedInnerOcclusion: DuskColors.bgSunk,
            pressedInnerOcclusionOpacity: DesignMaterialAdapter.slatePressedInsetOpacity * Double(press),
            focusRing: DuskColors.accent,
            focusOpacity: Double(focus),
            focusLineWidth: increasedContrast ? DesignMetrics.focusRing : DesignMetrics.focusBorder,
            glow: state.isDisabled || glowOpacity == 0
                ? nil
                : DesignCanvasShadowRecipe(
                    color: glowColor,
                    opacity: glowOpacity,
                    geometry: restGlowGeometry.interpolated(to: hoverGlowGeometry, amount: hover)
                ),
            cast: DesignCanvasShadowRecipe(
                color: .black,
                opacity: state.isDisabled ? DesignMaterialAdapter.slateDisabledBlack : interactiveCastOpacity,
                geometry: state.isDisabled ? DesignMaterialShadowGeometry.slateDisabled : interactiveCastGeometry
            ),
            contact: DesignCanvasShadowRecipe(
                color: contactColor,
                opacity: 1,
                geometry: DesignDropShadowGeometry(
                    radius: 0,
                    y: state.isDisabled
                        ? DesignMaterialAdapter.slateDisabledContactY
                        : CGFloat.lerp(DesignMaterialAdapter.slateContactY, DesignMetrics.pressedDepth, by: press),
                    sourceInset: DesignMetrics.hairline
                )
            )
        )
    }

    private static func contactEndpoint(
        role: DesignButtonRole,
        hovered: Bool,
        pressed: Bool
    ) -> (color: Color, tone: DesignCanvasContactTone, mix: Double) {
        if pressed {
            let mix = DesignMaterialAdapter.slateInteractiveContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.line, opacity: mix), .line, mix)
        }
        if hovered, role == .destructive {
            let mix = DesignMaterialAdapter.slateDestructiveHoverContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: mix), .destructive, mix)
        }
        if hovered {
            let mix = DesignMaterialAdapter.slateInteractiveContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.line, opacity: mix), .line, mix)
        }
        switch role {
        case .action:
            let mix = DesignMaterialAdapter.slateActionContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.accent, opacity: mix), .accent, mix)
        case .secondary, .quiet:
            let mix = DesignMaterialAdapter.slateSecondaryContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.line, opacity: mix), .line, mix)
        case .destructive:
            let mix = DesignMaterialAdapter.slateDestructiveContactMix
            return (DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: mix), .destructive, mix)
        }
    }

    private static func border(
        role: DesignButtonRole,
        disabled: Bool,
        increasedContrast: Bool
    ) -> Color {
        if disabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        }
        if increasedContrast { return DuskColors.ink3 }
        return switch role {
        case .action:
            DuskColors.accent.overlaying(
                DuskColors.bgSunk,
                opacity: 1 - DesignMaterialAdapter.slateActionBorder
            )
        case .secondary:
            DuskColors.line
        case .quiet:
            DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: DesignMaterialAdapter.slateQuietBorderBackgroundMix
            )
        case .destructive:
            DuskColors.stop.overlaying(
                DuskColors.line,
                opacity: 1 - DesignMaterialAdapter.slateDestructiveBorder
            )
        }
    }

    private static func topLight(role: DesignButtonRole, disabled: Bool, hovered: Bool) -> Color {
        if disabled { return DuskColors.ink.opacity(DesignMaterialAdapter.slateDisabledTopLight) }
        if hovered {
            return role == .destructive
                ? .white.opacity(DesignMaterialAdapter.slateDestructiveHoverTopLight)
                : DuskColors.ink.opacity(DesignMaterialAdapter.slateHoverTopLight)
        }
        return switch role {
        case .action: .white.opacity(DesignMaterialAdapter.slateActionTopLight)
        case .secondary, .quiet: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
        case .destructive: .white.opacity(DesignMaterialAdapter.slateDestructiveTopLight)
        }
    }
}

enum DesignCanvasGeometry {
    static func shadowExtent(_ geometry: DesignDropShadowGeometry) -> CGFloat {
        geometry.sourceInset + geometry.radius + max(abs(geometry.x), abs(geometry.y))
    }

    static func overflow(for recipe: DesignCanvasMaterialRecipe, displayScale: CGFloat) -> CGFloat {
        let geometries: [DesignDropShadowGeometry] = [
            DesignMaterialShadowGeometry.slateRest,
            DesignMaterialShadowGeometry.slateHover,
            DesignMaterialShadowGeometry.slatePressed,
            DesignMaterialShadowGeometry.slateDisabled,
            DesignMaterialShadowGeometry.slateActionGlow,
            DesignMaterialShadowGeometry.slateGlow,
            DesignMaterialShadowGeometry.slateDestructiveGlow,
            DesignMaterialShadowGeometry.slateHoverGlow,
            DesignMaterialShadowGeometry.slateDestructiveHoverGlow,
        ]
        let maximum = geometries.map(shadowExtent).max() ?? 0
        return ceil(maximum * max(displayScale, 1)) / max(displayScale, 1)
    }

    static func overflow(for recipe: DesignCanvasSurfaceRecipe, displayScale: CGFloat) -> CGFloat {
        let maximum = max(
            recipe.emberCast.map { shadowExtent($0.geometry) } ?? 0,
            shadowExtent(recipe.cast.geometry),
            shadowExtent(recipe.contact.geometry)
        )
        return ceil(maximum * displayScale) / displayScale
    }

    /// Receiving surfaces reserve the maximum focused envelope in every state
    /// so state transitions cannot move the native face relative to its owner.
    static func overflow(for recipe: DesignCanvasWellRecipe, displayScale: CGFloat) -> CGFloat {
        let castExtent = shadowExtent(recipe.stateCast.geometry)
        let haloExtent = recipe.stateHaloSpread
        let contactExtent = shadowExtent(recipe.contact.geometry)
        let focusExtent = recipe.focusOutlineOffset + recipe.focusOutlineLineWidth
        let maximum = max(castExtent, haloExtent, contactExtent, focusExtent)
        return ceil(maximum * displayScale) / displayScale
    }

    static func faceRect(faceSize: CGSize, overflow: CGFloat, displayScale: CGFloat) -> CGRect {
        let minX = roundedToPixel(overflow, displayScale: displayScale)
        let minY = roundedToPixel(overflow, displayScale: displayScale)
        let maxX = roundedToPixel(overflow + faceSize.width, displayScale: displayScale)
        let maxY = roundedToPixel(overflow + faceSize.height, displayScale: displayScale)
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    static func insideStrokePathInset(lineWidth: CGFloat = DesignMetrics.hairline) -> CGFloat {
        lineWidth / 2
    }

    static func outsideStrokePathInset(offset: CGFloat, lineWidth: CGFloat) -> CGFloat {
        -(offset + lineWidth / 2)
    }

    static func directionalInnerEdgePath(
        shape: DesignCanvasShape,
        faceRect: CGRect,
        inset: CGFloat,
        translationY: CGFloat
    ) -> Path {
        let innerPath = shape.path(in: faceRect, inset: inset)
        var translated = Path()
        translated.addPath(
            innerPath,
            transform: CGAffineTransform(translationX: 0, y: translationY)
        )
        var difference = Path()
        difference.addPath(innerPath)
        difference.addPath(translated)
        return difference
    }

    static func insideStrokeEdgesArePixelAligned(
        faceOrigin: CGFloat,
        lineWidth: CGFloat = DesignMetrics.hairline,
        displayScale: CGFloat
    ) -> Bool {
        let pathCenter = faceOrigin + insideStrokePathInset(lineWidth: lineWidth)
        let halfStroke = lineWidth / 2
        let nearEdge = (pathCenter - halfStroke) * displayScale
        let farEdge = (pathCenter + halfStroke) * displayScale
        return nearEdge.rounded() == nearEdge && farEdge.rounded() == farEdge
    }

    private static func roundedToPixel(_ value: CGFloat, displayScale: CGFloat) -> CGFloat {
        guard displayScale > 0 else { return value }
        return (value * displayScale).rounded() / displayScale
    }
}

/// Decorative-only plate/float renderer. Install it behind a natively clipped
/// container; its expanded transparent field affects neither layout, hit
/// testing, nor accessibility.
struct DesignCanvasSurfaceKernel: View {
    let shape: DesignCanvasShape
    let tier: DesignCanvasSurfaceTier
    var increasedContrast = false

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { proxy in
            let recipe = DesignCanvasSurfaceRecipe.make(
                tier: tier,
                increasedContrast: increasedContrast
            )
            let overflow = DesignCanvasGeometry.overflow(for: recipe, displayScale: displayScale)
            let fieldSize = CGSize(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            let faceRect = DesignCanvasGeometry.faceRect(
                faceSize: proxy.size,
                overflow: overflow,
                displayScale: displayScale
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                for pass in DesignCanvasSurfacePass.ordered {
                    draw(pass, in: &context, faceRect: faceRect, recipe: recipe)
                }
            }
            .frame(width: fieldSize.width, height: fieldSize.height)
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(
        _ pass: DesignCanvasSurfacePass,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        recipe: DesignCanvasSurfaceRecipe
    ) {
        let facePath = shape.path(in: faceRect)
        switch pass {
        case .emberCast:
            if let emberCast = recipe.emberCast {
                drawShadow(emberCast, in: &context, faceRect: faceRect)
            }
        case .cast:
            drawShadow(recipe.cast, in: &context, faceRect: faceRect)
        case .contact:
            drawShadow(recipe.contact, in: &context, faceRect: faceRect)
        case .paperFace:
            context.fill(facePath, with: .color(recipe.face))
        case .directionalTopLight:
            let inset = recipe.insideBorderLineWidth
            let innerPath = shape.path(in: faceRect, inset: inset)
            let edge = DesignCanvasGeometry.directionalInnerEdgePath(
                shape: shape,
                faceRect: faceRect,
                inset: inset,
                translationY: DesignMetrics.hairline
            )
            var topLight = context
            topLight.clip(to: innerPath)
            topLight.fill(
                edge,
                with: .color(recipe.topLight.opacity(recipe.topLightOpacity)),
                style: FillStyle(eoFill: true)
            )
        case .insideBorder:
            context.stroke(
                shape.path(
                    in: faceRect,
                    inset: DesignCanvasGeometry.insideStrokePathInset(
                        lineWidth: recipe.insideBorderLineWidth
                    )
                ),
                with: .color(recipe.insideBorder),
                lineWidth: recipe.insideBorderLineWidth
            )
        }
    }

    private func drawShadow(
        _ recipe: DesignCanvasShadowRecipe,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        guard recipe.opacity > 0 else { return }
        var source = Path()
        source.addPath(
            shape.path(in: faceRect, inset: recipe.geometry.sourceInset),
            transform: CGAffineTransform(
                translationX: recipe.geometry.x,
                y: recipe.geometry.y
            )
        )
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: recipe.color.opacity(recipe.opacity),
            blur: recipe.geometry.radius
        )
    }
}

/// Decorative-only canonical raised-slate renderer. Install it as a native
/// control's background/overlay. Its transparent overflow field affects
/// neither native layout nor hit testing, and it owns no text, icon, gesture,
/// focus, accessibility semantics, clock, or timeline.
struct DesignCanvasKernel: View, Animatable {
    let shape: DesignCanvasShape
    let role: DesignButtonRole
    let state: DesignCanvasControlState
    var increasedContrast = false
    var reduceMotion = false

    let baseColor: Color?

    private var hoverAmount: CGFloat
    private var pressAmount: CGFloat
    private var focusAmount: CGFloat

    @Environment(\.displayScale) private var displayScale

    init(
        shape: DesignCanvasShape,
        role: DesignButtonRole,
        state: DesignCanvasControlState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false,
        baseColor: Color? = nil
    ) {
        self.shape = shape
        self.role = role
        self.state = state
        self.increasedContrast = increasedContrast
        self.reduceMotion = reduceMotion
        self.baseColor = baseColor
        let values = DesignCanvasAnimationValues(state: state)
        hoverAmount = values.hover
        pressAmount = values.press
        focusAmount = values.focus
    }

    var animationValues: DesignCanvasAnimationValues {
        DesignCanvasAnimationValues(hover: hoverAmount, press: pressAmount, focus: focusAmount)
    }

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, CGFloat> {
        get { AnimatablePair(AnimatablePair(hoverAmount, pressAmount), focusAmount) }
        set {
            hoverAmount = newValue.first.first
            pressAmount = newValue.first.second
            focusAmount = newValue.second
        }
    }

    static func transitionAnimation(
        for transition: DesignCanvasTransition,
        reduceMotion: Bool
    ) -> Animation? {
        transition.animation(reduceMotion: reduceMotion)
    }

    var body: some View {
        GeometryReader { proxy in
            let recipe = DesignCanvasMaterialRecipe.make(
                role: role,
                state: state,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion,
                animationValues: animationValues,
                baseColor: baseColor
            )
            let overflow = DesignCanvasGeometry.overflow(for: recipe, displayScale: displayScale)
            let fieldSize = CGSize(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            let faceRect = DesignCanvasGeometry.faceRect(
                faceSize: proxy.size,
                overflow: overflow,
                displayScale: displayScale
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                for pass in DesignCanvasPass.ordered {
                    draw(pass, in: &context, faceRect: faceRect, recipe: recipe)
                }
            }
            .frame(width: fieldSize.width, height: fieldSize.height)
            .offset(x: -overflow, y: -overflow)
        }
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(
        _ pass: DesignCanvasPass,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        recipe: DesignCanvasMaterialRecipe
    ) {
        let facePath = shape.path(in: faceRect)
        switch pass {
        case .glow:
            if let glow = recipe.glow {
                drawShadow(glow, in: &context, faceRect: faceRect)
            }
        case .cast:
            drawShadow(recipe.cast, in: &context, faceRect: faceRect)
        case .contact:
            drawShadow(recipe.contact, in: &context, faceRect: faceRect)
        case .linearFace:
            context.fill(facePath, with: .linearGradient(
                Gradient(colors: [recipe.linearTop, recipe.linearBottom]),
                startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
            ))
        case .radialConcavity:
            drawRadial(in: &context, faceRect: faceRect, facePath: facePath, recipe: recipe)
        case .insideBorder:
            context.stroke(
                shape.path(in: faceRect, inset: DesignCanvasGeometry.insideStrokePathInset()),
                with: .color(recipe.border),
                lineWidth: DesignMetrics.hairline
            )
        case .directionalTopLight:
            drawTopLight(
                recipe.topLight.opacity(recipe.topLightOpacity),
                in: &context,
                faceRect: faceRect
            )
        case .pressedInnerOcclusion:
            if recipe.pressedInnerOcclusionOpacity > 0 {
                DesignCanvasEffects.insetShadow(
                    in: &context,
                    facePath: facePath,
                    sourcePath: facePath,
                    color: recipe.pressedInnerOcclusion.opacity(recipe.pressedInnerOcclusionOpacity),
                    blur: DesignMaterialAdapter.slatePressedInsetBlur,
                    y: DesignMaterialAdapter.slatePressedInsetY
                )
            }
        case .focusRing:
            if recipe.focusOpacity > 0 {
                context.stroke(
                    shape.path(in: faceRect, inset: DesignMetrics.focusBorderInset),
                    with: .color(recipe.focusRing.opacity(recipe.focusOpacity)),
                    lineWidth: recipe.focusLineWidth
                )
            }
        }
    }

    private func drawShadow(
        _ recipe: DesignCanvasShadowRecipe,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let source = shape.path(in: faceRect, inset: recipe.geometry.sourceInset)
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: recipe.color.opacity(recipe.opacity),
            blur: recipe.geometry.radius,
            x: recipe.geometry.x,
            y: recipe.geometry.y
        )
    }

    private func drawRadial(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path,
        recipe: DesignCanvasMaterialRecipe
    ) {
        var radial = context
        radial.clip(to: facePath)
        let center = CGPoint(
            x: faceRect.minX + faceRect.width * DesignMaterialAdapter.slateRadialCenterX,
            y: faceRect.minY + faceRect.height * DesignMaterialAdapter.slateRadialCenterY
        )
        let radius = CGSize(
            width: faceRect.width * DesignMaterialAdapter.slateRadialScale.width,
            height: faceRect.height * DesignMaterialAdapter.slateRadialScale.height
        )
        guard radius.width > 0, radius.height > 0 else { return }

        let stops: [Gradient.Stop]
        switch recipe.radialStyle {
        case .concaveThreeStop:
            guard let ring = recipe.radialRing, let centerStop = recipe.radialCenterStop else { return }
            stops = [
                .init(color: recipe.radialCenter, location: 0),
                .init(color: ring, location: centerStop),
                .init(color: ring.opacity(0), location: recipe.radialFadeStop),
            ]
        case .mutedTwoStop:
            stops = [
                .init(color: recipe.radialCenter, location: 0),
                .init(color: recipe.radialCenter.opacity(0), location: recipe.radialFadeStop),
            ]
        }

        radial.translateBy(x: center.x, y: center.y)
        radial.scaleBy(x: radius.width, y: radius.height)
        radial.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: stops),
                center: .zero,
                startRadius: DesignMaterialAdapter.slateRadialStartRadiusFraction,
                endRadius: DesignMaterialAdapter.slateRadialEndRadiusFraction
            )
        )
    }

    private func drawTopLight(_ color: Color, in context: inout GraphicsContext, faceRect: CGRect) {
        let inner = shape.path(in: faceRect, inset: DesignMetrics.hairline)
        var translated = Path()
        translated.addPath(inner, transform: CGAffineTransform(
            translationX: 0,
            y: DesignMetrics.hairline
        ))
        var difference = Path()
        difference.addPath(inner)
        difference.addPath(translated)

        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
    }
}

/// Decorative-only recessed-well renderer. Install it behind a measured native
/// control face. The kernel owns no content, responder, gesture, accessibility
/// semantics, or clock; its stable transparent overflow never changes layout.
struct DesignCanvasWellKernel: View, Animatable {
    let shape: DesignCanvasShape
    let state: DesignCanvasWellState
    var increasedContrast = false
    var reduceMotion = false
    var showsBorder = true
    var showsInsetHighlights = true

    private var focusAmount: CGFloat
    private var validatedErrorAmount: CGFloat


    @Environment(\.displayScale) private var displayScale

    init(
        shape: DesignCanvasShape,
        state: DesignCanvasWellState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false,
        showsBorder: Bool = true,
        showsInsetHighlights: Bool = true
    ) {
        self.shape = shape
        self.state = state
        self.increasedContrast = increasedContrast
        self.reduceMotion = reduceMotion
        self.showsBorder = showsBorder
        self.showsInsetHighlights = showsInsetHighlights
        let values = DesignCanvasWellAnimationValues(state: state)
        focusAmount = values.focus
        validatedErrorAmount = values.validatedError
    }


    var animationValues: DesignCanvasWellAnimationValues {
        DesignCanvasWellAnimationValues(
            focus: focusAmount,
            validatedError: validatedErrorAmount
        )
    }

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(focusAmount, validatedErrorAmount) }
        set {
            focusAmount = newValue.first
            validatedErrorAmount = newValue.second
        }
    }

    static func transitionAnimation(
        for transition: DesignCanvasTransition,
        reduceMotion: Bool
    ) -> Animation? {
        transition.animation(reduceMotion: reduceMotion)
    }

    var body: some View {
        GeometryReader { proxy in
            let recipe = DesignCanvasWellRecipe.make(
                state: state,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion,
                animationValues: animationValues
            )
            let overflow = DesignCanvasGeometry.overflow(for: recipe, displayScale: displayScale)
            let fieldSize = CGSize(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            let faceRect = DesignCanvasGeometry.faceRect(
                faceSize: proxy.size,
                overflow: overflow,
                displayScale: displayScale
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                for pass in DesignCanvasWellPass.ordered {
                    draw(pass, in: &context, faceRect: faceRect, recipe: recipe)
                }
            }
            .frame(width: fieldSize.width, height: fieldSize.height)
            .offset(x: -overflow, y: -overflow)
        }
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func draw(
        _ pass: DesignCanvasWellPass,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        recipe: DesignCanvasWellRecipe
    ) {
        let facePath = shape.path(in: faceRect)
        switch pass {
        case .stateCast:
            drawOuterShadow(recipe.stateCast, in: &context, faceRect: faceRect)
        case .stateHalo:
            drawHalo(
                color: recipe.stateHaloColor,
                opacity: recipe.stateHaloOpacity,
                spread: recipe.stateHaloSpread,
                in: &context,
                faceRect: faceRect,
                facePath: facePath
            )
        case .contact:
            drawOuterShadow(recipe.contact, in: &context, faceRect: faceRect)
        case .linearFace:
            context.fill(facePath, with: .linearGradient(
                Gradient(stops: [
                    .init(color: recipe.faceTop, location: 0),
                    .init(color: recipe.faceMiddle, location: recipe.faceMiddleStop),
                    .init(color: recipe.faceBottom, location: 1),
                ]),
                startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
            ))
        case .upperInnerOcclusion:
            if showsInsetHighlights {
                let upperInnerOcclusion = recipe.upperInnerOcclusion
                drawInsetOcclusion(
                    color: recipe.upperInnerOcclusionColor,
                    opacity: recipe.upperInnerOcclusionOpacity,
                    geometry: upperInnerOcclusion,
                    in: &context,
                    faceRect: faceRect,
                    facePath: facePath
                )
            }
        case .lowerInnerReflection:
            if showsInsetHighlights {
                drawLowerInnerReflection(
                    color: recipe.lowerInnerReflectionColor,
                    opacity: recipe.lowerInnerReflectionOpacity,
                    y: recipe.lowerInnerReflectionY,
                    inset: recipe.lowerInnerReflectionInset,
                    in: &context,
                    faceRect: faceRect,
                    facePath: facePath
                )
            }
        case .insideBorder:
            if showsBorder {
                context.stroke(
                    shape.path(
                        in: faceRect,
                        inset: DesignCanvasGeometry.insideStrokePathInset(
                            lineWidth: recipe.borderLineWidth
                        )
                    ),
                    with: .color(recipe.border),
                    lineWidth: recipe.borderLineWidth
                )
            }
        case .focusOutline:
            guard recipe.focusOutlineOpacity > 0 else { return }
            context.stroke(
                shape.path(
                    in: faceRect,
                    inset: DesignCanvasGeometry.outsideStrokePathInset(
                        offset: recipe.focusOutlineOffset,
                        lineWidth: recipe.focusOutlineLineWidth
                    )
                ),
                with: .color(recipe.focusOutline.opacity(recipe.focusOutlineOpacity)),
                lineWidth: recipe.focusOutlineLineWidth
            )
        }
    }

    private func drawOuterShadow(
        _ recipe: DesignCanvasShadowRecipe,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        guard recipe.opacity > 0 else { return }
        var source = Path()
        source.addPath(
            shape.path(in: faceRect, inset: recipe.geometry.sourceInset),
            transform: CGAffineTransform(
                translationX: recipe.geometry.x,
                y: recipe.geometry.y
            )
        )
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: recipe.color.opacity(recipe.opacity),
            blur: recipe.geometry.radius
        )
    }

    private func drawHalo(
        color: Color,
        opacity: Double,
        spread: CGFloat,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        guard opacity > 0, spread > 0 else { return }
        var ring = Path()
        ring.addPath(shape.path(in: faceRect, inset: -spread))
        ring.addPath(facePath)
        context.fill(
            ring,
            with: .color(color.opacity(opacity)),
            style: FillStyle(eoFill: true)
        )
    }

    private func drawInsetOcclusion(
        color: Color,
        opacity: Double,
        geometry: DesignCanvasInsetShadowGeometry,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        guard opacity > 0 else { return }
        // A CSS spread of -2 grows this inverted-alpha source by two points.
        // Reversing that sign produces a visibly deeper seeded inner ring.
        let sourcePath = geometry.sourcePath(shape: shape, in: faceRect)
        DesignCanvasEffects.insetShadow(
            in: &context,
            facePath: facePath,
            sourcePath: sourcePath,
            color: color.opacity(opacity),
            blur: geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    private func drawLowerInnerReflection(
        color: Color,
        opacity: Double,
        y: CGFloat,
        inset: CGFloat,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        guard opacity > 0, y != 0 else { return }
        let directionalDifference = DesignCanvasGeometry.directionalInnerEdgePath(
            shape: shape,
            faceRect: faceRect,
            inset: inset,
            translationY: y
        )

        var reflection = context
        reflection.clip(to: facePath)
        reflection.fill(
            directionalDifference,
            with: .color(color.opacity(opacity)),
            style: FillStyle(eoFill: true)
        )
    }
}

// MARK: - Selection and range foundation

/// Selection-specific timings stay separate from the generic key material.
/// Callers choose whether to install the returned animation; the kernel owns
/// neither a clock nor a transition trigger.
enum DesignCanvasSmallControlTransition: CaseIterable {
    case feedback
    case press
    case material
    case selectionTravel
    case toggleTravel

    func duration(reduceMotion: Bool) -> Double? {
        guard !reduceMotion else { return nil }
        return switch self {
        case .feedback:
            DesignV2.Motion.feedback
        case .press:
            0.07
        case .material:
            DesignV2.Motion.state
        case .selectionTravel:
            DesignMaterialAdapter.smallControlSelectionTravelDuration
        case .toggleTravel:
            DesignMetrics.toggleAnimationDuration
        }
    }

    func animation(reduceMotion: Bool) -> Animation? {
        guard let duration = duration(reduceMotion: reduceMotion) else { return nil }
        switch self {
        case .selectionTravel, .toggleTravel:
            return .timingCurve(
                DesignMaterialAdapter.smallControlTravelCurveX1,
                DesignMaterialAdapter.smallControlTravelCurveY1,
                DesignMaterialAdapter.smallControlTravelCurveX2,
                DesignMaterialAdapter.smallControlTravelCurveY2,
                duration: duration
            )
        case .feedback, .material:
            return DesignV2.Motion.animation(duration: duration, reduceMotion: false)
        case .press:
            return .timingCurve(0.25, 0.1, 0.25, 1, duration: duration)
        }
    }
}

/// Pure caller-owned transition geometry. Reduced Motion resolves directly to
/// the destination instead of shortening travel to an imperceptible duration.
enum DesignCanvasMotionGeometry {
    static func resolved(
        from source: CGFloat,
        to destination: CGFloat,
        progress: CGFloat,
        reduceMotion: Bool
    ) -> CGFloat {
        if reduceMotion { return destination }
        return .lerp(source, destination, by: progress)
    }
}

struct DesignCanvasMeasuredSelection: Equatable {
    let id: AnyHashable
    let bounds: CGRect
}

/// Resolves a caller's measured option frames without assuming equal widths or
/// physical left-to-right ordering. Unsupported selections intentionally yield
/// no indicator and never mutate the caller's value.
enum DesignCanvasMeasuredSelectionGeometry {
    static func bounds(
        selectedID: AnyHashable?,
        measurements: [DesignCanvasMeasuredSelection]
    ) -> CGRect? {
        guard let selectedID,
              let match = measurements.first(where: { $0.id == selectedID }),
              match.bounds.width > 0,
              match.bounds.height > 0,
              !match.bounds.isNull,
              !match.bounds.isInfinite
        else { return nil }
        return match.bounds
    }

    static func interpolatedBounds(
        from source: CGRect?,
        to destination: CGRect?,
        progress: CGFloat,
        reduceMotion: Bool
    ) -> CGRect? {
        guard let destination else { return nil }
        guard let source, !reduceMotion else { return destination }
        return CGRect(
            x: .lerp(source.minX, destination.minX, by: progress),
            y: .lerp(source.minY, destination.minY, by: progress),
            width: .lerp(source.width, destination.width, by: progress),
            height: .lerp(source.height, destination.height, by: progress)
        )
    }
}

struct DesignCanvasSliderGeometry: Equatable {
    let normalizedProgress: CGFloat
    let resolvedProgress: CGFloat
    let trackRect: CGRect
    let progressRect: CGRect
    let thumbRect: CGRect
}

/// Pure normalization and direction mapping for decorative range chrome. The
/// native Slider remains in the ambient layout direction and owns adjustment.
enum DesignCanvasProgressGeometry {
    static func normalized(
        value: Double,
        lowerBound: Double,
        upperBound: Double
    ) -> CGFloat {
        guard value.isFinite,
              lowerBound.isFinite,
              upperBound.isFinite,
              upperBound > lowerBound
        else { return 0 }
        return CGFloat((value - lowerBound) / (upperBound - lowerBound)).clamped
    }

    static func resolved(
        normalizedProgress: CGFloat,
        layoutDirection: LayoutDirection
    ) -> CGFloat {
        let normalized = normalizedProgress.clamped
        return layoutDirection == .rightToLeft ? 1 - normalized : normalized
    }

    static func slider(
        in bounds: CGRect,
        normalizedProgress: CGFloat,
        layoutDirection: LayoutDirection
    ) -> DesignCanvasSliderGeometry {
        let thumbDiameter = min(
            DesignMetrics.sliderThumbSize,
            max(0, min(bounds.width, bounds.height))
        )
        let trackHeight = min(DesignMetrics.sliderTrackHeight, max(0, bounds.height))
        let horizontalInset = min(thumbDiameter / 2, max(0, bounds.width / 2))
        let trackRect = CGRect(
            x: bounds.minX + horizontalInset,
            y: bounds.midY - trackHeight / 2,
            width: max(0, bounds.width - horizontalInset * 2),
            height: trackHeight
        )
        let normalized = normalizedProgress.clamped
        let resolved = resolved(
            normalizedProgress: normalized,
            layoutDirection: layoutDirection
        )
        let thumbCenterX = trackRect.minX + trackRect.width * resolved
        let thumbRect = CGRect(
            x: thumbCenterX - thumbDiameter / 2,
            y: bounds.midY - thumbDiameter / 2,
            width: thumbDiameter,
            height: thumbDiameter
        )
        let progressRect: CGRect
        if layoutDirection == .rightToLeft {
            progressRect = CGRect(
                x: thumbCenterX,
                y: trackRect.minY,
                width: max(0, trackRect.maxX - thumbCenterX),
                height: trackRect.height
            )
        } else {
            progressRect = CGRect(
                x: trackRect.minX,
                y: trackRect.minY,
                width: max(0, thumbCenterX - trackRect.minX),
                height: trackRect.height
            )
        }
        return DesignCanvasSliderGeometry(
            normalizedProgress: normalized,
            resolvedProgress: resolved,
            trackRect: trackRect,
            progressRect: progressRect,
            thumbRect: thumbRect
        )
    }
}

struct DesignCanvasToggleGeometry: Equatable {
    let resolvedOnAmount: CGFloat
    let trackRect: CGRect
    let knobRect: CGRect

    static func make(
        in bounds: CGRect,
        onAmount: CGFloat,
        layoutDirection: LayoutDirection
    ) -> DesignCanvasToggleGeometry {
        let amount = onAmount.clamped
        let resolved = layoutDirection == .rightToLeft ? 1 - amount : amount
        let knobSize = min(
            DesignMetrics.toggleKnobSize,
            max(0, min(bounds.width, bounds.height))
        )
        let knobX = bounds.minX
            + DesignMaterialAdapter.toggleKnobInset
            + DesignMetrics.toggleTravel * resolved
        return DesignCanvasToggleGeometry(
            resolvedOnAmount: resolved,
            trackRect: bounds,
            knobRect: CGRect(
                x: knobX,
                y: bounds.minY + DesignMaterialAdapter.toggleKnobInset,
                width: knobSize,
                height: knobSize
            )
        )
    }
}

struct DesignCanvasSegmentGeometry: Equatable {
    var selectionBounds: CGRect?
    var focusBounds: CGRect?
    var pressedBounds: CGRect?

    init(
        selectionBounds: CGRect?,
        focusBounds: CGRect? = nil,
        pressedBounds: CGRect? = nil
    ) {
        self.selectionBounds = selectionBounds
        self.focusBounds = focusBounds
        self.pressedBounds = pressedBounds
    }
}

/// Every case is an approved, explicit material profile. Selection/range
/// chrome never passes through `DesignButtonRole`.
enum DesignCanvasSmallControlProfile: Equatable {
    case raisedChip
    case selectedChip
    case selectedCompact
    case segmented(geometry: DesignCanvasSegmentGeometry)
    case toggle(onAmount: CGFloat, layoutDirection: LayoutDirection)
    case checkbox(isChecked: Bool)
    case slider(normalizedProgress: CGFloat, layoutDirection: LayoutDirection)
}

enum DesignCanvasCompactSlateProfile: String, Equatable {
    case raisedChip
    case segmentSelection
    case toggleKnobOff
    case toggleKnobOn
    case checkboxChecked
    case checkboxDisabled
    case sliderThumb
}

enum DesignCanvasReceiverProfile: String, Equatable {
    case selectedChip
    case selectedCompact
    case segmentedBed
    case toggleTrack
    case checkboxReceiver
    case sliderTrack
}

enum DesignCanvasCompactRadialProfile: Equatable {
    case canonicalThreeStop
    case softenedTwoStop
    case mutedTwoStop
}

enum DesignCanvasCompactRadialRadius: Equatable {
    case canonicalEllipse
    case farthestCornerCircle
}

/// Profile-resolved CSS radial geometry. Canonical compact slates retain the
/// established ellipse; checked and range-thumb faces use the reviewed
/// `circle farthest-corner at 50% 55%` projection.
struct DesignCanvasCompactRadialGeometry: Equatable {
    let centerX: CGFloat
    let centerY: CGFloat
    let radius: DesignCanvasCompactRadialRadius

    static let canonicalEllipse = DesignCanvasCompactRadialGeometry(
        centerX: DesignMaterialAdapter.slateRadialCenterX,
        centerY: DesignMaterialAdapter.slateRadialCenterY,
        radius: .canonicalEllipse
    )

    static let softenedCircle = DesignCanvasCompactRadialGeometry(
        centerX: DesignMaterialAdapter.compactCircularRadialCenterX,
        centerY: DesignMaterialAdapter.compactCircularRadialCenterY,
        radius: .farthestCornerCircle
    )

    func center(in rect: CGRect) -> CGPoint {
        CGPoint(
            x: rect.minX + rect.width * centerX,
            y: rect.minY + rect.height * centerY
        )
    }

    func farthestCornerRadius(in rect: CGRect) -> CGFloat {
        let center = center(in: rect)
        let horizontal = max(center.x - rect.minX, rect.maxX - center.x)
        let vertical = max(center.y - rect.minY, rect.maxY - center.y)
        return hypot(horizontal, vertical)
    }
}

/// Scale-aware source geometry preserves at least one device pixel in compact
/// 18/22/26pt faces.
struct DesignCanvasCompactSlateRecipe {
    let profile: DesignCanvasCompactSlateProfile
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let activationAmount: CGFloat
    let faceProjection: DesignMaterialNativeProjection
    let shadowProjection: DesignMaterialNativeProjection
    let radialProfile: DesignCanvasCompactRadialProfile
    let radialGeometry: DesignCanvasCompactRadialGeometry
    let linearTop: Color
    let linearBottom: Color
    let radialCenter: Color
    let radialRing: Color?
    let radialCenterStop: CGFloat?
    let radialFadeStop: CGFloat
    let border: Color
    let borderLineWidth: CGFloat
    let topLight: Color
    let topLightOpacity: Double
    let pressedInnerOcclusion: Color
    let pressedInnerOcclusionOpacity: Double
    let focusRing: Color
    let focusOpacity: Double
    let focusLineWidth: CGFloat
    let glow: DesignCanvasShadowRecipe?
    let cast: DesignCanvasShadowRecipe
    let contact: DesignCanvasShadowRecipe

    static func make(
        profile: DesignCanvasCompactSlateProfile,
        state: DesignCanvasControlState,
        activationAmount suppliedActivation: CGFloat? = nil,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false
    ) -> DesignCanvasCompactSlateRecipe {
        let activation = suppliedActivation?.clamped ?? (profile == .toggleKnobOn ? 1 : 0)
        let disabled = state.isDisabled
        let hover: CGFloat = disabled ? 0 : state.isHovered ? 1 : 0
        let press: CGFloat = disabled ? 0 : state.isPressed ? 1 : 0
        let focus: CGFloat = disabled ? 0 : state.isFocused ? 1 : 0

        let base: Color = if disabled {
            DuskColors.bgElev.overlaying(
                DuskColors.ink4,
                opacity: DesignMaterialAdapter.slateDisabledBaseInkMix
            )
        } else {
            switch profile {
            case .raisedChip, .sliderThumb:
                DuskColors.paper
            case .segmentSelection:
                DuskColors.accent50
            case .toggleKnobOff, .toggleKnobOn:
                DuskColors.paper.interpolated(to: DuskColors.accent, amount: activation)
            case .checkboxChecked:
                DuskColors.accent
            case .checkboxDisabled:
                DuskColors.bgElev
            }
        }

        let softenedRadial = profile == .checkboxChecked || profile == .sliderThumb
        let radialProfile: DesignCanvasCompactRadialProfile = disabled
            ? .mutedTwoStop
            : softenedRadial ? .softenedTwoStop : .canonicalThreeStop
        let radialGeometry: DesignCanvasCompactRadialGeometry = softenedRadial
            ? .softenedCircle
            : .canonicalEllipse
        let linearInkMix: Double = switch profile {
        case .checkboxChecked:
            DesignMaterialAdapter.checkboxCheckedLinearInkMix
        case .sliderThumb:
            DesignMaterialAdapter.sliderThumbLinearInkMix
        default:
            DesignMaterialAdapter.slateBaseLight
        }
        let restLinearTop = disabled
            ? base.overlaying(DuskColors.ink4, opacity: DesignMaterialAdapter.slateMutedBaseLight)
            : base.overlaying(
                profile == .sliderThumb ? DuskColors.ink2 : DuskColors.ink,
                opacity: linearInkMix
            )
        let hoverLinearTop = base.overlaying(
            DuskColors.ink,
            opacity: DesignMaterialAdapter.slateHoverBaseLight
        )
        let linearTop = restLinearTop.interpolated(to: hoverLinearTop, amount: hover)
        let linearBottom = base.interpolated(
            to: base.overlaying(DuskColors.accent, opacity: DesignMaterialAdapter.slateHoverGlow),
            amount: hover
        )

        let radialSunkMix: CGFloat = if disabled {
            DesignMaterialAdapter.slateMutedCenterSunk
        } else if profile == .checkboxChecked {
            DesignMaterialAdapter.checkboxCheckedRadialSunkMix
        } else if profile == .sliderThumb {
            DesignMaterialAdapter.sliderThumbRadialSunkMix
        } else {
            .lerp(
                DesignMaterialAdapter.slateCenterSunk,
                DesignMaterialAdapter.slateHoverCenterSunk,
                by: hover
            )
        }
        let radialRingMix = CGFloat.lerp(
            DesignMaterialAdapter.slateRingSunk,
            DesignMaterialAdapter.slateHoverRingSunk,
            by: hover
        )
        let radialFadeStop: CGFloat = if disabled {
            DesignMaterialAdapter.slateMutedFadeStop
        } else if profile == .checkboxChecked {
            DesignMaterialAdapter.checkboxCheckedRadialFadeStop
        } else if profile == .sliderThumb {
            DesignMaterialAdapter.sliderThumbRadialFadeStop
        } else {
            DesignMaterialAdapter.slateFadeStop
        }

        let restCast = restCast(for: profile)
        let castGeometry = restCast.geometry
            .interpolated(to: DesignMaterialShadowGeometry.slateHover, amount: hover)
            .interpolated(to: DesignMaterialShadowGeometry.slatePressed, amount: press)
        let castOpacity = disabled
            ? DesignMaterialAdapter.slateDisabledBlack
            : Double.lerp(
                Double.lerp(restCast.opacity, DesignMaterialAdapter.slateHoverBlack, by: hover),
                DesignMaterialAdapter.slatePressedBlack,
                by: press
            )

        let restGlow = restGlow(for: profile)
        let glowOpacity = Double.lerp(
            Double.lerp(restGlow?.opacity ?? 0, DesignMaterialAdapter.slateHoverGlowOpacity, by: hover),
            0,
            by: press
        )
        let glowGeometry = (restGlow?.geometry ?? DesignMaterialShadowGeometry.slateGlow)
            .interpolated(to: DesignMaterialShadowGeometry.slateHoverGlow, amount: hover)

        let restContact = restContact(for: profile)
        let interactiveContact = DesignCanvasShadowRecipe(
            color: DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateInteractiveContactMix
            ),
            opacity: 1,
            geometry: DesignDropShadowGeometry(
                radius: 0,
                y: DesignMetrics.pressedDepth,
                sourceInset: DesignMetrics.hairline
            )
        )
        let contact: DesignCanvasShadowRecipe
        if disabled {
            contact = DesignCanvasShadowRecipe(
                color: DuskColors.bgSunk.overlaying(
                    DuskColors.line,
                    opacity: DesignMaterialAdapter.slateDisabledContactMix
                ),
                opacity: 1,
                geometry: DesignDropShadowGeometry(
                    radius: 0,
                    y: DesignMaterialAdapter.slateDisabledContactY,
                    sourceInset: DesignMetrics.hairline
                )
            )
        } else if hover > 0 || press > 0 {
            contact = DesignCanvasShadowRecipe(
                color: restContact.color.interpolated(
                    to: interactiveContact.color,
                    amount: max(hover, press)
                ),
                opacity: 1,
                geometry: restContact.geometry.interpolated(
                    to: interactiveContact.geometry,
                    amount: max(hover, press)
                )
            )
        } else {
            contact = restContact
        }

        let restBorder = restBorder(for: profile)
        let profileBorder = if profile == .toggleKnobOff || profile == .toggleKnobOn {
            restBorder.interpolated(to: DuskColors.accent, amount: activation)
        } else {
            restBorder
        }
        let border: Color = if disabled {
            DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        } else if increasedContrast {
            DuskColors.ink3
        } else {
            profileBorder
        }
        let faceRole: DesignV2.MaterialRole = disabled
            ? .slateFaceMuted
            : state.isHovered ? .slateFaceHover : .slateFace
        let shadowRole: DesignV2.MaterialRole = disabled
            ? .slateShadowDisabled
            : state.isPressed ? .slateShadowPressed : state.isHovered ? .slateShadowHover : .slateShadow

        return DesignCanvasCompactSlateRecipe(
            profile: profile,
            state: state,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            activationAmount: activation,
            faceProjection: DesignMaterialAdapter.nativeProjection(for: faceRole),
            shadowProjection: DesignMaterialAdapter.nativeProjection(for: shadowRole),
            radialProfile: radialProfile,
            radialGeometry: radialGeometry,
            linearTop: linearTop,
            linearBottom: linearBottom,
            radialCenter: base.overlaying(DuskColors.bgSunk, opacity: radialSunkMix),
            radialRing: radialProfile == .canonicalThreeStop
                ? base.overlaying(DuskColors.bgSunk, opacity: radialRingMix)
                : nil,
            radialCenterStop: radialProfile == .canonicalThreeStop
                ? DesignMaterialAdapter.slateCenterStop
                : nil,
            radialFadeStop: radialFadeStop,
            border: border,
            borderLineWidth: DesignMetrics.hairline,
            topLight: DuskColors.ink.opacity(
                disabled
                    ? DesignMaterialAdapter.slateDisabledTopLight
                    : DesignMaterialAdapter.slateTopLightRest
            ),
            topLightOpacity: softenedRadial ? 0 : Double(1 - press),
            pressedInnerOcclusion: DuskColors.bgSunk,
            pressedInnerOcclusionOpacity: DesignMaterialAdapter.slatePressedInsetOpacity
                * Double(press),
            focusRing: DuskColors.accent,
            focusOpacity: Double(focus),
            focusLineWidth: increasedContrast ? DesignMetrics.focusRing : DesignMetrics.focusBorder,
            glow: disabled || glowOpacity == 0
                ? nil
                : DesignCanvasShadowRecipe(
                    color: DuskColors.accent,
                    opacity: glowOpacity,
                    geometry: glowGeometry
                ),
            cast: DesignCanvasShadowRecipe(
                color: .black,
                opacity: castOpacity,
                geometry: disabled ? DesignMaterialShadowGeometry.slateDisabled : castGeometry
            ),
            contact: contact
        )
    }

    private static func restCast(
        for profile: DesignCanvasCompactSlateProfile
    ) -> DesignCanvasShadowRecipe {
        switch profile {
        case .raisedChip:
            DesignCanvasShadowRecipe(
                color: .black,
                opacity: DesignMaterialAdapter.chipCastOpacity,
                geometry: DesignDropShadowGeometry(
                    radius: DesignMaterialAdapter.chipCastBlur,
                    y: DesignMaterialAdapter.chipCastY,
                    sourceInset: DesignMaterialAdapter.chipCastInset
                )
            )
        case .checkboxChecked:
            DesignCanvasShadowRecipe(
                color: .black,
                opacity: DesignMaterialAdapter.checkboxCastOpacity,
                geometry: DesignDropShadowGeometry(
                    radius: DesignMaterialAdapter.checkboxCastBlur,
                    y: DesignMaterialAdapter.checkboxCastY,
                    sourceInset: DesignMaterialAdapter.checkboxCastInset
                )
            )
        case .segmentSelection, .toggleKnobOff, .toggleKnobOn, .checkboxDisabled, .sliderThumb:
            DesignCanvasShadowRecipe(
                color: .black,
                opacity: DesignMaterialAdapter.slateRestBlack,
                geometry: DesignMaterialShadowGeometry.slateRest
            )
        }
    }

    private static func restGlow(
        for profile: DesignCanvasCompactSlateProfile
    ) -> DesignCanvasShadowRecipe? {
        switch profile {
        case .raisedChip, .checkboxDisabled:
            nil
        case .checkboxChecked:
            DesignCanvasShadowRecipe(
                color: DuskColors.accent,
                opacity: DesignMaterialAdapter.checkboxGlowOpacity,
                geometry: DesignDropShadowGeometry(
                    radius: DesignMaterialAdapter.checkboxGlowBlur,
                    y: DesignMaterialAdapter.checkboxGlowY,
                    sourceInset: DesignMaterialAdapter.checkboxGlowInset
                )
            )
        case .sliderThumb:
            DesignCanvasShadowRecipe(
                color: DuskColors.accent,
                opacity: DesignMaterialAdapter.sliderThumbGlowOpacity,
                geometry: DesignDropShadowGeometry(
                    radius: DesignMaterialAdapter.sliderThumbGlowBlur,
                    y: DesignMaterialAdapter.sliderThumbGlowY,
                    sourceInset: DesignMaterialAdapter.sliderThumbGlowInset
                )
            )
        case .segmentSelection, .toggleKnobOff, .toggleKnobOn:
            DesignCanvasShadowRecipe(
                color: DuskColors.accent,
                opacity: DesignMaterialAdapter.slateDefaultGlow,
                geometry: DesignMaterialShadowGeometry.slateGlow
            )
        }
    }

    private static func restContact(
        for profile: DesignCanvasCompactSlateProfile
    ) -> DesignCanvasShadowRecipe {
        if profile == .raisedChip {
            return DesignCanvasShadowRecipe(
                color: DuskColors.bgSunk,
                opacity: 1,
                geometry: DesignDropShadowGeometry(
                    radius: 0,
                    y: DesignMaterialAdapter.chipContactY,
                    sourceInset: DesignMetrics.hairline
                )
            )
        }
        return DesignCanvasShadowRecipe(
            color: DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateSecondaryContactMix
            ),
            opacity: 1,
            geometry: DesignDropShadowGeometry(
                radius: 0,
                y: DesignMaterialAdapter.slateContactY,
                sourceInset: DesignMetrics.hairline
            )
        )
    }

    private static func restBorder(for profile: DesignCanvasCompactSlateProfile) -> Color {
        switch profile {
        case .raisedChip, .sliderThumb:
            DuskColors.line
        case .segmentSelection:
            DuskColors.lineSoft.overlaying(
                DuskColors.accent,
                opacity: DesignMaterialAdapter.segmentSelectionBorderAccentMix
            )
        case .toggleKnobOff:
            DuskColors.ink.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.toggleKnobOffBorderLineMix
            )
        case .toggleKnobOn:
            DuskColors.accent
        case .checkboxChecked:
            DuskColors.line.overlaying(
                DuskColors.accent,
                opacity: DesignMaterialAdapter.checkboxCheckedBorderAccentMix
            )
        case .checkboxDisabled:
            DuskColors.lineSoft
        }
    }
}

struct DesignCanvasReceiverRecipe {
    let profile: DesignCanvasReceiverProfile
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let activationAmount: CGFloat
    let well: DesignCanvasWellRecipe
    let extraCast: DesignCanvasShadowRecipe?
    let pressCast: DesignCanvasShadowRecipe?
    let faceTop: Color
    let faceMiddle: Color
    let faceBottom: Color
    let border: Color
    let contactColor: Color
    let contactOpacity: Double
    let contactGeometry: DesignDropShadowGeometry
    let upperInnerOcclusionOpacity: Double
    let upperInnerOcclusion: DesignCanvasInsetShadowGeometry
    let lowerInnerReflectionOpacity: Double
    let stateHaloOpacity: Double
    let focusOutlineOpacity: Double
    let drawsSliderProgressFace: Bool

    static func make(
        profile: DesignCanvasReceiverProfile,
        state: DesignCanvasControlState,
        activationAmount: CGFloat = 0,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false
    ) -> DesignCanvasReceiverRecipe {
        let disabled = state.isDisabled
        let press: CGFloat = disabled ? 0 : state.isPressed ? 1 : 0
        let focus: CGFloat = disabled ? 0 : state.isFocused ? 1 : 0
        let activation = activationAmount.clamped
        let well = DesignCanvasWellRecipe.make(
            state: disabled ? .disabled : .rest,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )

        var faceTop = well.faceTop
        var faceMiddle = well.faceMiddle
        var faceBottom = well.faceBottom
        var border = well.border
        var extraCast: DesignCanvasShadowRecipe?
        var pressCast: DesignCanvasShadowRecipe?
        var contactColor = well.contact.color
        var contactOpacity = well.contact.opacity
        var contactGeometry = well.contact.geometry
        var upperOpacity = well.upperInnerOcclusionOpacity
        var upperGeometry = well.upperInnerOcclusion
        var lowerOpacity = well.lowerInnerReflectionOpacity
        var haloOpacity = 0.0
        var focusOutlineOpacity = Double(focus)
        var drawsSliderProgressFace = false

        switch profile {
        case .selectedChip:
            border = increasedContrast ? DuskColors.ink3 : .clear
            if press > 0 {
                contactOpacity = 0
                lowerOpacity = 0
                upperOpacity = Double.lerp(
                    upperOpacity,
                    DesignMaterialAdapter.chipSelectedPressedInsetOpacity,
                    by: press
                )
                upperGeometry = DesignCanvasInsetShadowGeometry(
                    radius: DesignMaterialAdapter.chipSelectedPressedInsetBlur,
                    x: 0,
                    y: DesignMaterialAdapter.chipSelectedPressedInsetY,
                    spread: DesignMaterialAdapter.chipSelectedPressedInsetSpread
                )
            } else {
                extraCast = DesignCanvasShadowRecipe(
                    color: DuskColors.accent,
                    opacity: DesignMaterialAdapter.chipSelectedGlowOpacity,
                    geometry: DesignDropShadowGeometry(
                        radius: DesignMaterialAdapter.chipSelectedGlowBlur,
                        y: DesignMaterialAdapter.chipSelectedGlowY,
                        sourceInset: DesignMaterialAdapter.chipSelectedGlowInset
                    )
                )
            }
        case .selectedCompact:
            // This generic rounded-rectangle receiver is intentionally not an
            // alias of the capsule selected-chip recipe. It reproduces the
            // existing selected compact well, including its native inset
            // adaptation and quieter 40% accent cast.
            border = .clear
            contactColor = DuskColors.bgSunk
            contactOpacity = DesignMaterialAdapter.selectedCompactContactOpacity
            contactGeometry = DesignDropShadowGeometry(
                radius: 0,
                y: DesignMaterialAdapter.selectedCompactContactY,
                sourceInset: DesignMaterialAdapter.selectedCompactContactInset
            )
            upperOpacity = DesignMaterialAdapter.wellInsetOpacity
            upperGeometry = DesignCanvasInsetShadowGeometry(
                radius: DesignMaterialAdapter.wellInsetBlur,
                x: 0,
                y: DesignMaterialAdapter.wellInsetY,
                spread: 0
            )
            lowerOpacity = DesignMaterialAdapter.wellBottomHighlight
            if press > 0 {
                pressCast = DesignCanvasShadowRecipe(
                    color: .black,
                    opacity: DesignMaterialAdapter.slatePressedBlack,
                    geometry: DesignMaterialShadowGeometry.slatePressed
                )
            } else {
                extraCast = DesignCanvasShadowRecipe(
                    color: DuskColors.accent,
                    opacity: DesignMaterialAdapter.selectedCompactRestCastOpacity,
                    geometry: DesignDropShadowGeometry(
                        radius: DesignMaterialAdapter.selectedCompactRestCastBlur,
                        y: DesignMaterialAdapter.selectedCompactRestCastY,
                        sourceInset: DesignMaterialAdapter.selectedCompactRestCastInset
                    )
                )
            }
        case .segmentedBed:
            focusOutlineOpacity = 0
        case .toggleTrack:
            faceTop = well.faceTop.interpolated(
                to: DuskColors.accentSoft.overlaying(
                    DuskColors.bgSunk,
                    opacity: 1 - DesignMaterialAdapter.toggleTrackOnTopAccentSoftMix
                ),
                amount: activation
            )
            faceMiddle = well.faceMiddle.interpolated(to: DuskColors.accentSoft, amount: activation)
            faceBottom = well.faceBottom.interpolated(to: DuskColors.accentSoft, amount: activation)
            border = (increasedContrast ? DuskColors.ink3 : well.border).interpolated(
                to: increasedContrast
                    ? DuskColors.ink3
                    : DuskColors.line.overlaying(
                        DuskColors.accent,
                        opacity: DesignMaterialAdapter.toggleTrackBorderAccentMix
                    ),
                amount: activation
            )
            if activation > 0 {
                extraCast = DesignCanvasShadowRecipe(
                    color: DuskColors.accent,
                    opacity: DesignMaterialAdapter.toggleTrackGlowOpacity * Double(activation),
                    geometry: DesignDropShadowGeometry(
                        radius: DesignMaterialAdapter.toggleTrackGlowBlur,
                        y: DesignMaterialAdapter.toggleTrackGlowY,
                        sourceInset: DesignMaterialAdapter.toggleTrackGlowInset
                    )
                )
            }
        case .checkboxReceiver:
            if press > 0 {
                contactOpacity = 1
                lowerOpacity = 0
                upperOpacity = DesignMaterialAdapter.slatePressedInsetOpacity
                upperGeometry = DesignCanvasInsetShadowGeometry(
                    radius: DesignMaterialAdapter.slatePressedInsetBlur,
                    x: 0,
                    y: DesignMaterialAdapter.slatePressedInsetY,
                    spread: 0
                )
                pressCast = DesignCanvasShadowRecipe(
                    color: .black,
                    opacity: DesignMaterialAdapter.slatePressedBlack,
                    geometry: DesignMaterialShadowGeometry.slatePressed
                )
            }
        case .sliderTrack:
            drawsSliderProgressFace = true
            border = .clear
            focusOutlineOpacity = 0
            haloOpacity = DesignMaterialAdapter.wellCSSFocusHaloOpacity * Double(focus)
        }

        return DesignCanvasReceiverRecipe(
            profile: profile,
            state: state,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            activationAmount: activation,
            well: well,
            extraCast: extraCast,
            pressCast: pressCast,
            faceTop: faceTop,
            faceMiddle: faceMiddle,
            faceBottom: faceBottom,
            border: border,
            contactColor: contactColor,
            contactOpacity: contactOpacity,
            contactGeometry: contactGeometry,
            upperInnerOcclusionOpacity: upperOpacity,
            upperInnerOcclusion: upperGeometry,
            lowerInnerReflectionOpacity: lowerOpacity,
            stateHaloOpacity: haloOpacity,
            focusOutlineOpacity: focusOutlineOpacity,
            drawsSliderProgressFace: drawsSliderProgressFace
        )
    }
}

/// Pure profile projection used by consumers. Associated values remain
/// caller-owned; the recipe only chooses approved material roles.
struct DesignCanvasSmallControlRecipe {
    let profile: DesignCanvasSmallControlProfile
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let receiver: DesignCanvasReceiverRecipe?
    let slate: DesignCanvasCompactSlateRecipe?
    let globalSaturation: Double
    let globalOpacity: Double

    static func make(
        profile: DesignCanvasSmallControlProfile,
        state: DesignCanvasControlState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false
    ) -> DesignCanvasSmallControlRecipe {
        var resolvedState = state
        if state.isDisabled {
            resolvedState.isHovered = false
            resolvedState.isPressed = false
            resolvedState.isFocused = false
        }

        let receiver: DesignCanvasReceiverRecipe?
        let slate: DesignCanvasCompactSlateRecipe?
        let globalSaturation: Double
        let globalOpacity: Double
        switch profile {
        case .raisedChip:
            receiver = nil
            slate = .make(
                profile: .raisedChip,
                state: resolvedState,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            globalSaturation = 1
            globalOpacity = 1
        case .selectedChip:
            receiver = .make(
                profile: .selectedChip,
                state: resolvedState,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            slate = nil
            globalSaturation = 1
            globalOpacity = 1
        case .selectedCompact:
            receiver = .make(
                profile: .selectedCompact,
                state: resolvedState,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            slate = nil
            globalSaturation = 1
            globalOpacity = resolvedState.isDisabled
                ? DesignMaterialAdapter.selectDisabledOpacity
                : 1
        case .segmented(let geometry):
            receiver = .make(
                profile: .segmentedBed,
                state: resolvedState,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            if geometry.selectionBounds == nil {
                slate = nil
            } else {
                var selectionState = resolvedState
                selectionState.isFocused = false
                if geometry.pressedBounds != geometry.selectionBounds {
                    selectionState.isPressed = false
                }
                slate = .make(
                    profile: .segmentSelection,
                    state: selectionState,
                    increasedContrast: increasedContrast,
                    reduceMotion: reduceMotion
                )
            }
            globalSaturation = 1
            globalOpacity = 1
        case .toggle(let onAmount, _):
            receiver = .make(
                profile: .toggleTrack,
                state: resolvedState,
                activationAmount: onAmount,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            slate = .make(
                profile: onAmount.clamped < 0.5 ? .toggleKnobOff : .toggleKnobOn,
                state: DesignCanvasControlState(
                    isHovered: false,
                    isPressed: resolvedState.isPressed,
                    isFocused: false,
                    isDisabled: resolvedState.isDisabled
                ),
                activationAmount: onAmount,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            globalSaturation = 1
            globalOpacity = 1
        case .checkbox(let isChecked):
            if isChecked || resolvedState.isDisabled {
                receiver = nil
                slate = .make(
                    profile: resolvedState.isDisabled ? .checkboxDisabled : .checkboxChecked,
                    state: resolvedState,
                    increasedContrast: increasedContrast,
                    reduceMotion: reduceMotion
                )
            } else {
                receiver = .make(
                    profile: .checkboxReceiver,
                    state: resolvedState,
                    increasedContrast: increasedContrast,
                    reduceMotion: reduceMotion
                )
                slate = nil
            }
            globalSaturation = 1
            globalOpacity = 1
        case .slider(let normalizedProgress, _):
            // Disabled range chrome retains the complete slider track, thumb,
            // and profile-specific shadows. Its semantic state remains on the
            // parent recipe while the composed rest material is desaturated
            // and faded as one Canvas result below.
            var sliderMaterialState = resolvedState
            sliderMaterialState.isDisabled = false
            receiver = .make(
                profile: .sliderTrack,
                state: sliderMaterialState,
                activationAmount: normalizedProgress,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            slate = .make(
                profile: .sliderThumb,
                state: sliderMaterialState,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            globalSaturation = resolvedState.isDisabled
                ? DesignMaterialAdapter.sliderDisabledSaturation
                : 1
            globalOpacity = resolvedState.isDisabled
                ? DesignMaterialAdapter.sliderDisabledOpacity
                : 1
        }

        return DesignCanvasSmallControlRecipe(
            profile: profile,
            state: resolvedState,
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            receiver: receiver,
            slate: slate,
            globalSaturation: globalSaturation,
            globalOpacity: globalOpacity
        )
    }
}


/// Decorative-only selection/range renderer. Every profile is painted by one
/// synchronous non-linear Canvas and carries no content, gesture, focus owner,
/// accessibility semantics, timeline, or value mutation.
struct DesignCanvasSmallControlKernel: View, Animatable {
    let profile: DesignCanvasSmallControlProfile
    let state: DesignCanvasControlState
    var increasedContrast = false
    var reduceMotion = false
    let appliesRecipeOpacity: Bool


    private var pressAmount: CGFloat
    private var selectionAmount: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(pressAmount, selectionAmount) }
        set {
            pressAmount = newValue.first
            selectionAmount = newValue.second
        }
    }

    @Environment(\.displayScale) private var displayScale

    init(
        profile: DesignCanvasSmallControlProfile,
        state: DesignCanvasControlState,
        increasedContrast: Bool = false,
        reduceMotion: Bool = false,
        appliesRecipeOpacity: Bool = true
    ) {
        self.profile = profile
        self.state = state
        self.increasedContrast = increasedContrast
        self.reduceMotion = reduceMotion
        self.appliesRecipeOpacity = appliesRecipeOpacity
        pressAmount = state.isPressed && !state.isDisabled ? 1 : 0
        switch profile {
        case .checkbox(let checked): selectionAmount = checked ? 1 : 0
        case .selectedChip: selectionAmount = 1
        default: selectionAmount = 0
        }
    }


    static func transitionAnimation(
        for transition: DesignCanvasSmallControlTransition,
        reduceMotion: Bool
    ) -> Animation? {
        transition.animation(reduceMotion: reduceMotion)
    }

    var body: some View {
        GeometryReader { proxy in
            let recipe = DesignCanvasSmallControlRecipe.make(
                profile: profile,
                state: state,
                increasedContrast: increasedContrast,
                reduceMotion: reduceMotion
            )
            let overflow = ceil(
                DesignMaterialAdapter.smallControlMaximumOverflow * displayScale
            ) / max(displayScale, 1)
            let fieldSize = CGSize(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            let faceRect = DesignCanvasGeometry.faceRect(
                faceSize: proxy.size,
                overflow: overflow,
                displayScale: displayScale
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                var context = context
                drawInterpolatedProfile(in: &context, faceRect: faceRect)
            }
            // Disabled Slider treatment applies after every track, progress,
            // thumb, and shadow pass has composed into the single Canvas.
            // Production selected-compact wrappers opt out of this opacity so
            // their native label and decorative Canvas share one group fade.
            .saturation(recipe.globalSaturation)
            .opacity(appliesRecipeOpacity ? recipe.globalOpacity : 1)
            .frame(width: fieldSize.width, height: fieldSize.height)
            .offset(x: -overflow, y: -overflow)
        }
        .transaction { transaction in
            if reduceMotion { transaction.animation = nil }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// Blend complete decorative endpoints in one isolated Canvas layer.
    /// Native control state changes immediately; its face/shadow and selection
    /// change continuously without fading through the underlying canvas.
    private func drawInterpolatedProfile(in context: inout GraphicsContext, faceRect: CGRect) {
        let selection = selectionAmount.clamped
        let press = state.isDisabled ? 0 : pressAmount.clamped
        let profiles: [(DesignCanvasSmallControlProfile, CGFloat)]
        switch profile {
        case .checkbox:
            profiles = [(.checkbox(isChecked: false), 1 - selection), (.checkbox(isChecked: true), selection)]
        case .raisedChip, .selectedChip:
            profiles = [(.raisedChip, 1 - selection), (.selectedChip, selection)]
        default:
            profiles = [(profile, 1)]
        }
        context.drawLayer { composite in
            for (profile, selectionWeight) in profiles where selectionWeight > 0 {
                for (pressed, pressWeight) in [(false, 1 - press), (true, press)] where pressWeight > 0 {
                    var endpointState = state
                    endpointState.isPressed = pressed
                    let endpoint = DesignCanvasSmallControlRecipe.make(
                        profile: profile,
                        state: endpointState,
                        increasedContrast: increasedContrast,
                        reduceMotion: reduceMotion
                    )
                    var weighted = composite
                    weighted.opacity = Double(selectionWeight * pressWeight)
                    weighted.blendMode = .plusLighter
                    weighted.drawLayer { layer in
                        drawProfile(endpoint, in: &layer, faceRect: faceRect)
                    }
                }
            }
        }
    }

    private func drawProfile(
        _ recipe: DesignCanvasSmallControlRecipe,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        switch recipe.profile {
        case .raisedChip:
            guard let slate = recipe.slate else { return }
            drawSlate(
                shape: .capsule,
                faceRect: faceRect,
                recipe: slate,
                in: &context
            )
        case .selectedChip:
            guard let receiver = recipe.receiver else { return }
            drawReceiver(
                shape: .capsule,
                faceRect: faceRect,
                recipe: receiver,
                sliderGeometry: nil,
                in: &context
            )
        case .selectedCompact:
            guard let receiver = recipe.receiver else { return }
            drawReceiver(
                shape: .continuousRoundedRectangle(cornerRadius: Radii.sm),
                faceRect: faceRect,
                recipe: receiver,
                sliderGeometry: nil,
                in: &context
            )
        case .segmented(let geometry):
            if let receiver = recipe.receiver {
                drawReceiver(
                    shape: .roundedRectangle(cornerRadius: Radii.sm),
                    faceRect: faceRect,
                    recipe: receiver,
                    sliderGeometry: nil,
                    in: &context
                )
            }
            if let localSelection = geometry.selectionBounds,
               let selectionRect = translatedLocalRect(localSelection, into: faceRect),
               let slate = recipe.slate
            {
                drawSlate(
                    shape: .roundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius),
                    faceRect: selectionRect,
                    recipe: slate,
                    in: &context
                )
            }
            if recipe.state.isFocused,
               let localFocus = geometry.focusBounds,
               let focusRect = translatedLocalRect(localFocus, into: faceRect)
            {
                context.stroke(
                    DesignCanvasShape.roundedRectangle(
                        cornerRadius: DesignMetrics.segmentCornerRadius
                    ).path(
                        in: focusRect,
                        inset: DesignCanvasGeometry.outsideStrokePathInset(
                            offset: 2,
                            lineWidth: recipe.increasedContrast
                                ? DesignMetrics.focusRing
                                : DesignMetrics.focusBorder
                        )
                    ),
                    with: .color(DuskColors.accent),
                    lineWidth: recipe.increasedContrast
                        ? DesignMetrics.focusRing
                        : DesignMetrics.focusBorder
                )
            }
        case .toggle(let onAmount, let layoutDirection):
            let geometry = DesignCanvasToggleGeometry.make(
                in: faceRect,
                onAmount: onAmount,
                layoutDirection: layoutDirection
            )
            if let receiver = recipe.receiver {
                drawReceiver(
                    shape: .capsule,
                    faceRect: geometry.trackRect,
                    recipe: receiver,
                    sliderGeometry: nil,
                    in: &context
                )
            }
            if let slate = recipe.slate {
                drawSlate(
                    shape: .circle,
                    faceRect: geometry.knobRect,
                    recipe: slate,
                    in: &context
                )
            }
        case .checkbox:
            if let receiver = recipe.receiver {
                drawReceiver(
                    shape: .roundedRectangle(cornerRadius: DesignMetrics.checkboxCornerRadius),
                    faceRect: faceRect,
                    recipe: receiver,
                    sliderGeometry: nil,
                    in: &context
                )
            }
            if let slate = recipe.slate {
                drawSlate(
                    shape: .roundedRectangle(cornerRadius: DesignMetrics.checkboxCornerRadius),
                    faceRect: faceRect,
                    recipe: slate,
                    in: &context
                )
            }
        case .slider(let normalizedProgress, let layoutDirection):
            let geometry = DesignCanvasProgressGeometry.slider(
                in: faceRect,
                normalizedProgress: normalizedProgress,
                layoutDirection: layoutDirection
            )
            if let receiver = recipe.receiver {
                drawReceiver(
                    shape: .capsule,
                    faceRect: geometry.trackRect,
                    recipe: receiver,
                    sliderGeometry: geometry,
                    in: &context
                )
            }
            if let slate = recipe.slate {
                drawSlate(
                    shape: .circle,
                    faceRect: geometry.thumbRect,
                    recipe: slate,
                    in: &context
                )
            }
        }
    }

    private func drawSlate(
        shape: DesignCanvasShape,
        faceRect: CGRect,
        recipe: DesignCanvasCompactSlateRecipe,
        in context: inout GraphicsContext
    ) {
        let facePath = shape.path(in: faceRect)
        for pass in DesignCanvasPass.ordered {
            switch pass {
            case .glow:
                if let glow = recipe.glow {
                    drawOuterShadow(
                        glow,
                        shape: shape,
                        faceRect: faceRect,
                        in: &context
                    )
                }
            case .cast:
                drawOuterShadow(recipe.cast, shape: shape, faceRect: faceRect, in: &context)
            case .contact:
                drawOuterShadow(recipe.contact, shape: shape, faceRect: faceRect, in: &context)
            case .linearFace:
                context.fill(facePath, with: .linearGradient(
                    Gradient(colors: [recipe.linearTop, recipe.linearBottom]),
                    startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                    endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
                ))
            case .radialConcavity:
                drawCompactRadial(
                    shape: shape,
                    faceRect: faceRect,
                    recipe: recipe,
                    in: &context
                )
            case .insideBorder:
                context.stroke(
                    shape.path(
                        in: faceRect,
                        inset: DesignCanvasGeometry.insideStrokePathInset(
                            lineWidth: recipe.borderLineWidth
                        )
                    ),
                    with: .color(recipe.border),
                    lineWidth: recipe.borderLineWidth
                )
            case .directionalTopLight:
                guard recipe.topLightOpacity > 0 else { continue }
                drawDirectionalTopLight(
                    color: recipe.topLight.opacity(recipe.topLightOpacity),
                    shape: shape,
                    faceRect: faceRect,
                    in: &context
                )
            case .pressedInnerOcclusion:
                guard recipe.pressedInnerOcclusionOpacity > 0 else { continue }
                DesignCanvasEffects.insetShadow(
                    in: &context,
                    facePath: facePath,
                    sourcePath: facePath,
                    color: recipe.pressedInnerOcclusion.opacity(recipe.pressedInnerOcclusionOpacity),
                    blur: DesignMaterialAdapter.slatePressedInsetBlur,
                    y: DesignMaterialAdapter.slatePressedInsetY
                )
            case .focusRing:
                guard recipe.focusOpacity > 0 else { continue }
                context.stroke(
                    shape.path(in: faceRect, inset: DesignMetrics.focusBorderInset),
                    with: .color(recipe.focusRing.opacity(recipe.focusOpacity)),
                    lineWidth: recipe.focusLineWidth
                )
            }
        }
    }

    private func drawReceiver(
        shape: DesignCanvasShape,
        faceRect: CGRect,
        recipe: DesignCanvasReceiverRecipe,
        sliderGeometry: DesignCanvasSliderGeometry?,
        in context: inout GraphicsContext
    ) {
        let facePath = shape.path(in: faceRect)
        for pass in DesignCanvasWellPass.ordered {
            switch pass {
            case .stateCast:
                if let extraCast = recipe.extraCast {
                    drawOuterShadow(
                        extraCast,
                        shape: shape,
                        faceRect: faceRect,
                        in: &context
                    )
                }
                if let pressCast = recipe.pressCast {
                    drawOuterShadow(
                        pressCast,
                        shape: shape,
                        faceRect: faceRect,
                        in: &context
                    )
                }
            case .stateHalo:
                drawHalo(
                    color: DuskColors.accent,
                    opacity: recipe.stateHaloOpacity,
                    spread: DesignMaterialAdapter.wellCSSHaloSpread,
                    shape: shape,
                    faceRect: faceRect,
                    in: &context
                )
            case .contact:
                let contact = DesignCanvasShadowRecipe(
                    color: recipe.contactColor,
                    opacity: recipe.contactOpacity,
                    geometry: recipe.profile == .checkboxReceiver && recipe.state.isPressed
                        ? DesignDropShadowGeometry(
                            radius: 0,
                            y: DesignMetrics.pressedDepth,
                            sourceInset: DesignMetrics.hairline
                        )
                        : recipe.contactGeometry
                )
                drawOuterShadow(contact, shape: shape, faceRect: faceRect, in: &context)
            case .linearFace:
                if recipe.drawsSliderProgressFace, let sliderGeometry {
                    context.fill(facePath, with: .color(DuskColors.bgSunk))
                    if sliderGeometry.progressRect.width > 0 {
                        var progress = context
                        progress.clip(to: facePath)
                        progress.fill(
                            Path(sliderGeometry.progressRect),
                            with: .color(DuskColors.accentSoft.overlaying(
                                DuskColors.accent,
                                opacity: DesignMaterialAdapter.sliderProgressAccentMix
                            ))
                        )
                    }
                } else {
                    context.fill(facePath, with: .linearGradient(
                        Gradient(stops: [
                            .init(color: recipe.faceTop, location: 0),
                            .init(color: recipe.faceMiddle, location: recipe.well.faceMiddleStop),
                            .init(color: recipe.faceBottom, location: 1),
                        ]),
                        startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                        endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
                    ))
                }
            case .upperInnerOcclusion:
                drawInsetOcclusion(
                    color: recipe.well.upperInnerOcclusionColor,
                    opacity: recipe.upperInnerOcclusionOpacity,
                    geometry: recipe.upperInnerOcclusion,
                    shape: shape,
                    faceRect: faceRect,
                    in: &context
                )
            case .lowerInnerReflection:
                drawLowerInnerReflection(
                    color: recipe.well.lowerInnerReflectionColor,
                    opacity: recipe.lowerInnerReflectionOpacity,
                    y: recipe.well.lowerInnerReflectionY,
                    inset: recipe.well.lowerInnerReflectionInset,
                    shape: shape,
                    faceRect: faceRect,
                    in: &context
                )
            case .insideBorder:
                guard recipe.border != .clear else { continue }
                context.stroke(
                    shape.path(
                        in: faceRect,
                        inset: DesignCanvasGeometry.insideStrokePathInset(
                            lineWidth: recipe.well.borderLineWidth
                        )
                    ),
                    with: .color(recipe.border),
                    lineWidth: recipe.well.borderLineWidth
                )
            case .focusOutline:
                guard recipe.focusOutlineOpacity > 0 else { continue }
                context.stroke(
                    shape.path(
                        in: faceRect,
                        inset: DesignCanvasGeometry.outsideStrokePathInset(
                            offset: recipe.well.focusOutlineOffset,
                            lineWidth: recipe.well.focusOutlineLineWidth
                        )
                    ),
                    with: .color(DuskColors.accent.opacity(recipe.focusOutlineOpacity)),
                    lineWidth: recipe.well.focusOutlineLineWidth
                )
            }
        }
    }

    private func drawOuterShadow(
        _ recipe: DesignCanvasShadowRecipe,
        shape: DesignCanvasShape,
        faceRect: CGRect,
        in context: inout GraphicsContext
    ) {
        guard recipe.opacity > 0 else { return }
        var source = Path()
        source.addPath(
            shape.path(in: faceRect, inset: recipe.geometry.sourceInset),
            transform: CGAffineTransform(
                translationX: recipe.geometry.x,
                y: recipe.geometry.y
            )
        )
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: recipe.color.opacity(recipe.opacity),
            blur: recipe.geometry.radius
        )
    }

    private func drawCompactRadial(
        shape: DesignCanvasShape,
        faceRect: CGRect,
        recipe: DesignCanvasCompactSlateRecipe,
        in context: inout GraphicsContext
    ) {
        var radial = context
        radial.clip(to: shape.path(in: faceRect))
        let center = recipe.radialGeometry.center(in: faceRect)

        let stops: [Gradient.Stop]
        if let ring = recipe.radialRing, let centerStop = recipe.radialCenterStop {
            stops = [
                .init(color: recipe.radialCenter, location: 0),
                .init(color: ring, location: centerStop),
                .init(color: ring.opacity(0), location: recipe.radialFadeStop),
            ]
        } else {
            stops = [
                .init(color: recipe.radialCenter, location: 0),
                .init(color: recipe.radialCenter.opacity(0), location: recipe.radialFadeStop),
            ]
        }

        switch recipe.radialGeometry.radius {
        case .canonicalEllipse:
            let radius = CGSize(
                width: faceRect.width * DesignMaterialAdapter.slateRadialScale.width,
                height: faceRect.height * DesignMaterialAdapter.slateRadialScale.height
            )
            guard radius.width > 0, radius.height > 0 else { return }
            radial.translateBy(x: center.x, y: center.y)
            radial.scaleBy(x: radius.width, y: radius.height)
            radial.fill(
                Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
                with: .radialGradient(
                    Gradient(stops: stops),
                    center: .zero,
                    startRadius: DesignMaterialAdapter.slateRadialStartRadiusFraction,
                    endRadius: DesignMaterialAdapter.slateRadialEndRadiusFraction
                )
            )
        case .farthestCornerCircle:
            let radius = recipe.radialGeometry.farthestCornerRadius(in: faceRect)
            guard radius > 0 else { return }
            radial.fill(
                shape.path(in: faceRect),
                with: .radialGradient(
                    Gradient(stops: stops),
                    center: center,
                    startRadius: 0,
                    endRadius: radius
                )
            )
        }
    }

    private func drawDirectionalTopLight(
        color: Color,
        shape: DesignCanvasShape,
        faceRect: CGRect,
        in context: inout GraphicsContext
    ) {
        let inner = shape.path(in: faceRect, inset: DesignMetrics.hairline)
        var translated = Path()
        translated.addPath(
            inner,
            transform: CGAffineTransform(
                translationX: 0,
                y: DesignMetrics.hairline
            )
        )
        var difference = Path()
        difference.addPath(inner)
        difference.addPath(translated)
        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
    }

    private func drawHalo(
        color: Color,
        opacity: Double,
        spread: CGFloat,
        shape: DesignCanvasShape,
        faceRect: CGRect,
        in context: inout GraphicsContext
    ) {
        guard opacity > 0, spread > 0 else { return }
        var ring = Path()
        ring.addPath(shape.path(in: faceRect, inset: -spread))
        ring.addPath(shape.path(in: faceRect))
        context.fill(
            ring,
            with: .color(color.opacity(opacity)),
            style: FillStyle(eoFill: true)
        )
    }

    private func drawInsetOcclusion(
        color: Color,
        opacity: Double,
        geometry: DesignCanvasInsetShadowGeometry,
        shape: DesignCanvasShape,
        faceRect: CGRect,
        in context: inout GraphicsContext
    ) {
        guard opacity > 0 else { return }
        let facePath = shape.path(in: faceRect)
        let sourcePath = geometry.sourcePath(shape: shape, in: faceRect)
        DesignCanvasEffects.insetShadow(
            in: &context,
            facePath: facePath,
            sourcePath: sourcePath,
            color: color.opacity(opacity),
            blur: geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    private func drawLowerInnerReflection(
        color: Color,
        opacity: Double,
        y: CGFloat,
        inset: CGFloat,
        shape: DesignCanvasShape,
        faceRect: CGRect,
        in context: inout GraphicsContext
    ) {
        guard opacity > 0, y != 0 else { return }
        let facePath = shape.path(in: faceRect)
        let directionalDifference = DesignCanvasGeometry.directionalInnerEdgePath(
            shape: shape,
            faceRect: faceRect,
            inset: inset,
            translationY: y
        )
        var reflection = context
        reflection.clip(to: facePath)
        reflection.fill(
            directionalDifference,
            with: .color(color.opacity(opacity)),
            style: FillStyle(eoFill: true)
        )
    }

    private func translatedLocalRect(_ localRect: CGRect, into faceRect: CGRect) -> CGRect? {
        guard localRect.width > 0,
              localRect.height > 0,
              !localRect.isNull,
              !localRect.isInfinite
        else { return nil }
        let localFace = CGRect(origin: .zero, size: faceRect.size)
        let clipped = localRect.intersection(localFace)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        return clipped.offsetBy(dx: faceRect.minX, dy: faceRect.minY)
    }

}

private extension CGFloat {
    var clamped: CGFloat { Swift.min(Swift.max(self, 0), 1) }

    static func lerp(_ from: CGFloat, _ to: CGFloat, by amount: CGFloat) -> CGFloat {
        let amount = amount.clamped
        if amount == 0 { return from }
        if amount == 1 { return to }
        return from + (to - from) * amount
    }
}

private extension Double {
    static func lerp(_ from: Double, _ to: Double, by amount: CGFloat) -> Double {
        let amount = amount.clamped
        if amount == 0 { return from }
        if amount == 1 { return to }
        return from + (to - from) * Double(amount)
    }
}

private extension Color {
    func interpolated(to other: Color, amount: CGFloat) -> Color {
        mix(with: other, by: Double(amount.clamped), in: .perceptual)
    }

    func wellInterpolated(to other: Color, amount: CGFloat) -> Color {
        let amount = amount.clamped
        if amount == 0 { return self }
        if amount == 1 { return other }
        return mix(with: other, by: Double(amount), in: .perceptual)
    }
}

private extension DesignDropShadowGeometry {
    func interpolated(to other: DesignDropShadowGeometry, amount: CGFloat) -> DesignDropShadowGeometry {
        DesignDropShadowGeometry(
            radius: .lerp(radius, other.radius, by: amount),
            x: .lerp(x, other.x, by: amount),
            y: .lerp(y, other.y, by: amount),
            sourceInset: .lerp(sourceInset, other.sourceInset, by: amount)
        )
    }
}
