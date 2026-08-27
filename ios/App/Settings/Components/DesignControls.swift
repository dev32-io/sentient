import SwiftUI
import UIKit

/// Shared semantic state for controls. The visual primitive owns how a state is
/// drawn; the state also supplies the VoiceOver value so disabled, loading,
/// error, selected, and on states cannot drift between controls.
enum DesignControlState: Equatable {
    case normal
    case loading
    case error(String)
    case selected
    case on
    case disabled

    var isInteractive: Bool {
        switch self {
        case .normal, .selected, .on: true
        case .loading, .error, .disabled: false
        }
    }

    var accessibilityValue: String {
        switch self {
        case .normal: "Ready"
        case .loading: "In progress"
        case .error(let message): "Error: \(message)"
        case .selected: "Selected"
        case .on: "On"
        case .disabled: "Disabled"
        }
    }

    var isSelected: Bool {
        switch self {
        case .selected, .on: true
        case .normal, .loading, .error, .disabled: false
        }
    }
}

enum DesignButtonRole { case action, secondary, destructive, quiet }

enum DesignNoticeKind { case loading, empty, error, success, warning }

private enum DesignSlateState: Equatable {
    case rest
    case hover
    case pressed
    case disabled

    var isPressed: Bool {
        self == .pressed
    }
}

/// The shared actionable face. Its geometry follows the reviewed CSS recipe;
/// the enclosing ButtonStyle supplies native semantics, hit testing, focus, and
/// state transitions.
private struct SlateFace<S: InsettableShape>: View, Animatable {
    let shape: S
    let role: DesignButtonRole
    let state: DesignSlateState
    var baseOverride: Color? = nil
    var pressProgress: CGFloat

    init(shape: S, role: DesignButtonRole, state: DesignSlateState, baseOverride: Color? = nil) {
        self.shape = shape
        self.role = role
        self.state = state
        self.baseOverride = baseOverride
        self.pressProgress = state.isPressed ? 1 : 0
    }

    var animatableData: CGFloat {
        get { pressProgress }
        set { pressProgress = newValue }
    }

    private var base: Color {
        if state == .disabled { return disabledBase }
        if let baseOverride { return baseOverride }
        switch role {
        case .action: return DuskColors.accent
        case .secondary:
            // The plain prototype button uses a paper/secondary-ink mix so it
            // remains legible on a paper plate without becoming a second
            // accent face.
            return DuskColors.paper.overlaying(
                DuskColors.ink2,
                opacity: DesignMaterialAdapter.slateSecondaryBaseMix
            )
        case .destructive:
            return DuskColors.paper.overlaying(
                DuskColors.stop,
                opacity: DesignMaterialAdapter.slateDestructiveOverlay
            )
        case .quiet: return DuskColors.bgElev
        }
    }

    private var disabledBase: Color {
        DuskColors.bgElev.overlaying(
            DuskColors.ink4,
            opacity: DesignMaterialAdapter.slateDisabledBaseMix
        )
    }

