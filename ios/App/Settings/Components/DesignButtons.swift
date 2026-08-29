import SwiftUI

struct DesignButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isFocused) private var focused
    @Environment(\.colorSchemeContrast) private var contrast
    let role: DesignButtonRole
    var hovered = false
    var minimumHeight: CGFloat = DesignMetrics.minimumTarget
    var horizontalPadding: CGFloat = DesignMetrics.actionButtonHorizontalPadding
    var visualHeight: CGFloat? = nil

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let raised = hovered && isEnabled
        let shape = RoundedRectangle(cornerRadius: DesignMetrics.actionButtonCornerRadius, style: .circular)
        let faceHeight = min(visualHeight ?? minimumHeight, minimumHeight)
        let semanticHeight = max(minimumHeight, DesignMetrics.minimumTarget)
        configuration.label
            // `.snt-surface button { font: inherit; }` is more specific than
            // the presentation rule in the approved stylesheet, so the
            // rendered recipe uses the inherited 15pt regular UI face.
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(foreground)
            .frame(minHeight: faceHeight)
            .padding(.horizontal, horizontalPadding)
            .background { designSlateFace(role: role, muted: !isEnabled, hovered: raised) }
            .clipShape(shape)
            .overlay {
                // CSS borders paint inside the border box; use the native
                // inset form so the 44pt key does not grow by the centered
                // stroke width.
                shape.strokeBorder(border(raised: raised), lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                if let topLight = topLight(pressed: pressed, raised: raised) {
                    DesignTopEdgeLight(shape: shape, color: topLight)
                }
            }
            .overlay {
                shape
                    .stroke(
                        focused ? DuskColors.accent : .clear,
                        lineWidth: contrast == .increased ? 3 : DesignMetrics.focusBorder
                    )
                    .padding(DesignMetrics.focusBorderInset)
            }
            .background {
                ZStack {
                    // CSS lists the black cast before the ember cast, so the
                    // cast is composited over the glow where their envelopes
                    // overlap while the glow remains visible at its edge.
                    if glowOpacity(pressed: pressed) > 0 {
                        DesignSpreadShadow(
                            shape: shape,
                            color: glow.opacity(glowOpacity(pressed: pressed)),
                            geometry: glowGeometry(raised: raised)
                        )
                    }
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(castBlack(pressed: pressed, raised: raised)),
                        geometry: castGeometry(pressed: pressed, raised: raised)
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: contact(pressed: pressed, hovered: raised),
                        geometry: DesignDropShadowGeometry(
                            radius: 0,
                            y: !isEnabled
                                ? DesignMaterialAdapter.slateDisabledContactY
                                : pressed
                                    ? 1
                                    : DesignMaterialAdapter.slateContactY,
                            sourceInset: 1
                        )
                    )
                }
            }
            .offset(y: pressed ? DesignMetrics.pressedDepth : raised ? -1 : 0)
            // `isPressed` is intentionally discrete. Animating the material
            // shadow makes touch-down feel late, especially on a keypad.
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
                value: raised
            )
            .frame(minHeight: semanticHeight)
            .contentShape(Rectangle())
    }

    private func castBlack(pressed: Bool, raised: Bool) -> Double {
        if !isEnabled { return DesignMaterialAdapter.slateDisabledBlack }
        if pressed { return DesignMaterialAdapter.slatePressedBlack }
        if raised { return DesignMaterialAdapter.slateHoverBlack }
        return role == .action ? DesignMaterialAdapter.slateActionRestBlack : DesignMaterialAdapter.slateRestBlack
    }

    private func castGeometry(pressed: Bool, raised: Bool) -> DesignDropShadowGeometry {
        if !isEnabled { return DesignMaterialShadowGeometry.slateDisabled }
        if pressed { return DesignMaterialShadowGeometry.slatePressed }
        return raised ? DesignMaterialShadowGeometry.slateHover : DesignMaterialShadowGeometry.slateRest
    }

    private func glowOpacity(pressed: Bool) -> Double {
        guard isEnabled, !pressed else { return 0 }
        return switch role {
        case .action: DesignMaterialAdapter.slateActionGlow
        case .secondary: DesignMaterialAdapter.slateSecondaryGlow
        case .destructive: DesignMaterialAdapter.slateDestructiveGlow
        case .quiet: DesignMaterialAdapter.slateQuietGlow
        }
    }

    private func glowGeometry(raised: Bool) -> DesignDropShadowGeometry {
        if raised {
            return role == .destructive
                ? DesignMaterialShadowGeometry.slateDestructiveHoverGlow
                : DesignMaterialShadowGeometry.slateHoverGlow
        }
        switch role {
        case .action: return DesignMaterialShadowGeometry.slateActionGlow
        case .destructive: return DesignMaterialShadowGeometry.slateDestructiveGlow
        case .secondary, .quiet: return DesignMaterialShadowGeometry.slateGlow
        }
    }

    private func topLight(pressed: Bool, raised: Bool) -> Color? {
        guard !pressed else { return nil }
        if !isEnabled { return DuskColors.ink.opacity(DesignMaterialAdapter.slateDisabledTopLight) }
        if raised {
            return role == .destructive
                ? .white.opacity(DesignMaterialAdapter.slateDestructiveHoverTopLight)
                : DuskColors.ink.opacity(DesignMaterialAdapter.slateHoverTopLight)
        }
        switch role {
        case .action: return .white.opacity(DesignMaterialAdapter.slateActionTopLight)
        case .destructive: return .white.opacity(DesignMaterialAdapter.slateDestructiveTopLight)
        case .secondary, .quiet: return DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
        }
    }

    private var foreground: Color {
        if !isEnabled { return DuskColors.ink4 }
        switch role {
        case .action: return DuskColors.ink
        case .secondary, .destructive, .quiet: return DuskColors.ink
        }
    }

    private func border(raised: Bool) -> Color {
        if !isEnabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        }
        if raised { return .clear }
        if contrast == .increased { return DuskColors.ink3 }
        return switch role {
        case .action:
            DuskColors.accent.overlaying(
                DuskColors.bgSunk,
                opacity: 1 - DesignMaterialAdapter.slateActionBorder
            )
        case .secondary: DuskColors.line
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

    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }

    private func contact(pressed: Bool, hovered: Bool) -> Color {
        if !isEnabled {
            return DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDisabledContactMix
            )
        }
        if pressed { return DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10) }
        if hovered {
            return role == .destructive
                ? DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: 0.46)
                : DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10)
        }
        switch role {
        case .action: return DuskColors.bgSunk.overlaying(DuskColors.accent, opacity: 0.22)
        case .secondary, .quiet: return DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.12)
        case .destructive: return DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: 0.38)
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
    var visualHeight: CGFloat? = nil
    @State private var hovered = false

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            HStack(spacing: Space.sm) {
                if state == .loading { ProgressView().controlSize(.small) }
                Text(state == .loading ? "Loading" : title)
                    // SwiftUI's custom-font line fragment places this run below
                    // the CSS 1.55 line box; lift only the text, not the target.
                    .baselineOffset(DesignMetrics.actionButtonTextBaselineOffset)
                    .frame(maxWidth: fillsWidth ? .infinity : nil)
            }
        }
        .buttonStyle(
            DesignButtonStyle(
                role: role,
                hovered: hovered,
                minimumHeight: minimumHeight,
                // CSS auto-sized buttons include their 1pt border in the
                // intrinsic box; SwiftUI's inset stroke does not, so reserve
                // that border width in the native layout.
                horizontalPadding: DesignMetrics.actionButtonHorizontalPadding + DesignMetrics.hairline,
                visualHeight: visualHeight ?? (minimumHeight == DesignMetrics.minimumTarget ? DesignMetrics.actionButtonVisualHeight : minimumHeight)
            )
        )
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
    // Existing contextual icon affordances remain quiet by default.
    // Foundation fixtures request the neutral secondary role explicitly.
    var role: DesignButtonRole = .quiet
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    var minimumSize: CGFloat = DesignMetrics.minimumTarget
    let action: () -> Void
    @State private var hovered = false

    // The standard icon face follows the reviewed 40pt key geometry; the
    // surrounding view remains the native 44pt semantic target. Larger product
    // keys, such as the PIN keypad, retain their caller-owned face size.
    private var visualSize: CGFloat {
        minimumSize == DesignMetrics.minimumTarget
            ? DesignMetrics.actionButtonVisualHeight
            : minimumSize
    }

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            Image(systemName: systemName)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .frame(width: visualSize, height: visualSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(
            DesignButtonStyle(
                role: role,
                hovered: hovered,
                minimumHeight: minimumSize,
                horizontalPadding: 0,
                visualHeight: visualSize
            )
        )
        .onHover { hovered = $0 }
        .disabled(!state.isInteractive)
        .accessibilityLabel(label)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
        .frame(width: minimumSize, height: minimumSize)
        .contentShape(Rectangle())
    }
}

