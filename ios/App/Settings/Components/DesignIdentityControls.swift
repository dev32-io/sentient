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

private enum UserAvatarMaterial {
    // These are the avatar-specific translations of the immutable CSS shadow
    // recipe. DesignSpreadShadow already implements negative spread without
    // changing the face's layout or introducing a second material kernel.
    static let restContact = DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
    static let restCast = DesignDropShadowGeometry(radius: 13, y: 9, sourceInset: 8)
    static let restEmberCast = DesignDropShadowGeometry(radius: 19, y: 13, sourceInset: 15)
    static let selectedContact = DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
    static let selectedCast = DesignDropShadowGeometry(radius: 12, y: 8, sourceInset: 8)
    static let selectedGlow = DesignDropShadowGeometry(radius: 17, y: 0, sourceInset: 5)
    static let disabledContact = DesignDropShadowGeometry(radius: 0, y: 1, sourceInset: 1)
    static let disabledCast = DesignDropShadowGeometry(radius: 9, y: 5, sourceInset: 8)

    static let restContactAccentMix = 0.04
    static let selectedContactAccentMix = 0.013
    static let disabledContactLineMix = 0.28
    static let disabledBaseInkMix = 0.03
}

struct ElevatedUserAvatar: View {
    let name: String
    var size: CGFloat = DesignMetrics.minimumTarget
    var tint: DesignUserAvatarTint = .fallback
    var selected = false
    var disabled = false
    var fallback = false
    var initial: String? = nil

    @Environment(\.colorSchemeContrast) private var contrast

    private var diameter: CGFloat { max(size, 1) }
    private var glyphColor: Color { disabled ? DuskColors.ink4 : tint.accent }

    var body: some View {
        Text(initials)
            .font(Typo.display(diameter * 0.42, .semibold))
            .foregroundStyle(glyphColor)
            .frame(width: diameter, height: diameter)
            .background(face)
            .clipShape(Circle())
            .overlay {
                if selected {
                    Circle()
                        .strokeBorder(DuskColors.paper, lineWidth: 2)
                        .padding(-2)
                    Circle()
                        // The paper ring covers the inner half of the CSS
                        // accent spread, leaving a 2pt visible accent band.
                        .strokeBorder(tint.accent, lineWidth: DesignMaterialAdapter.avatarSelectedBorder / 2)
                        .padding(-4)
                } else if contrast == .increased {
                    Circle()
                        .strokeBorder(DuskColors.ink3, lineWidth: DesignMetrics.hairline)
                }
            }
            .overlay {
                if selected {
                    // The source's downward contact shadow darkens the inner
                    // edge of the selected paper ring without adding a rim.
                    Circle()
                        .strokeBorder(
                            LinearGradient(
                                colors: [.clear, .clear, DuskColors.bgSunk],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 2
                        )
                        .padding(-2)
                }
            }
            .background(shadowLayers)
            .saturation(disabled ? 0.35 : 1)
            .opacity(disabled ? DesignMaterialAdapter.avatarDisabledOpacity : 1)
            .accessibilityLabel(accessibilityName)
            .accessibilityValue(disabled ? "Disabled" : selected ? "Selected" : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var face: some View {
        if disabled {
            ZStack {
                LinearGradient(
                    colors: [
                        tint.base.overlaying(DuskColors.ink4, opacity: UserAvatarMaterial.disabledBaseInkMix),
                        tint.base,
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                RadialGradient(
                    stops: [
                        .init(color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.16), location: 0),
                        .init(color: .clear, location: 0.74),
                    ],
                    center: UnitPoint(x: 0.5, y: 0.52),
                    startRadius: 0,
                    endRadius: diameter * 0.75
                )
            }
            .frame(width: diameter, height: diameter)
        } else {
            RadialGradient(
                stops: [
                    .init(color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.28), location: 0),
                    .init(color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.18), location: 0.48),
                    .init(color: tint.base, location: 0.70),
                    .init(color: DuskColors.bgSunk.overlaying(tint.accent, opacity: 0.10), location: 1),
                ],
                center: UnitPoint(x: 0.5, y: 0.54),
                startRadius: 0,
                endRadius: diameter * 0.75
            )
            .frame(width: diameter, height: diameter)
        }
    }

    @ViewBuilder
    private var shadowLayers: some View {
        if disabled {
            ZStack {
                DesignSpreadShadow(
                    shape: Circle(),
                    color: DuskColors.bgSunk.overlaying(
                        DuskColors.line,
                        opacity: UserAvatarMaterial.disabledContactLineMix
                    ),
                    geometry: UserAvatarMaterial.disabledContact
                )
                DesignSpreadShadow(
                    shape: Circle(),
                    color: .black.opacity(0.70),
                    geometry: UserAvatarMaterial.disabledCast
                )
            }
        } else {
            ZStack {
                DesignSpreadShadow(
                    shape: Circle(),
                    color: DuskColors.bgSunk.overlaying(
                        tint.accent,
                        opacity: selected
                            ? UserAvatarMaterial.selectedContactAccentMix
                            : UserAvatarMaterial.restContactAccentMix
                    ),
                    geometry: selected
                        ? UserAvatarMaterial.selectedContact
                        : UserAvatarMaterial.restContact
                )
                DesignSpreadShadow(
                    shape: Circle(),
                    color: .black.opacity(selected ? 0.96 : 0.98),
                    geometry: selected
                        ? UserAvatarMaterial.selectedCast
                        : UserAvatarMaterial.restCast
                )
                DesignSpreadShadow(
                    shape: Circle(),
                    color: selected ? tint.accent : tint.accent.opacity(0.40),
                    geometry: selected
                        ? UserAvatarMaterial.selectedGlow
                        : UserAvatarMaterial.restEmberCast
                )
            }
        }
    }

    private var accessibilityName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Unknown user" : name
    }

    private var initials: String {
        if fallback { return "?" }
        if let initial {
            let value = initial.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return String(value.prefix(2)).uppercased() }
        }
        let value = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        return value.isEmpty ? "?" : value
    }
}