    private var isMuted: Bool { state == .disabled }
    private var isHovered: Bool { state == .hover }
    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }

    private var radialStops: [Gradient.Stop] {
        if isMuted {
            return [
                .init(
                    color: base.overlaying(DuskColors.bgSunk, opacity: DesignMaterialAdapter.slateMutedCenterSunk),
                    location: 0
                ),
                .init(color: .clear, location: DesignMaterialAdapter.slateMutedFadeStop),
            ]
        }
        return [
            .init(
                color: base.overlaying(
                    DuskColors.bgSunk,
                    opacity: isHovered ? DesignMaterialAdapter.slateHoverCenterSunk : DesignMaterialAdapter.slateCenterSunk
                ),
                location: 0
            ),
            .init(
                color: base.overlaying(
                    DuskColors.bgSunk,
                    opacity: isHovered ? DesignMaterialAdapter.slateHoverRingSunk : DesignMaterialAdapter.slateRingSunk
                ),
                location: DesignMaterialAdapter.slateCenterStop
            ),
            .init(color: .clear, location: DesignMaterialAdapter.slateFadeStop),
        ]
    }

    private var linearTop: Color {
        if isMuted { return base.overlaying(DuskColors.ink4, opacity: DesignMaterialAdapter.slateMutedBaseLight) }
        return base.overlaying(
            DuskColors.ink,
            opacity: isHovered ? DesignMaterialAdapter.slateHoverBaseLight : DesignMaterialAdapter.slateBaseLight
        )
    }

    private var linearBottom: Color {
        isMuted ? base : isHovered ? base.overlaying(glow, opacity: DesignMaterialAdapter.slateHoverGlow) : base
    }

    private var topLight: Color? {
        switch state {
        case .pressed: nil
        case .disabled: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightDisabled)
        case .hover: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightHover)
        case .rest:
            switch role {
            case .action: .white.opacity(DesignMaterialAdapter.slateActionTopLight)
            case .destructive: .white.opacity(DesignMaterialAdapter.slateDestructiveTopLight)
            case .secondary, .quiet: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
            }
        }
    }

    var body: some View {
        let linearStyle = state.isPressed
            ? AnyShapeStyle(
                linearFace.shadow(
                    .inner(
                        color: DuskColors.bgSunk.opacity(
                            DesignMaterialAdapter.slatePressedInsetOpacity * pressProgress
                        ),
                        radius: DesignMaterialAdapter.slatePressedInsetBlur,
                        y: DesignMaterialAdapter.slatePressedInsetY
                    )
                )
            )
            : AnyShapeStyle(linearFace)
        ZStack {
            shape.fill(linearStyle)
            EllipticalGradient(
                stops: radialStops,
                center: UnitPoint(
                    x: DesignMaterialAdapter.slateRadialCenterX,
                    y: DesignMaterialAdapter.slateRadialCenterY
                ),
                startRadiusFraction: DesignMaterialAdapter.slateRadialStartRadiusFraction,
                endRadiusFraction: DesignMaterialAdapter.slateRadialEndRadiusFraction
            )
            .scaleEffect(
                x: DesignMaterialAdapter.slateRadialScale.width,
                y: DesignMaterialAdapter.slateRadialScale.height
            )
            if !state.isPressed, let topLight {
                shape
                    .stroke(topLight, lineWidth: DesignMetrics.hairline)
                    .mask(
                        LinearGradient(
                            colors: [.white, .clear, .clear],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            }
        }
        .clipShape(shape)
        .accessibilityHidden(true)
    }

    private var linearFace: LinearGradient {
        LinearGradient(
            colors: [linearTop, linearBottom],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

private struct DesignControlPressedKey: EnvironmentKey {
    static let defaultValue = false
}

private extension EnvironmentValues {
    var designControlPressed: Bool {
        get { self[DesignControlPressedKey.self] }
        set { self[DesignControlPressedKey.self] = newValue }
    }
}

/// Shared directional depth for every actionable slate. The two animatable
/// progress values mirror the prototype's short hover/press transitions while
/// keeping all geometry in one renderer.
private struct SlateShadowLayers<S: InsettableShape>: View, Animatable {
    let shape: S
    let role: DesignButtonRole
    private let isDisabled: Bool
    var hoverProgress: CGFloat
    var pressProgress: CGFloat

    init(shape: S, role: DesignButtonRole, state: DesignSlateState) {
        self.shape = shape
        self.role = role
        self.isDisabled = state == .disabled
        self.hoverProgress = state == .hover ? 1 : 0
        self.pressProgress = state == .pressed ? 1 : 0
    }

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(hoverProgress, pressProgress) }
        set {
            hoverProgress = newValue.first
            pressProgress = newValue.second
        }
    }

    private var hover: CGFloat { min(max(hoverProgress, 0), 1) }
    private var pressed: CGFloat { min(max(pressProgress, 0), 1) }

    private func interpolate(_ from: CGFloat, _ to: CGFloat, _ amount: CGFloat) -> CGFloat {
        from + ((to - from) * amount)
    }

    private func interpolate(
        _ from: DesignDropShadowGeometry,
        _ to: DesignDropShadowGeometry,
        _ amount: CGFloat
    ) -> DesignDropShadowGeometry {
        DesignDropShadowGeometry(
            radius: interpolate(from.radius, to.radius, amount),
            x: interpolate(from.x, to.x, amount),
            y: interpolate(from.y, to.y, amount),
            sourceInset: interpolate(from.sourceInset, to.sourceInset, amount)
        )
    }

    private var castOpacity: Double {
        if isDisabled { return DesignMaterialAdapter.slateDisabledBlack }
        let rest = role == .action ? DesignMaterialAdapter.slateActionRestBlack : DesignMaterialAdapter.slateRestBlack
        let restToHover = interpolate(CGFloat(rest), CGFloat(DesignMaterialAdapter.slateHoverBlack), hover)
        return Double(interpolate(restToHover, CGFloat(DesignMaterialAdapter.slatePressedBlack), pressed))
    }

    private var castGeometry: DesignDropShadowGeometry {
        if isDisabled { return DesignMaterialShadowGeometry.slateDisabled }
        let restToHover = interpolate(DesignMaterialShadowGeometry.slateRest, DesignMaterialShadowGeometry.slateHover, hover)
        return interpolate(restToHover, DesignMaterialShadowGeometry.slatePressed, pressed)
    }

    private var restGlow: (opacity: Double, geometry: DesignDropShadowGeometry, color: Color) {
        switch role {
        case .action:
            (DesignMaterialAdapter.slateActionGlow, DesignMaterialShadowGeometry.slateActionGlow, DuskColors.accent)
        case .destructive:
            (DesignMaterialAdapter.slateDestructiveGlow, DesignMaterialShadowGeometry.slateDestructiveGlow, DuskColors.stop)
        case .secondary, .quiet:
            (DesignMaterialAdapter.slateDefaultGlow, DesignMaterialShadowGeometry.slateGlow, DuskColors.accent)
        }
    }

    private var hoverGlow: (opacity: Double, geometry: DesignDropShadowGeometry, color: Color) {
        switch role {
        case .destructive:
            (DesignMaterialAdapter.slateDestructiveHoverGlow, DesignMaterialShadowGeometry.slateDestructiveHoverGlow, DuskColors.stop)
        case .action, .secondary, .quiet:
            (0.48, DesignMaterialShadowGeometry.slateHoverGlow, DuskColors.accent)
        }
    }

    private var glow: (color: Color, geometry: DesignDropShadowGeometry)? {
        guard !isDisabled else { return nil }
        let opacity = interpolate(
            CGFloat(restGlow.opacity),
            CGFloat(hoverGlow.opacity),
            hover
        ) * (1 - pressed)
        guard opacity > 0.001 else { return nil }
        return (
            restGlow.color.opacity(Double(opacity)),
            interpolate(restGlow.geometry, hoverGlow.geometry, hover)
        )
    }

    private var restContact: Color {
        switch role {
        case .action:
            DuskColors.bgSunk.overlaying(
                DuskColors.accent,
                opacity: DesignMaterialAdapter.slateActionContactMix
            )
        case .secondary, .quiet:
            DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDefaultContactMix
            )
        case .destructive:
            DuskColors.bgSunk.overlaying(
                DuskColors.stop,
                opacity: DesignMaterialAdapter.slateDestructiveContactMix
            )
        }
    }

    private var hoverContact: Color {
        role == .destructive
            ? DuskColors.bgSunk.overlaying(
                DuskColors.stop,
                opacity: DesignMaterialAdapter.slateDestructiveHoverContactMix
            )
            : DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateHoverContactMix
            )
    }

    private var contactColor: Color {
        if isDisabled {
            return DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDisabledContactOpacity
            )
        }
        let restToHover = restContact.overlaying(hoverContact, opacity: Double(hover))
        let pressedContact = DuskColors.bgSunk.overlaying(
            DuskColors.line,
            opacity: DesignMaterialAdapter.slatePressedContactMix
        )
        return restToHover.overlaying(pressedContact, opacity: Double(pressed))
    }

    private var contactGeometry: DesignDropShadowGeometry {
        let y = interpolate(
            interpolate(
                DesignMaterialAdapter.slateRestContactY,
                DesignMaterialAdapter.slateRestContactY,
                hover
            ),
            DesignMaterialAdapter.slatePressedContactY,
            pressed
        )
        return DesignDropShadowGeometry(
            radius: 0,
            y: isDisabled ? DesignMaterialAdapter.slateDisabledContactY : y,
            sourceInset: 1
        )
    }

    var body: some View {
        ZStack {
            DesignSpreadShadow(
                shape: shape,
                color: .black.opacity(castOpacity),
                geometry: castGeometry
            )
            if let glow {
                DesignSpreadShadow(shape: shape, color: glow.color, geometry: glow.geometry)
            }
            DesignSpreadShadow(shape: shape, color: contactColor, geometry: contactGeometry)
        }
    }
}