/// Plain, minimum-target actions for compact product controls. The primitive
/// owns press motion and state semantics while callers supply only the
/// product-specific label composition.
struct DesignCompactButton<Label: View>: View {
    let accessibilityLabel: String
    var role: DesignButtonRole = .quiet
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
        role: DesignButtonRole = .quiet,
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
    // Compact product affordances remain quiet by default, while approved
    // foundation variants can request the same semantic role explicitly.
    var role: DesignButtonRole = .quiet
    var state: DesignControlState = .normal
    var isEnabled = true
    var accessibilityId: String? = nil
    var pressedScale: CGFloat = 0.985
    let action: () -> Void

    var body: some View {
        DesignCompactButton(
            accessibilityLabel: label,
            role: role,
            state: state,
            isEnabled: isEnabled,
            accessibilityId: accessibilityId,
            minimumWidth: DesignMetrics.minimumTarget,
            minimumHeight: DesignMetrics.minimumTarget,
            pressedScale: pressedScale,
            action: action
        ) {
            Image(systemName: systemName)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
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
    @Environment(\.colorSchemeContrast) private var contrast
    let pressedScale: CGFloat
    var role: DesignButtonRole = .quiet
    var selected = false
    var hovered = false

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let raised = hovered && isEnabled
        let shape = RoundedRectangle(
            cornerRadius: selected ? Radii.sm : DesignMetrics.actionButtonCornerRadius,
            style: .continuous
        )
        configuration.label
            .background {
                if selected {
                    DesignWellFace(shape: shape, focused: false, showsInsetHighlights: true)
                } else {
                    designSlateFace(role: role, muted: !isEnabled, hovered: raised)
                }
            }
            .clipShape(shape)
            .overlay {
                shape.strokeBorder(
                    selected ? Color.clear : border(raised: raised),
                    lineWidth: DesignMetrics.hairline
                )
            }
            .overlay {
                if !selected, let topLight = topLight(pressed: pressed, raised: raised) {
                    DesignTopEdgeLight(shape: shape, color: topLight)
                }
            }
            .overlay {
                if focused {
                    shape.stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder)
                        .padding(DesignMetrics.focusBorderInset)
                }
            }
            .background {
                ZStack {
                    if selected {
                        DesignSpreadShadow(
                            shape: shape,
                            color: pressed
                                ? .black.opacity(DesignMaterialAdapter.slatePressedBlack)
                                : DuskColors.accent.opacity(0.40),
                            geometry: pressed
                                ? DesignMaterialShadowGeometry.slatePressed
                                : DesignDropShadowGeometry(radius: 16, y: 8, sourceInset: 14)
                        )
                    } else {
                        // See the standalone action style above: the CSS
                        // black cast is above the ember cast in the list.
                        if glowOpacity(pressed: pressed) > 0 {
                            DesignSpreadShadow(
                                shape: shape,
                                color: glow.opacity(glowOpacity(pressed: pressed)),
                                geometry: glowGeometry(raised: raised)
                            )
                        }
                        DesignSpreadShadow(
                            shape: shape,
                            color: .black.opacity(castBlack(pressed: pressed, raised: raised)),
                            geometry: castGeometry(pressed: pressed, raised: raised)
                        )
                    }
                    DesignSpreadShadow(
                        shape: shape,
                        color: selected
                            ? DuskColors.bgSunk.opacity(0.88)
                            : contact(pressed: pressed, hovered: raised),
                        geometry: DesignDropShadowGeometry(
                            radius: 0,
                            y: selected
                                ? 1
                                : !isEnabled
                                    ? DesignMaterialAdapter.slateDisabledContactY
                                    : pressed
                                        ? 1
                                        : DesignMaterialAdapter.slateContactY,
                            sourceInset: 1
                        )
                    )
                }
            }
            .scaleEffect(pressed && !reduceMotion ? pressedScale : 1)
            .offset(y: selected ? (pressed ? 2 : 1) : (pressed ? DesignMetrics.pressedDepth : raised ? -1 : 0))
            .opacity(isEnabled ? 1 : DesignMaterialAdapter.selectDisabledOpacity)
            .animation(
                DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
                value: raised
            )
            // Keep press feedback discrete; an interpolated shadow delays the
            // visual response of compact touch controls.
    }

