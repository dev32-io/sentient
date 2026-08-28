import SwiftUI

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