struct DesignButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isFocused) private var focused
    let role: DesignButtonRole
    var hovered = false
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var horizontalPadding: CGFloat = DesignMetrics.buttonHorizontalPadding

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let state: DesignSlateState = if !isEnabled {
            .disabled
        } else if pressed {
            .pressed
        } else if hovered {
            .hover
        } else {
            .rest
        }
        let shape = RoundedRectangle(cornerRadius: DesignMetrics.buttonCornerRadius, style: .continuous)
        configuration.label
            .font(Typo.ui(DesignMetrics.buttonLabelSize))
            .foregroundStyle(foreground)
            .frame(minHeight: DesignMetrics.buttonVisualHeight)
            .padding(.horizontal, horizontalPadding)
            .background {
                SlateFace(shape: shape, role: role, state: state)
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(border(raised: state == .hover), lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                shape
                    .stroke(
                        focused ? DuskColors.accent : .clear,
                        lineWidth: DesignMetrics.focusBorder
                    )
                    .padding(DesignMetrics.focusBorderInset)
            }
            .background {
                SlateShadowLayers(shape: shape, role: role, state: state)
            }
            .offset(y: state == .pressed ? DesignMetrics.pressedDepth : state == .hover ? -1 : 0)
            .animation(
                DesignV2.Motion.animation(
                    duration: state == .pressed
                        ? DesignMetrics.buttonPressTransition
                        : DesignV2.Motion.feedback,
                    reduceMotion: reduceMotion
                ),
                value: state
            )
            // Keep the native hit target at 44pt while the visual key follows
            // the 40px prototype control height.
            .frame(minHeight: max(minimumHeight, DesignMetrics.buttonVisualHeight))
            .contentShape(Rectangle())
    }

    private var foreground: Color {
        if !isEnabled { return DuskColors.ink4 }
        switch role {
        case .action, .secondary, .destructive: return DuskColors.ink
        case .quiet: return DuskColors.ink2
        }
    }

    private func border(raised: Bool) -> Color {
        if !isEnabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: DesignMaterialAdapter.slateDisabledBorder
            )
        }
        if raised { return .clear }
        return switch role {
        case .action:
            DuskColors.accent.overlaying(DuskColors.bgSunk, opacity: DesignMaterialAdapter.slateActionBorder)
        case .secondary: DuskColors.line
        case .quiet:
            DuskColors.lineSoft.overlaying(DuskColors.bg, opacity: 0.84)
        case .destructive:
            DuskColors.stop.overlaying(DuskColors.line, opacity: DesignMaterialAdapter.slateDestructiveBorder)
        }
    }
}

struct DesignActionButton: View {
    let title: String
    var role: DesignButtonRole = .action
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    var fillsWidth = true
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            HStack(spacing: DesignMetrics.buttonContentGap) {
                if state == .loading { ProgressView().controlSize(.small) }
                Text(state == .loading ? "Loading" : title)
                    .frame(maxWidth: fillsWidth ? .infinity : nil)
            }
        }
        .buttonStyle(DesignButtonStyle(role: role, hovered: hovered, minimumHeight: minimumHeight))
        .onHover { hovered = $0 }
        .disabled(!state.isInteractive)
        .accessibilityLabel(title)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
    }
}

struct DesignIconButton: View {
    let systemName: String
    let label: String
    var role: DesignButtonRole = .secondary
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    var minimumSize: CGFloat = DesignMetrics.minimumTarget
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            Image(systemName: systemName)
                .frame(width: minimumSize, height: minimumSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignButtonStyle(role: role, hovered: hovered, minimumHeight: minimumSize, horizontalPadding: 0))
        .onHover { hovered = $0 }
        .disabled(!state.isInteractive)
        .accessibilityLabel(label)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
    }
}

/// Plain, minimum-target actions for compact product controls. The primitive
/// owns press motion and state semantics while callers supply only the
/// product-specific label composition.
struct DesignCompactButton<Label: View>: View {
    let accessibilityLabel: String
    var role: DesignButtonRole = .secondary
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumWidth: CGFloat? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var pressedScale: CGFloat = 0.985
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @State private var hovered = false

    init(
        accessibilityLabel: String,
        role: DesignButtonRole = .secondary,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumWidth: CGFloat? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        pressedScale: CGFloat = 0.985,
        action: @escaping () -> Void,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.role = role
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.pressedScale = pressedScale
        self.action = action
        self.label = label
    }

    private var effectiveState: DesignControlState {
        isEnabled ? state : .disabled
    }

    var body: some View {
        Button(action: action) {
            label()
                .frame(minWidth: minimumWidth, minHeight: minimumHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale, role: role, selected: effectiveState.isSelected, hovered: hovered))
        .onHover { hovered = $0 }
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(effectiveState.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
    }
}

/// The compact icon action used for close, clear, and navigation affordances.
struct DesignCompactIconButton: View {
    let systemName: String
    let label: String
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var pressedScale: CGFloat = 0.985
    let action: () -> Void

    var body: some View {
        DesignCompactButton(
            accessibilityLabel: label,
            state: state,
            isEnabled: isEnabled,
            accessibilityId: accessibilityId,
            minimumWidth: DesignMetrics.minimumTarget,
            minimumHeight: DesignMetrics.minimumTarget,
            pressedScale: pressedScale,
            action: action
        ) {
            Image(systemName: systemName)
                .font(Typo.ui(TypeScale.base, .semibold))
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
        }
    }
}

/// Selection semantics for compact filters and segmented-looking product
/// controls. The label remains product-owned so Calendar can retain its
/// existing geometry while the button, state, target, and accessibility stay
/// centralized.
struct DesignSelectableButton<Label: View>: View {
    let accessibilityLabel: String
    let state: DesignControlState
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumWidth: CGFloat? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var pressedScale: CGFloat = 0.985
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    init(
        accessibilityLabel: String,
        state: DesignControlState,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumWidth: CGFloat? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        pressedScale: CGFloat = 0.985,
        action: @escaping () -> Void,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumWidth = minimumWidth
        self.minimumHeight = minimumHeight
        self.pressedScale = pressedScale
        self.action = action
        self.label = label
    }

    private var effectiveState: DesignControlState {
        isEnabled ? state : .disabled
    }

    private var selectionValue: String {
        switch effectiveState {
        case .normal: "Not selected"
        default: effectiveState.accessibilityValue
        }
    }