    private func castBlack(pressed: Bool, raised: Bool) -> Double {
        if !isEnabled { return DesignMaterialAdapter.slateDisabledBlack }
        if pressed { return DesignMaterialAdapter.slatePressedBlack }
        if raised { return DesignMaterialAdapter.slateHoverBlack }
        return role == .action ? DesignMaterialAdapter.slateActionRestBlack : DesignMaterialAdapter.slateRestBlack
    }

    private func castGeometry(pressed: Bool, raised: Bool) -> DesignDropShadowGeometry {
        if !isEnabled { return DesignMaterialShadowGeometry.slateDisabled }
        if pressed { return DesignMaterialShadowGeometry.slatePressed }
        return raised ? DesignMaterialShadowGeometry.slateHover : DesignMaterialShadowGeometry.slateRest
    }

    private func glowOpacity(pressed: Bool) -> Double {
        guard isEnabled, !pressed else { return 0 }
        return switch role {
        case .action: DesignMaterialAdapter.slateActionGlow
        case .secondary: DesignMaterialAdapter.slateSecondaryGlow
        case .destructive: DesignMaterialAdapter.slateDestructiveGlow
        case .quiet: DesignMaterialAdapter.slateQuietGlow
        }
    }

    private func glowGeometry(raised: Bool) -> DesignDropShadowGeometry {
        if raised {
            return role == .destructive
                ? DesignMaterialShadowGeometry.slateDestructiveHoverGlow
                : DesignMaterialShadowGeometry.slateHoverGlow
        }
        switch role {
        case .action: return DesignMaterialShadowGeometry.slateActionGlow
        case .destructive: return DesignMaterialShadowGeometry.slateDestructiveGlow
        case .secondary, .quiet: return DesignMaterialShadowGeometry.slateGlow
        }
    }

