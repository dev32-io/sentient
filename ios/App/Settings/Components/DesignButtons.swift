import SwiftUI

/// Stable native-control projection into the decorative Canvas kernel. Keeping
/// these flags independent lets focus compose with pointer and press feedback;
/// disabled only suppresses material movement, not an explicit focus signal.
struct DesignRaisedButtonKernelProjection: Equatable {
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let yOffset: CGFloat

    static func make(
        isEnabled: Bool,
        isPressed: Bool,
        isFocused: Bool,
        isHovered: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignRaisedButtonKernelProjection {
        let pressed = isPressed && isEnabled
        let hovered = isHovered && isEnabled
        return DesignRaisedButtonKernelProjection(
            state: DesignCanvasControlState(
                isHovered: hovered,
                isPressed: pressed,
                isFocused: isFocused,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            yOffset: pressed ? DesignMetrics.pressedDepth : hovered ? -1 : 0
        )
    }
}

struct DesignRaisedButtonGeometry: Equatable {
    let faceHeight: CGFloat
    let semanticHeight: CGFloat

    static func make(minimumHeight: CGFloat, visualHeight: CGFloat?) -> DesignRaisedButtonGeometry {
        DesignRaisedButtonGeometry(
            faceHeight: min(visualHeight ?? minimumHeight, minimumHeight),
            semanticHeight: max(minimumHeight, DesignMetrics.minimumTarget)
        )
    }
}

/// Selected compact controls use a receiving surface rather than a raised-key
/// role. Motion remains on the native label while this projection supplies the
/// decorative kernel with independent press, focus, hover, and disabled flags.
struct DesignSelectedCompactKernelProjection: Equatable {
    let state: DesignCanvasControlState
    let increasedContrast: Bool
    let reduceMotion: Bool
    let yOffset: CGFloat
    let scale: CGFloat

    static func make(
        isEnabled: Bool,
        isPressed: Bool,
        isFocused: Bool,
        isHovered: Bool,
        increasedContrast: Bool,
        reduceMotion: Bool,
        pressedScale: CGFloat
    ) -> DesignSelectedCompactKernelProjection {
        let pressed = isPressed && isEnabled
        return DesignSelectedCompactKernelProjection(
            state: DesignCanvasControlState(
                isHovered: isHovered && isEnabled,
                isPressed: pressed,
                isFocused: isFocused,
                isDisabled: !isEnabled
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion,
            yOffset: pressed ? DesignMetrics.pressedDepth * 2 : DesignMetrics.pressedDepth,
            scale: pressed && !reduceMotion ? pressedScale : 1
        )
    }
}

/// Background-only adapter. The owning SwiftUI `Button` retains actions,
/// focus, hit testing, Dynamic Type, layout direction, and accessibility.
private struct DesignRaisedButtonCanvasBackground: View {
    let shape: DesignCanvasShape
    let role: DesignButtonRole
    let projection: DesignRaisedButtonKernelProjection

    var body: some View {
        DesignCanvasKernel(
            shape: shape,
            role: role,
            state: projection.state,
            increasedContrast: projection.increasedContrast,
            reduceMotion: projection.reduceMotion
        )
        .animation(
            DesignCanvasKernel.transitionAnimation(for: .hover, reduceMotion: projection.reduceMotion),
            value: projection.state.isHovered
        )
        .animation(
            DesignCanvasKernel.transitionAnimation(for: .focus, reduceMotion: projection.reduceMotion),
            value: projection.state.isFocused
        )
        .animation(
            DesignCanvasKernel.transitionAnimation(for: projection.state.isPressed ? .press : .material, reduceMotion: projection.reduceMotion),
            value: projection.state.isPressed
        )
        .animation(
            DesignCanvasKernel.transitionAnimation(for: .material, reduceMotion: projection.reduceMotion),
            value: projection.state.isDisabled
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// One decorative Canvas backs the selected rounded-rectangle branch. It has
/// no content, gesture, responder, value, or accessibility ownership.
private struct DesignSelectedCompactCanvasBackground: View {
    let projection: DesignSelectedCompactKernelProjection

    var body: some View {
        DesignCanvasSmallControlKernel(
            profile: .selectedCompact,
            state: projection.state,
            increasedContrast: projection.increasedContrast,
            reduceMotion: projection.reduceMotion,
            appliesRecipeOpacity: false
        )
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .feedback,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isFocused
        )
        .animation(
            DesignCanvasSmallControlKernel.transitionAnimation(
                for: .material,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isDisabled
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

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
        let geometry = DesignRaisedButtonGeometry.make(
            minimumHeight: minimumHeight,
            visualHeight: visualHeight
        )
        let projection = DesignRaisedButtonKernelProjection.make(
            isEnabled: isEnabled,
            isPressed: configuration.isPressed,
            isFocused: focused,
            isHovered: hovered,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
        let cornerRadius = DesignMetrics.actionButtonCornerRadius
        let clipShape = RoundedRectangle(cornerRadius: cornerRadius, style: .circular)
        let canvasShape = DesignCanvasShape.roundedRectangle(cornerRadius: cornerRadius)

        configuration.label
            // `.snt-surface button { font: inherit; }` is more specific than
            // the presentation rule in the approved stylesheet, so the
            // rendered recipe uses the inherited 15pt regular UI face.
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(isEnabled ? DuskColors.ink : DuskColors.ink4)
            .frame(minHeight: geometry.faceHeight)
            .padding(.horizontal, horizontalPadding)
            .clipShape(clipShape)
            .background {
                DesignRaisedButtonCanvasBackground(
                    shape: canvasShape,
                    role: role,
                    projection: projection
                )
            }
            .offset(y: projection.yOffset)
            .animation(
                DesignCanvasKernel.transitionAnimation(for: .hover, reduceMotion: reduceMotion),
                value: projection.state.isHovered
            )
            .animation(
                DesignCanvasKernel.transitionAnimation(for: projection.state.isPressed ? .press : .pressRelease, reduceMotion: reduceMotion),
                value: projection.state.isPressed
            )
            .frame(minHeight: geometry.semanticHeight)
            .contentShape(Rectangle())
    }
}

struct DesignActionButton: View {
    let title: String
    var loadingTitle = "Loading"
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
                Text(state == .loading ? loadingTitle : title)
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
    // Standard icon buttons use the 40pt source face inside the native 44pt
    // target. Compact references use a 44pt face while retaining that target.
    var visualSizeOverride: CGFloat? = nil
    let action: () -> Void
    @State private var hovered = false

    // The standard icon face follows the reviewed 40pt key geometry; the
    // surrounding view remains the native 44pt semantic target. Larger product
    // keys, such as the PIN keypad, retain their caller-owned face size.
    private var visualSize: CGFloat {
        visualSizeOverride
            ?? (minimumSize == DesignMetrics.minimumTarget
                ? DesignMetrics.actionButtonVisualHeight
                : minimumSize)
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
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale, role: role, selected: state.isSelected, hovered: hovered))
        .onHover { hovered = $0 }
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(effectiveState.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
        // The caller's label remains the visual face. This outer native frame
        // only normalizes the semantic target and is a no-op for existing
        // Calendar controls that already meet the minimum.
        .frame(
            minWidth: max(minimumWidth ?? 0, DesignMetrics.minimumTarget),
            minHeight: max(minimumHeight, DesignMetrics.minimumTarget)
        )
        .contentShape(Rectangle())
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

    private var effectiveState: DesignControlState {
        isEnabled ? state : .disabled
    }

    @ViewBuilder
    var body: some View {
        if state.isSelected {
            selectedButton
        } else {
            // The unselected compact face follows the same native button
            // kernel as DesignIconButton, with the source's 44pt compact face.
            DesignIconButton(
                systemName: systemName,
                label: label,
                role: role,
                state: effectiveState,
                accessibilityId: accessibilityId,
                minimumSize: DesignMetrics.minimumTarget,
                visualSizeOverride: DesignMetrics.minimumTarget,
                action: action
            )
        }
    }

    private var selectedButton: some View {
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
        .buttonStyle(DesignCompactButtonStyle(pressedScale: pressedScale, selected: state.isSelected))
        .disabled(!effectiveState.isInteractive)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(selectionValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
        .frame(
            minWidth: max(minimumWidth ?? 0, DesignMetrics.minimumTarget),
            minHeight: max(minimumHeight, DesignMetrics.minimumTarget)
        )
        .contentShape(Rectangle())
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

    @ViewBuilder
    func makeBody(configuration: Configuration) -> some View {
        if selected {
            // Selected compact controls are explicit rounded-rectangle
            // receivers; the capsule-only selectedChip profile is not reused.
            selectedBody(configuration: configuration)
        } else {
            raisedBody(configuration: configuration)
        }
    }

    private func raisedBody(configuration: Configuration) -> some View {
        let projection = DesignRaisedButtonKernelProjection.make(
            isEnabled: isEnabled,
            isPressed: configuration.isPressed,
            isFocused: focused,
            isHovered: hovered,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
        let cornerRadius = DesignMetrics.actionButtonCornerRadius
        let clipShape = RoundedRectangle(cornerRadius: cornerRadius, style: .circular)

        return configuration.label
            .clipShape(clipShape)
            .background {
                DesignRaisedButtonCanvasBackground(
                    shape: .roundedRectangle(cornerRadius: cornerRadius),
                    role: role,
                    projection: projection
                )
            }
            .scaleEffect(projection.state.isPressed && !reduceMotion ? pressedScale : 1)
            .offset(y: projection.yOffset)
            .animation(
                DesignCanvasKernel.transitionAnimation(for: .hover, reduceMotion: reduceMotion),
                value: projection.state.isHovered
            )
            .animation(
                DesignCanvasKernel.transitionAnimation(for: projection.state.isPressed ? .press : .pressRelease, reduceMotion: reduceMotion),
                value: projection.state.isPressed
            )
    }

    private func selectedBody(configuration: Configuration) -> some View {
        let projection = DesignSelectedCompactKernelProjection.make(
            isEnabled: isEnabled,
            isPressed: configuration.isPressed,
            isFocused: focused,
            isHovered: hovered,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion,
            pressedScale: pressedScale
        )
        let clipShape = RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)

        return configuration.label
            .clipShape(clipShape)
            .background {
                DesignSelectedCompactCanvasBackground(projection: projection)
            }
            .scaleEffect(projection.scale)
            .offset(y: projection.yOffset)
            // Disabled selected material is one whole-control composition:
            // label and Canvas attenuate together while the direct kernel
            // keeps its recipe-owned opacity for standalone raster contracts.
            .compositingGroup()
            .opacity(
                projection.state.isDisabled
                    ? DesignMaterialAdapter.selectDisabledOpacity
                    : 1
            )
            .animation(
                DesignCanvasSmallControlKernel.transitionAnimation(
                    for: .material,
                    reduceMotion: reduceMotion
                ),
                value: projection.state.isDisabled
            )
            .transaction { transaction in
                if reduceMotion {
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            }
    }
}