    var body: some View {
        Button(action: action) {
            label()
                .frame(minWidth: minimumWidth, minHeight: minimumHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale, selected: effectiveState.isSelected))
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(selectionValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
    }
}

struct DesignCompactButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isFocused) private var focused
    let pressedScale: CGFloat
    var role: DesignButtonRole = .secondary
    var selected = false
    var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let raised = hovered && isEnabled
        let state: DesignSlateState = if !isEnabled {
            .disabled
        } else if pressed {
            .pressed
        } else if raised {
            .hover
        } else {
            .rest
        }
        let shape = RoundedRectangle(cornerRadius: DesignMetrics.buttonCornerRadius, style: .continuous)
        configuration.label
            .background {
                if selected {
                    DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
                } else {
                    SlateFace(shape: shape, role: role, state: state)
                }
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(
                    selected || raised ? Color.clear : DuskColors.line,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .overlay {
                if focused {
                    shape.stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder)
                        .padding(DesignMetrics.focusBorderInset)
                }
            }
            .background {
                if selected {
                    ZStack {
                        DesignSpreadShadow(
                            shape: shape,
                            color: pressed
                                ? .black.opacity(DesignMaterialAdapter.slatePressedBlack)
                                : DuskColors.accent.opacity(0.40),
                            geometry: pressed
                                ? DesignMaterialShadowGeometry.slatePressed
                                : DesignDropShadowGeometry(radius: 16, y: 8, sourceInset: 14)
                        )
                        DesignSpreadShadow(
                            shape: shape,
                            color: DuskColors.bgSunk.opacity(0.88),
                            geometry: DesignDropShadowGeometry(radius: 0, y: pressed ? 1 : 2, sourceInset: 1)
                        )
                    }
                } else {
                    SlateShadowLayers(shape: shape, role: role, state: state)
                }
            }
            .scaleEffect(pressed && !reduceMotion ? pressedScale : 1)
            .offset(y: selected ? (pressed ? 2 : 1) : (pressed ? DesignMetrics.pressedDepth : raised ? -1 : 0))
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .animation(
                DesignV2.Motion.animation(
                    duration: pressed ? DesignMetrics.buttonPressTransition : DesignV2.Motion.feedback,
                    reduceMotion: reduceMotion
                ),
                value: state
            )
    }
}

private struct DesignFieldError: View {
    let message: String
    let accessibilityId: String?

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .accessibilityLabel("Error: \(message)")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    var showsTitle = true
    var accessibilityLabel: String? = nil
    var axis: Axis? = nil
    var lineLimit: ClosedRange<Int> = 1...1
    var autocapitalization: TextInputAutocapitalization? = nil
    var autocorrectionDisabled = false
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var focused: FocusState<Bool>.Binding? = nil
    var submitLabel: SubmitLabel? = nil
    var onSubmit: (() -> Void)? = nil
    var onChange: ((String) -> Void)? = nil
    @FocusState private var internalFocused: Bool

    init(
        title: String,
        prompt: String = "",
        text: Binding<String>,
        error: String? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true,
        showsTitle: Bool = true,
        accessibilityLabel: String? = nil,
        axis: Axis? = nil,
        lineLimit: ClosedRange<Int> = 1...1,
        autocapitalization: TextInputAutocapitalization? = nil,
        autocorrectionDisabled: Bool = false,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget,
        focused: FocusState<Bool>.Binding? = nil,
        submitLabel: SubmitLabel? = nil,
        onSubmit: (() -> Void)? = nil,
        onChange: ((String) -> Void)? = nil
    ) {
        self.title = title
        self.prompt = prompt
        _text = text
        self.error = error
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
        self.showsTitle = showsTitle
        self.accessibilityLabel = accessibilityLabel
        self.axis = axis
        self.lineLimit = lineLimit
        self.autocapitalization = autocapitalization
        self.autocorrectionDisabled = autocorrectionDisabled
        self.minimumHeight = minimumHeight
        self.focused = focused
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.onChange = onChange
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if showsTitle {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
            }
            focusableField
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    @ViewBuilder
    private var focusableField: some View {
        if let focused {
            input.focused(focused)
        } else {
            input.focused($internalFocused)
        }
    }

    @ViewBuilder
    private var nativeField: some View {
        if let axis {
            TextField(prompt, text: $text, axis: axis)
        } else {
            TextField(prompt, text: $text)
        }
    }

    private var baseInput: some View {
        nativeField
            .font(Typo.ui(TypeScale.base))
            .textFieldStyle(.plain)
            .padding(.horizontal, Space.md)
            .frame(minHeight: minimumHeight)
    }

    private var surfacedInput: some View {
        baseInput
            .lineLimit(lineLimit)
            .designWell(focused: isFocused, error: error != nil)
            .disabled(!isEnabled)
    }

    private var input: some View {
        surfacedInput
            .submitLabel(submitLabel ?? .return)
            .onSubmit { onSubmit?() }
            .onChange(of: text) { _, value in onChange?(value) }
            .textInputAutocapitalization(autocapitalization ?? .sentences)
            .autocorrectionDisabled(autocorrectionDisabled)
            .accessibilityLabel(accessibilityLabel ?? title)
            .accessibilityValue(fieldAccessibilityValue)
            .accessibilityHint(fieldAccessibilityHint)
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var fieldAccessibilityValue: String {
        if !isEnabled { return "Disabled" }
        if let error { return "Error: \(error)" }
        return text.isEmpty ? "Empty" : text
    }

    private var fieldAccessibilityHint: String {
        if !isEnabled { return "Disabled" }
        if let error { return "Error: \(error)" }
        return ""
    }
}

struct DesignSecureField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    @State private var revealed = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            HStack(spacing: Space.sm) {
                Group {
                    if revealed { TextField(prompt, text: $text) }
                    else { SecureField(prompt, text: $text) }
                }
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .focused($focused)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityValue(Self.accessibilityValue(text: text, isEnabled: isEnabled, error: error, revealed: revealed))
                .accessibilityHint(!isEnabled ? "Disabled" : (revealed ? "Value is visible" : "Value is hidden"))
                .accessibilityIdentifier(accessibilityId ?? "")
                DesignIconButton(
                    systemName: revealed ? "eye.slash" : "eye",
                    label: revealed ? "Hide value" : "Show value",
                    role: .quiet,
                    state: isEnabled ? .normal : .disabled,
                    action: { revealed.toggle() }
                )
            }
            .padding(.leading, Space.md)
            .designWell(focused: focused, error: error != nil)
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    /// Keeps hidden credentials content-free to assistive technologies. A raw
    /// value is returned only while the user has explicitly enabled reveal.
    static func accessibilityValue(text: String, isEnabled: Bool, error: String?, revealed: Bool) -> String {
        guard isEnabled else { return "Disabled" }
        if let error { return "Error: \(error)" }
        if text.isEmpty { return "Empty" }
        return revealed ? text : "Value entered"
    }
}

/// Secure entry that never offers a reveal action. Use for PINs and write-only
/// credentials whose raw value must not return to display.
struct DesignMaskedField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var error: String? = nil
    var accessibilityId: String? = nil
    var keyboard: UIKeyboardType = .default
    var autoFocus = false
    var isEnabled = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            SecureField(prompt, text: $text)
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
                .keyboardType(keyboard)
                .padding(.horizontal, Space.md)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .designWell(focused: focused, error: error != nil)
                .focused($focused)
                .disabled(!isEnabled)
                .accessibilityLabel(title)
                .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : "Value entered"))
                .accessibilityHint(!isEnabled ? "Disabled" : (error.map { "Error: \($0)" } ?? "Value is hidden"))
                .accessibilityIdentifier(accessibilityId ?? "")
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
        .task { if autoFocus { focused = true } }
    }
}

struct DesignMultilineEditor: View {
    let title: String?
    @Binding var text: String
    var placeholder: String? = nil
    var maxLength: Int? = nil
    var error: String? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    @FocusState private var focused: Bool