    private func topLight(pressed: Bool, raised: Bool) -> Color? {
        guard !pressed else { return nil }
        if !isEnabled { return DuskColors.ink.opacity(DesignMaterialAdapter.slateDisabledTopLight) }
        if raised {
            return role == .destructive
                ? .white.opacity(DesignMaterialAdapter.slateDestructiveHoverTopLight)
                : DuskColors.ink.opacity(DesignMaterialAdapter.slateHoverTopLight)
        }
        switch role {
        case .action: return .white.opacity(DesignMaterialAdapter.slateActionTopLight)
        case .destructive: return .white.opacity(DesignMaterialAdapter.slateDestructiveTopLight)
        case .secondary, .quiet: return DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
        }
    }

    private func border(raised: Bool) -> Color {
        if !isEnabled {
            return DuskColors.lineSoft.overlaying(
                DuskColors.bg,
                opacity: 1 - DesignMaterialAdapter.slateDisabledBorder
            )
        }
        if raised { return .clear }
        if contrast == .increased { return DuskColors.ink3 }
        return switch role {
        case .action:
            DuskColors.accent.overlaying(
                DuskColors.bgSunk,
                opacity: 1 - DesignMaterialAdapter.slateActionBorder
            )
        case .secondary: DuskColors.line
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

    private var glow: Color { role == .destructive ? DuskColors.stop : DuskColors.accent }

    private func contact(pressed: Bool, hovered: Bool) -> Color {
        if !isEnabled {
            return DuskColors.bgSunk.overlaying(
                DuskColors.line,
                opacity: DesignMaterialAdapter.slateDisabledContactMix
            )
        }
        if pressed { return DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10) }
        if hovered {
            return role == .destructive
                ? DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: 0.46)
                : DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10)
        }
        switch role {
        case .action: return DuskColors.bgSunk.overlaying(DuskColors.accent, opacity: 0.22)
        case .secondary, .quiet: return DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.12)
        case .destructive: return DuskColors.bgSunk.overlaying(DuskColors.stop, opacity: 0.38)
        }
    }
}
