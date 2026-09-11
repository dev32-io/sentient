import SwiftUI

/// A counted icon action with one stable native button owner. The count changes
/// the primitive's material state and the decorative label only; it never
/// changes the action or creates a second accessibility element.
struct DesignBadgedIconButton: View {
    let systemName: String
    let label: String
    let count: Int
    var isEnabled = true
    var accessibilityId: String? = nil
    var countAccessibilityValue: String? = nil
    let action: () -> Void

    private var semantics: DesignBadgedIconButtonSemantics {
        DesignBadgedIconButtonSemantics.make(count: count, accessibilityValue: countAccessibilityValue)
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
        }
        .buttonStyle(DesignBadgedIconButtonStyle(semantics: semantics))
        .disabled(!isEnabled)
        .accessibilityLabel(label)
        .accessibilityValue(semantics.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
        .accessibilityAddTraits(semantics.isSelected ? .isSelected : [])
    }
}

private struct DesignBadgedIconButtonStyle: ButtonStyle {
    let semantics: DesignBadgedIconButtonSemantics
    @Environment(\.layoutDirection) private var direction
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    func makeBody(configuration: Configuration) -> some View {
        DesignCornerBadgeLayout(direction: direction) {
            // Apply the existing material to the 44pt face ONLY. Both that
            // face and the overlapping badge remain inside this one Button.
            face(configuration)
            DesignBadgedIconCountLabel(text: DesignBadgedIconButtonSemantics.maximumBadgeText)
                .hidden()
                .overlay {
                    if let text = semantics.badgeText {
                        DesignBadgedIconCountBadge(text: text)
                    }
                }
                .accessibilityHidden(true)
        }
        // Corner coordinates above already resolve the user's direction.
        // Keep the layout's coordinate system physical rather than mirroring
        // that resolved placement again in RTL.
        .environment(\.layoutDirection, .leftToRight)
        // Includes the entire corner decoration in the native action's bounds,
        // not an overflowing sibling with hits falling through to the calendar.
        .contentShape(Rectangle())
    }

    private func face(_ configuration: Configuration) -> some View {
        let projection = DesignRaisedButtonKernelProjection.make(
            isEnabled: isEnabled, isPressed: configuration.isPressed,
            isFocused: focused, isHovered: false,
            increasedContrast: contrast == .increased, reduceMotion: reduceMotion
        )
        return configuration.label
            .foregroundStyle(isEnabled ? DuskColors.ink : DuskColors.ink4)
            .background {
                if semantics.isSelected {
                    DesignCanvasSmallControlKernel(
                        profile: .selectedCompact, state: projection.state,
                        increasedContrast: projection.increasedContrast, reduceMotion: reduceMotion
                    )
                } else {
                    DesignCanvasKernel(
                        shape: .roundedRectangle(cornerRadius: DesignMetrics.actionButtonCornerRadius),
                        role: .quiet, state: projection.state,
                        increasedContrast: projection.increasedContrast, reduceMotion: reduceMotion
                    )
                }
            }
            .offset(y: projection.yOffset + (semantics.isSelected ? DesignMetrics.pressedDepth : 0))
            .animation(DesignCanvasKernel.transitionAnimation(for: .press, reduceMotion: reduceMotion),
                       value: projection.state.isPressed)
    }
}

/// Only half the capped badge extends beyond each face edge. The capped label
/// is measured at current Dynamic Type even at zero, so counts never move the
/// face or neighboring controls. No full-width count slot or second action.
private struct DesignCornerBadgeLayout: Layout {
    let direction: LayoutDirection

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let face = subviews[0].sizeThatFits(.unspecified)
        let badge = subviews[1].sizeThatFits(.unspecified)
        return CGSize(width: face.width + badge.width / 2, height: face.height + badge.height / 2)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let face = subviews[0].sizeThatFits(.unspecified)
        let badge = subviews[1].sizeThatFits(.unspecified)
        let faceX = direction == .rightToLeft ? bounds.maxX - face.width : bounds.minX
        let corner = CGPoint(x: direction == .rightToLeft ? faceX : faceX + face.width,
                             y: bounds.maxY - face.height)
        subviews[0].place(at: CGPoint(x: faceX, y: corner.y), anchor: .topLeading, proposal: .init(face))
        subviews[1].place(at: corner, anchor: .center, proposal: .init(badge))
    }
}

/// Presentation semantics are pure so count transitions can be regression
/// tested without constructing a SwiftUI hierarchy.
struct DesignBadgedIconButtonSemantics: Equatable {
    static let maximumBadgeText = "99+"

    let isSelected: Bool
    let showsBadge: Bool
    let badgeText: String?
    let accessibilityValue: String

    static func make(count: Int, accessibilityValue: String? = nil) -> Self {
        let normalizedCount = max(0, count)
        return Self(
            isSelected: normalizedCount > 0,
            showsBadge: normalizedCount > 0,
            badgeText: normalizedCount > 0
                ? (normalizedCount >= 100 ? maximumBadgeText : String(normalizedCount))
                : nil,
            accessibilityValue: accessibilityValue ?? String(normalizedCount)
        )
    }
}

private struct DesignBadgedIconCountLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typo.mono(TypeScale.xs).weight(.semibold))
            .foregroundStyle(DuskColors.bg)
            .padding(.horizontal, Space.xs)
            .padding(.vertical, Space.xs / 2)
            .frame(minWidth: 20, minHeight: 20)
            .fixedSize()
    }
}

private struct DesignBadgedIconCountBadge: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        DesignBadgedIconCountLabel(text: text)
            .background {
                // Only decorative pixels; the square button
                // remains the sole native action and accessibility owner.
                DesignCanvasKernel(
                    shape: .capsule,
                    role: .action,
                    state: DesignCanvasControlState(),
                    increasedContrast: contrast == .increased,
                    reduceMotion: reduceMotion
                )
            }
    }
}