    init(
        title: String? = nil,
        text: Binding<String>,
        placeholder: String? = nil,
        maxLength: Int? = nil,
        error: String? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        _text = text
        self.placeholder = placeholder
        self.maxLength = maxLength
        self.error = error
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            if let title {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
            }
            ZStack(alignment: .topLeading) {
                if text.isEmpty, let placeholder {
                    Text(placeholder)
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink4)
                        .padding(.horizontal, DesignMetrics.editorPlaceholderInsetH)
                        .padding(.vertical, DesignMetrics.editorPlaceholderInsetV)
                        .allowsHitTesting(false)
                }
                TextEditor(text: cappedBinding)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .scrollContentBackground(.hidden)
                    .padding(DesignMetrics.editorInset)
                    .disabled(!isEnabled)
                    .focused($focused)
                    .accessibilityLabel(title ?? "Text editor")
                    .accessibilityValue(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? (text.isEmpty ? "Empty" : text))
                    .accessibilityHint(!isEnabled ? "Disabled" : error.map { "Error: \($0)" } ?? "")
                    .accessibilityIdentifier(accessibilityId ?? "")
            }
            .frame(minHeight: DesignMetrics.multilineEditorMinHeight)
            .designWell(focused: focused, error: error != nil)
            if let maxLength {
                Text("\(text.count) / \(maxLength)")
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(text.count >= maxLength ? DuskColors.stop : DuskColors.ink3)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityLabel("\(text.count) of \(maxLength) characters")
                    .accessibilityIdentifier(accessibilityId.map { "\($0)-count" } ?? "")
            }
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var cappedBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                guard let maxLength, newValue.count > maxLength else {
                    text = newValue
                    return
                }
                text = String(newValue.prefix(maxLength))
            }
        )
    }
}

private struct DesignToggleTrack: View {
    @Environment(\.designControlPressed) private var pressed
    let isOn: Bool
    let isEnabled: Bool

    private var trackFace: LinearGradient {
        LinearGradient(
            colors: isOn
                ? [
                    DuskColors.accentSoft.overlaying(DuskColors.bgSunk, opacity: 0.20),
                    DuskColors.accentSoft,
                ]
                : [
                    DuskColors.bgSunk.overlaying(.black, opacity: DesignMaterialAdapter.wellTopBlack),
                    DuskColors.bgSunk.overlaying(
                        DuskColors.bgElev,
                        opacity: DesignMaterialAdapter.wellBottomElevated
                    ),
                ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule()
                .fill(
                    trackFace.shadow(
                        .inner(
                            color: .black.opacity(DesignMaterialAdapter.wellInsetOpacity),
                            radius: DesignMaterialAdapter.wellInsetBlur,
                            y: DesignMaterialAdapter.wellInsetY
                        )
                    )
                )
                .overlay {
                    Capsule().stroke(
                        isOn
                            ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.52)
                            : DuskColors.line,
                        lineWidth: DesignMetrics.hairline
                    )
                }
                .shadow(
                    color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity),
                    radius: 0,
                    y: 1
                )
                .frame(width: DesignMetrics.toggleWidth, height: DesignMetrics.toggleHeight)

            let knobState: DesignSlateState = if !isEnabled {
                .disabled
            } else if pressed {
                .pressed
            } else {
                .rest
            }
            Circle()
                .fill(Color.clear)
                .frame(width: DesignMetrics.toggleKnobSize, height: DesignMetrics.toggleKnobSize)
                .background {
                    SlateFace(
                        shape: Circle(),
                        role: .secondary,
                        state: knobState,
                        baseOverride: isOn ? DuskColors.accent : DuskColors.paper
                    )
                }
                .clipShape(Circle())
                .overlay {
                    Circle().stroke(
                        isOn
                            ? DuskColors.accent
                            : DuskColors.line.overlaying(DuskColors.ink, opacity: 0.20),
                        lineWidth: DesignMetrics.hairline
                    )
                }
                .background {
                    SlateShadowLayers(shape: Circle(), role: .secondary, state: knobState)
                }
                .offset(
                    x: isOn ? DesignMetrics.toggleTravel : 4,
                    y: pressed ? DesignMetrics.pressedDepth : 0
                )
        }
        .frame(width: DesignMetrics.toggleWidth, height: DesignMetrics.minimumTarget)
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
    }
}

private struct DesignTogglePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.designControlPressed, configuration.isPressed)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.99 : 1)
            .offset(y: configuration.isPressed ? DesignMetrics.pressedDepth : 0)
    }
}

private struct DesignToggleStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: Space.md) {
                configuration.label
                Spacer(minLength: Space.sm)
                DesignToggleTrack(isOn: configuration.isOn, isEnabled: isEnabled)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignTogglePressStyle())
        .animation(
            reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: DesignMetrics.toggleAnimationDuration),
            value: configuration.isOn
        )
    }
}

struct DesignToggleSwitch: View {
    let label: String
    @Binding var isOn: Bool
    var accessibilityId: String? = nil
    var isEnabled = true

    var body: some View {
        Toggle(label, isOn: $isOn)
            .labelsHidden()
            .toggleStyle(DesignToggleStyle())
            .disabled(!isEnabled)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .accessibilityLabel(label)
            .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignToggleRow: View {
    let title: String
    var detail: String? = nil
    @Binding var isOn: Bool
    var accessibilityId: String? = nil
    var isEnabled = true

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
            }
        }
        .toggleStyle(DesignToggleStyle())
        .disabled(!isEnabled)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? (isOn ? "On" : "Off") : "Disabled")
        .accessibilityHint(detail ?? "")
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

private struct DesignSegmentButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Segment press feedback is deliberately immediate; selection
            // movement remains owned by the segmented control.
            .offset(y: configuration.isPressed && !reduceMotion ? DesignMetrics.pressedDepth : 0)
    }
}

struct DesignSegmentedPicker<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil
    var isEnabled = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selectionNamespace

    init(
        title: String,
        options: [(value: Value, label: String)],
        selection: Binding<Value>,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        self.options = options
        _selection = selection
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        HStack(spacing: DesignMetrics.segmentGap) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button {
                    selection = option.value
                } label: {
                    Text(option.label)
                        .font(Typo.ui(DesignMetrics.segmentLabelSize))
                        .foregroundStyle(selection == option.value ? DuskColors.accent : DuskColors.ink2)
                        .frame(maxWidth: .infinity, minHeight: DesignMetrics.segmentHeight)
                        .padding(.horizontal, DesignMetrics.segmentHorizontalPadding)
                        .background {
                            if selection == option.value {
                                RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous)
                                    .fill(Color.clear)
                                    .background {
                                        SlateFace(
                                            shape: RoundedRectangle(
                                                cornerRadius: DesignMetrics.segmentCornerRadius,
                                                style: .continuous
                                            ),
                                            role: .secondary,
                                            state: .rest,
                                            baseOverride: DuskColors.accent50
                                        )
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: DesignMetrics.segmentCornerRadius, style: .continuous)
                                            .stroke(
                                                DuskColors.lineSoft.overlaying(DuskColors.accent, opacity: 0.22),
                                                lineWidth: DesignMetrics.hairline
                                            )
                                    }
                                    .background {
                                        let shape = RoundedRectangle(
                                            cornerRadius: DesignMetrics.segmentCornerRadius,
                                            style: .continuous
                                        )
                                        ZStack {
                                            DesignSpreadShadow(
                                                shape: shape,
                                                color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                                                geometry: DesignMaterialShadowGeometry.slateRest
                                            )
                                            DesignSpreadShadow(
                                                shape: shape,
                                                color: DuskColors.bgSunk.opacity(0.88),
                                                geometry: DesignDropShadowGeometry(
                                                    radius: 0,
                                                    y: 2,
                                                    sourceInset: 1
                                                )
                                            )
                                        }
                                    }
                                    .matchedGeometryEffect(id: "selected-segment", in: selectionNamespace)
                            }
                        }
                }
                .buttonStyle(DesignSegmentButtonStyle())
                .disabled(!isEnabled)
            }
        }
        .padding(DesignMetrics.segmentBedPadding)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .designWell(cornerRadius: Radii.sm)
        .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: selection)
        .accessibilityLabel(title)
        .accessibilityValue(isEnabled ? selectedLabel : "Disabled")
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var selectedLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Not selected"
    }
}

private struct DesignStateAccessibilityModifier: ViewModifier {
    let state: DesignControlState

    @ViewBuilder
    func body(content: Content) -> some View {
        switch state {
        case .normal:
            content
        default:
            content.accessibilityValue(state.accessibilityValue)
        }
    }
}

/// Native date selection with shared state, error, target, and accessibility
/// semantics. The DatePicker itself remains SwiftUI-native so locale, calendar,
/// time-zone, Dynamic Type, and system editing behavior are untouched.
struct DesignDatePicker: View {
    let title: String
    @Binding var selection: Date
    var range: PartialRangeFrom<Date>? = nil
    let displayedComponents: DatePickerComponents
    var timeZone: TimeZone = .current
    var labelsHidden = false
    var error: String? = nil
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget

    init(
        title: String,
        selection: Binding<Date>,
        range: PartialRangeFrom<Date>? = nil,
        displayedComponents: DatePickerComponents,
        timeZone: TimeZone = .current,
        labelsHidden: Bool = false,
        error: String? = nil,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        minimumHeight: CGFloat = DesignMetrics.minimumTarget
    ) {
        self.title = title
        _selection = selection
        self.range = range
        self.displayedComponents = displayedComponents
        self.timeZone = timeZone
        self.labelsHidden = labelsHidden
        self.error = error
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.minimumHeight = minimumHeight
    }

    private var effectiveState: DesignControlState {
        if !isEnabled { return .disabled }
        if let error { return .error(error) }
        return state
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            picker
                .environment(\.timeZone, timeZone)
                .disabled(!effectiveState.isInteractive)
                .frame(minHeight: minimumHeight)
                .accessibilityLabel(title)
                .accessibilityHint(accessibilityHint)
                .accessibilityIdentifier(accessibilityId ?? "")
                .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
                .modifier(DesignStateAccessibilityModifier(state: effectiveState))
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var accessibilityHint: String {
        switch effectiveState {
        case .error(let message): "Error: \(message)"
        case .disabled: "Disabled"
        default: ""
        }
    }

    @ViewBuilder
    private var picker: some View {
        if let range {
            if labelsHidden {
                DatePicker(title, selection: $selection, in: range, displayedComponents: displayedComponents)
                    .labelsHidden()
            } else {
                DatePicker(title, selection: $selection, in: range, displayedComponents: displayedComponents)
            }
        } else if labelsHidden {
            DatePicker(title, selection: $selection, displayedComponents: displayedComponents)
                .labelsHidden()
        } else {
            DatePicker(title, selection: $selection, displayedComponents: displayedComponents)
        }
    }
}

/// Native integer stepper with shared state, error, target, and accessibility
/// semantics. Callers retain ownership of value mapping and change handling.
struct DesignStepper: View {
    let title: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var error: String? = nil
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var valueDescription: (Int) -> String = { String($0) }

    init(
        title: String,
        value: Binding<Int>,
        range: ClosedRange<Int>,
        error: String? = nil,
        state: DesignControlState = .normal,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        valueDescription: @escaping (Int) -> String = { String($0) }
    ) {
        self.title = title
        _value = value
        self.range = range
        self.error = error
        self.state = state
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.valueDescription = valueDescription
    }

    private var effectiveState: DesignControlState {
        if !isEnabled { return .disabled }
        if let error { return .error(error) }
        return state
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Stepper(title, value: $value, in: range)
                .disabled(!effectiveState.isInteractive)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .accessibilityLabel(title)
                .accessibilityValue(accessibilityValue)
                .accessibilityHint(accessibilityHint)
                .accessibilityIdentifier(accessibilityId ?? "")
                .accessibilityAddTraits(effectiveState.isSelected ? .isSelected : [])
            if let error {
                DesignFieldError(message: error, accessibilityId: accessibilityId.map { "\($0)-error" })
            }
        }
    }

    private var accessibilityValue: String {
        switch effectiveState {
        case .normal: valueDescription(value)
        default: effectiveState.accessibilityValue
        }
    }

    private var accessibilityHint: String {
        switch effectiveState {
        case .error(let message): "Error: \(message)"
        case .disabled: "Disabled"
        default: ""
        }
    }
}

struct DesignSelect<Value: Hashable>: View {
    let title: String
    var detail: String? = nil
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var isEnabled = true
    var accessibilityId: String? = nil
    var optionAccessibilityId: ((Value) -> String)? = nil

    init(
        title: String,
        detail: String? = nil,
        options: [(value: Value, label: String)],
        selection: Binding<Value>,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        optionAccessibilityId: ((Value) -> String)? = nil
    ) {
        self.title = title
        self.detail = detail
        self.options = options
        _selection = selection
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.optionAccessibilityId = optionAccessibilityId
    }

    var body: some View {
        HStack(spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink3)
                }
            }
            Spacer(minLength: Space.sm)
            Menu {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button {
                        selection = option.value
                    } label: {
                        if option.value == selection {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                    .accessibilityIdentifier(optionAccessibilityId?(option.value) ?? "")
                }
            } label: {
                HStack(spacing: Space.xs) {
                    Text(currentLabel)
                        .font(Typo.ui(DesignMetrics.controlLabelSize))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(Typo.ui(TypeScale.sm, .medium))
                        .foregroundStyle(DuskColors.ink3)
                }
                .padding(.horizontal, Space.md)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .designWell()
            }
            .disabled(!isEnabled)
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? currentLabel : "Disabled")
            .accessibilityHint(detail ?? "")
            .accessibilityIdentifier(accessibilityId ?? "")
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
    }

    private var currentLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Select…"
    }
}

private struct DesignSliderThumb: View {
    let focused: Bool
    let enabled: Bool

    var body: some View {
        Circle()
            .fill(
                RadialGradient(
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.22), location: 0),
                        .init(color: .clear, location: 0.72),
                    ],
                    center: UnitPoint(x: 0.5, y: 0.55),
                    startRadius: 0,
                    endRadius: DesignMetrics.sliderThumbSize
                )
            )
            .overlay {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.05), DuskColors.paper],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .opacity(0.62)
            }
            .overlay {
                Circle().stroke(DuskColors.line, lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                if focused {
                    Circle().stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder).padding(DesignMetrics.focusBorderInset)
                }
            }
            .clipShape(Circle())
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: .black.opacity(enabled ? 0.94 : DesignMaterialAdapter.slateDisabledBlack),
                        geometry: enabled
                            ? DesignMaterialShadowGeometry.slateRest
                            : DesignMaterialShadowGeometry.slateDisabled
                    )
                    if enabled {
                        DesignSpreadShadow(
                            shape: Circle(),
                            color: DuskColors.accent.opacity(0.20),
                            geometry: DesignDropShadowGeometry(radius: 16, y: 10, sourceInset: 13)
                        )
                    }
                    DesignSpreadShadow(
                        shape: Circle(),
                        color: DuskColors.bgSunk.opacity(0.88),
                        geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
                    )
                }
            }
            .frame(width: DesignMetrics.sliderThumbSize, height: DesignMetrics.sliderThumbSize)
    }
}

struct DesignSlider: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1
    var format: ((Double) -> String)? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    @FocusState private var focused: Bool

    init(
        title: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double = 1,
        format: ((Double) -> String)? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true
    ) {
        self.title = title
        _value = value
        self.range = range
        self.step = step
        self.format = format
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            HStack(spacing: Space.md) {
                ZStack {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        let thumbX = min(max(normalizedValue * width, DesignMetrics.sliderThumbSize / 2), width - DesignMetrics.sliderThumbSize / 2)
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(DuskColors.bgSunk)
                                .frame(maxWidth: .infinity)
                                .frame(height: DesignMetrics.sliderTrackHeight)
                                .shadow(color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity), radius: 0, y: 1)
                                .offset(y: 18)
                            Capsule()
                                .fill(
                                    DuskColors.accentSoft.overlaying(DuskColors.accent, opacity: 0.58)
                                )
                                .frame(width: max(0, width * normalizedValue), height: DesignMetrics.sliderTrackHeight)
                                .offset(y: 18)
                            DesignSliderThumb(focused: focused, enabled: isEnabled)
                                .position(x: thumbX, y: 22)
                        }
                    }
                    .allowsHitTesting(false)
                    Slider(value: $value, in: range, step: step) { Text(title) }
                        .labelsHidden()
                        .tint(.clear)
                        .opacity(0.01)
                        .focused($focused)
                        .disabled(!isEnabled)
                        .accessibilityLabel(title)
                        .accessibilityValue(isEnabled ? (format?(value) ?? String(value)) : "Disabled")
                        .accessibilityIdentifier(accessibilityId ?? "")
                }
                .frame(minWidth: DesignMetrics.sliderMinimumTrackWidth, minHeight: DesignMetrics.minimumTarget)
                if let format {
                    Text(format(value))
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minWidth: DesignMetrics.sliderOutputWidth, alignment: .trailing)
                }
            }
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .saturation(isEnabled ? 1 : 0.35)
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .padding(.vertical, Space.sm)
    }

    private var normalizedValue: CGFloat {
        guard range.upperBound > range.lowerBound else { return 0 }
        return CGFloat(min(max((value - range.lowerBound) / (range.upperBound - range.lowerBound), 0), 1))
    }
}

private struct DesignChipButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let selected: Bool
    let hovered: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let state: DesignSlateState = if !isEnabled {
            .disabled
        } else if pressed {
            .pressed
        } else if hovered {
            .hover
        } else {
            .rest
        }
        let shape = Capsule()
        configuration.label
            // Keep font metrics invariant across states so selection never
            // changes the chip's intrinsic width.
            .font(Typo.ui(DesignMetrics.controlLabelSize, .regular))
            .foregroundStyle(isEnabled ? (selected ? DuskColors.accent : DuskColors.ink2) : DuskColors.ink4)
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .background {
                if selected {
                    DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
                } else {
                    SlateFace(shape: shape, role: .secondary, state: state, baseOverride: DuskColors.paper)
                }
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(
                    selected || hovered ? Color.clear : DuskColors.line,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .background {
                if selected {
                    ZStack {
                        DesignSpreadShadow(
                            shape: shape,
                            color: pressed
                                ? .black.opacity(DesignMaterialAdapter.slatePressedBlack)
                                : DuskColors.accent.opacity(0.40),
                            geometry: pressed
                                ? DesignMaterialShadowGeometry.slatePressed
                                : DesignDropShadowGeometry(radius: 16, y: 8, sourceInset: 14)
                        )
                        DesignSpreadShadow(
                            shape: shape,
                            color: DuskColors.bgSunk.opacity(0.88),
                            geometry: DesignDropShadowGeometry(radius: 0, y: pressed ? 1 : 2, sourceInset: 1)
                        )
                    }
                } else {
                    SlateShadowLayers(shape: shape, role: .secondary, state: state)
                }
            }
            .offset(y: selected ? (pressed ? 2 : 1) : (pressed ? DesignMetrics.pressedDepth : hovered ? -1 : 0))
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .animation(
                DesignV2.Motion.animation(
                    duration: pressed ? DesignMetrics.buttonPressTransition : DesignV2.Motion.feedback,
                    reduceMotion: reduceMotion
                ),
                value: state
            )
    }
}

struct DesignChip: View {
    let title: String
    var selected = false
    var isEnabled = true
    var accessibilityId: String? = nil
    let action: () -> Void
    @State private var hovered = false

    init(
        title: String,
        selected: Bool = false,
        isEnabled: Bool = true,
        accessibilityId: String? = nil,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.selected = selected
        self.isEnabled = isEnabled
        self.accessibilityId = accessibilityId
        self.action = action
    }

    var body: some View {
        Button(title, action: action)
            .buttonStyle(DesignChipButtonStyle(selected: selected, hovered: hovered))
            .onHover { hovered = $0 }
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (selected ? "Selected" : "Not selected") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct DesignCheckboxMark: View {
    @Environment(\.designControlPressed) private var pressed
    let isOn: Bool
    let isEnabled: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(
            cornerRadius: DesignMetrics.checkboxCornerRadius,
            style: .continuous
        )
    }

    var body: some View {
        let faceState: DesignSlateState = if !isEnabled {
            .disabled
        } else if pressed {
            .pressed
        } else {
            .rest
        }
        ZStack {
            if !isEnabled {
                SlateFace(shape: shape, role: .quiet, state: .disabled)
            } else if isOn {
                SlateFace(
                    shape: shape,
                    role: .secondary,
                    state: faceState,
                    baseOverride: DuskColors.accent
                )
            } else {
                DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
            }
            shape.stroke(
                isOn && isEnabled
                    ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.48)
                    : DuskColors.line,
                lineWidth: DesignMetrics.hairline
            )
            if isOn {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(isEnabled ? DuskColors.bgSunk : DuskColors.ink4)
            }
        }
        .frame(width: DesignMetrics.checkboxSize, height: DesignMetrics.checkboxSize)
        .clipShape(shape)
        .background {
            ZStack {
                if !isEnabled {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateDisabledBlack),
                        geometry: DesignMaterialShadowGeometry.slateDisabled
                    )
                } else if pressed {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slatePressedBlack),
                        geometry: DesignMaterialShadowGeometry.slatePressed
                    )
                } else if isOn {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                        geometry: DesignMaterialShadowGeometry.slateRest
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.accent.opacity(0.50),
                        geometry: DesignDropShadowGeometry(radius: 15, y: 9, sourceInset: 12)
                    )
                }
                DesignSpreadShadow(
                    shape: shape,
                    color: DuskColors.bgSunk.opacity(0.88),
                    geometry: DesignDropShadowGeometry(radius: 0, y: pressed ? 1 : 2, sourceInset: 1)
                )
            }
        }
    }
}

private struct DesignCheckboxStyle: ToggleStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        Button(action: { configuration.isOn.toggle() }) {
            HStack(spacing: DesignMetrics.checkboxGap) {
                DesignCheckboxMark(isOn: configuration.isOn, isEnabled: isEnabled)
                configuration.label
                    .font(Typo.ui(DesignMetrics.controlLabelSize))
                    .foregroundStyle(isEnabled ? DuskColors.ink2 : DuskColors.ink4)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignTogglePressStyle())
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
            value: configuration.isOn
        )
    }
}

struct DesignCheckbox: View {
    let title: String
    @Binding var isOn: Bool
    var isEnabled = true
    var accessibilityId: String? = nil

    var body: some View {
        Toggle(isOn: $isOn) { Text(title) }
            .toggleStyle(DesignCheckboxStyle())
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(isEnabled ? (isOn ? "Checked" : "Unchecked") : "Disabled")
            .accessibilityIdentifier(accessibilityId ?? "")
            .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}

struct DesignProgress: View {
    var title: String? = nil
    var value: Double? = nil
    var accessibilityId: String? = nil

    var body: some View {
        HStack(spacing: Space.sm) {
            if let value { ProgressView(value: value) } else { ProgressView() }
            if let title { Text(title).font(Typo.ui(TypeScale.base)) }
        }
        .tint(DuskColors.accent)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title ?? "In progress")
        .accessibilityValue(progressValue)
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var progressValue: String {
        guard let value else { return "In progress" }
        return "\(Int((value * 100).rounded())) percent"
    }
}

struct DesignDivider: View {
    var body: some View {
        Rectangle()
            .fill(DuskColors.lineSoft)
            .frame(height: DesignMetrics.hairline)
            .accessibilityHidden(true)
    }
}

enum DesignUserAvatarTint: String, CaseIterable, Equatable {
    case terra
    case sage
    case amber
    case clay
    case fallback

    init(serverValue: String) {
        self = switch serverValue.lowercased() {
        case "terra": .terra
        case "sage": .sage
        case "amber": .amber
        case "clay": .clay
        default: .fallback
        }
    }

    var accent: Color {
        switch self {
        case .terra: DuskColors.accent
        case .sage: DuskColors.sage
        case .amber: DuskColors.amber
        case .clay: DuskColors.clay
        case .fallback: DuskColors.ink3
        }
    }

    var base: Color {
        switch self {
        case .terra: DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.18)
        case .sage: DuskColors.paper.overlaying(DuskColors.sageSoft, opacity: 0.18)
        case .amber: DuskColors.paper.overlaying(DuskColors.amber, opacity: 0.16)
        case .clay: DuskColors.paper.overlaying(DuskColors.clay, opacity: 0.20)
        case .fallback: DuskColors.paper.overlaying(DuskColors.bgElev, opacity: 0.14)
        }
    }
}

struct ElevatedUserAvatar: View {
    let name: String
    var size: CGFloat = DesignMetrics.minimumTarget
    var tint: DesignUserAvatarTint = .fallback
    var selected = false
    var disabled = false

    private var diameter: CGFloat { max(size, 1) }
    private var glyphColor: Color { disabled ? DuskColors.ink4 : tint.accent }

    var body: some View {
        Text(initials)
            .font(Typo.display(diameter * 0.42, .semibold))
            .foregroundStyle(glyphColor)
            .frame(width: diameter, height: diameter)
            .background(
                RadialGradient(
                    stops: [
                        .init(color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.28), location: 0),
                        .init(color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.18), location: 0.48),
                        .init(color: tint.base, location: 0.70),
                        .init(color: DuskColors.bgSunk, location: 1),
                    ],
                    center: UnitPoint(x: 0.5, y: 0.54),
                    startRadius: DesignMaterialAdapter.avatarGradientStartRadius,
                    endRadius: diameter * 0.75
                )
            )
            .clipShape(Circle())
            .overlay {
                if selected {
                    Circle()
                        .stroke(DuskColors.paper, lineWidth: 2)
                        .padding(-2)
                    Circle()
                        .stroke(tint.accent, lineWidth: DesignMaterialAdapter.avatarSelectedBorder)
                        .padding(-4)
                }
            }
            // Keep the avatar cast neutral. The identity accent belongs to
            // the face and selected ring, not to an ambient halo in the well.
            .shadow(color: DuskColors.bgSunk, radius: 0, y: 2)
            .shadow(color: .black.opacity(DesignMaterialAdapter.avatarShadowOpacity), radius: DesignMaterialAdapter.avatarShadowRadius, y: DesignMaterialAdapter.avatarShadowY)
            .shadow(color: selected ? tint.accent.opacity(0.60) : .clear, radius: selected ? 5 : 0, y: 0)
            .saturation(disabled ? 0.35 : 1)
            .opacity(disabled ? DesignMaterialAdapter.avatarDisabledOpacity : 1)
            .accessibilityLabel(name)
            .accessibilityValue(disabled ? "Disabled" : selected ? "Selected" : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var initials: String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}
