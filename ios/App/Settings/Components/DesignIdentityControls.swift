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
    // The handoff captures every locked avatar inside a 24pt transparent field.
    // Keeping that field stable preserves the 28/44/56pt native face bounds.
    static let canvasOverflow: CGFloat = 24

    static let restContact = DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
    static let restCast = DesignDropShadowGeometry(radius: 13, y: 9, sourceInset: 8)
    static let restEmberCast = DesignDropShadowGeometry(radius: 19, y: 13, sourceInset: 15)

    // Selection seats the identity closer to the canvas and adds the approved
    // paper-then-accent annular treatment outside the unchanged face bounds.
    static let selectedPaperBandWidth: CGFloat = 2
    static let selectedAccentBandWidth: CGFloat = 2
    static let selectedContact = DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
    static let selectedCast = DesignDropShadowGeometry(radius: 12, y: 8, sourceInset: 8)
    static let selectedGlow = DesignDropShadowGeometry(radius: 17, y: 0, sourceInset: 5)

    static let disabledContact = DesignDropShadowGeometry(radius: 0, y: 1, sourceInset: 1)
    static let disabledCast = DesignDropShadowGeometry(radius: 9, y: 5, sourceInset: 8)

    static let restContactAccentMix = 0.04
    static let selectedContactAccentMix = 0.013
    static let disabledContactLineMix = 0.28
    static let disabledBaseInkMix = 0.03
    static let restGlowOpacity = 0.40
    static let selectedGlowOpacity = 1.0
    static let selectedFaceTintMix = 0.08
    static let selectedShoulderTintMix = 0.16
    static let selectedInnerOcclusionOpacity = 0.18
}

private struct UserAvatarShadowRecipe {
    let color: Color
    let opacity: Double
    let geometry: DesignDropShadowGeometry
}

/// Decorative-only identity material. One local Canvas owns the face, casts,
/// and state treatment while the native Text remains the layout, hit-testing,
/// and accessibility owner.
private struct UserAvatarCanvasBackground: View {
    let tint: DesignUserAvatarTint
    let selected: Bool
    let disabled: Bool
    let increasedContrast: Bool

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { proxy in
            let overflow = pixelAligned(UserAvatarMaterial.canvasOverflow)
            let faceRect = pixelAlignedFaceRect(size: proxy.size, overflow: overflow)
            let fieldSize = CGSize(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                drawMaterial(in: &context, faceRect: faceRect)
            }
            .frame(width: fieldSize.width, height: fieldSize.height)
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func drawMaterial(in context: inout GraphicsContext, faceRect: CGRect) {
        if disabled {
            drawShadow(
                UserAvatarShadowRecipe(
                    color: .black,
                    opacity: 0.70,
                    geometry: UserAvatarMaterial.disabledCast
                ),
                in: &context,
                faceRect: faceRect
            )
            drawShadow(
                UserAvatarShadowRecipe(
                    color: DuskColors.bgSunk.overlaying(
                        DuskColors.line,
                        opacity: UserAvatarMaterial.disabledContactLineMix
                    ),
                    opacity: 1,
                    geometry: UserAvatarMaterial.disabledContact
                ),
                in: &context,
                faceRect: faceRect
            )
        } else {
            drawShadow(
                UserAvatarShadowRecipe(
                    color: tint.accent,
                    opacity: selected
                        ? UserAvatarMaterial.selectedGlowOpacity
                        : UserAvatarMaterial.restGlowOpacity,
                    geometry: selected
                        ? UserAvatarMaterial.selectedGlow
                        : UserAvatarMaterial.restEmberCast
                ),
                in: &context,
                faceRect: faceRect
            )
            if selected {
                drawSelectedBands(in: &context, faceRect: faceRect)
            }
            drawShadow(
                UserAvatarShadowRecipe(
                    color: .black,
                    opacity: selected ? 0.92 : 0.98,
                    geometry: selected
                        ? UserAvatarMaterial.selectedCast
                        : UserAvatarMaterial.restCast
                ),
                in: &context,
                faceRect: faceRect
            )
            drawShadow(
                UserAvatarShadowRecipe(
                    color: DuskColors.bgSunk.overlaying(
                        tint.accent,
                        opacity: selected
                            ? UserAvatarMaterial.selectedContactAccentMix
                            : UserAvatarMaterial.restContactAccentMix
                    ),
                    opacity: 1,
                    geometry: selected
                        ? UserAvatarMaterial.selectedContact
                        : UserAvatarMaterial.restContact
                ),
                in: &context,
                faceRect: faceRect
            )
        }

        let facePath = Path(ellipseIn: faceRect)
        drawFace(facePath, in: &context, faceRect: faceRect)

        if selected {
            drawSelectedInnerOcclusion(facePath, in: &context)
        } else if increasedContrast {
            context.stroke(
                Path(ellipseIn: faceRect.insetBy(
                    dx: DesignMetrics.hairline / 2,
                    dy: DesignMetrics.hairline / 2
                )),
                with: .color(DuskColors.ink3),
                lineWidth: DesignMetrics.hairline
            )
        }
    }

    private func drawFace(
        _ facePath: Path,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        if disabled {
            context.fill(facePath, with: .linearGradient(
                Gradient(colors: [
                    tint.base.overlaying(
                        DuskColors.ink4,
                        opacity: UserAvatarMaterial.disabledBaseInkMix
                    ),
                    tint.base,
                ]),
                startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
            ))
            context.fill(facePath, with: .radialGradient(
                Gradient(stops: [
                    .init(
                        color: tint.base.overlaying(DuskColors.bgSunk, opacity: 0.16),
                        location: 0
                    ),
                    .init(color: .clear, location: 0.74),
                ]),
                center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.52),
                startRadius: 0,
                endRadius: faceRect.width * 0.75
            ))
            return
        }

        let base = selected
            ? tint.base.overlaying(tint.accent, opacity: UserAvatarMaterial.selectedFaceTintMix)
            : tint.base
        context.fill(facePath, with: .radialGradient(
            Gradient(stops: [
                .init(color: base.overlaying(DuskColors.bgSunk, opacity: 0.28), location: 0),
                .init(color: base.overlaying(DuskColors.bgSunk, opacity: 0.18), location: 0.48),
                .init(color: base, location: 0.70),
                .init(
                    color: DuskColors.bgSunk.overlaying(
                        tint.accent,
                        opacity: selected
                            ? UserAvatarMaterial.selectedShoulderTintMix
                            : 0.10
                    ),
                    location: 1
                ),
            ]),
            center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.54),
            startRadius: 0,
            endRadius: faceRect.width * 0.75
        ))
    }

    private func drawSelectedBands(
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let paperWidth = UserAvatarMaterial.selectedPaperBandWidth
        let accentWidth = UserAvatarMaterial.selectedAccentBandWidth
        let accentRect = faceRect.insetBy(
            dx: -(paperWidth + accentWidth),
            dy: -(paperWidth + accentWidth)
        )
        let paperRect = faceRect.insetBy(dx: -paperWidth, dy: -paperWidth)

        context.fill(Path(ellipseIn: accentRect), with: .color(tint.accent))
        context.fill(Path(ellipseIn: paperRect), with: .color(DuskColors.paper))
    }

    private func drawSelectedInnerOcclusion(
        _ facePath: Path,
        in context: inout GraphicsContext
    ) {
        DesignCanvasEffects.insetShadow(
            in: &context,
            facePath: facePath,
            sourcePath: facePath,
            color: Color.black.opacity(
                disabled
                    ? UserAvatarMaterial.selectedInnerOcclusionOpacity * 0.55
                    : UserAvatarMaterial.selectedInnerOcclusionOpacity
            ),
            blur: 3,
            y: 2
        )
    }

    private func drawShadow(
        _ recipe: UserAvatarShadowRecipe,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let sourceInset = recipe.geometry.sourceInset
        guard faceRect.width - 2 * sourceInset > 0,
              faceRect.height - 2 * sourceInset > 0 else { return }
        let source = Path(ellipseIn: faceRect.insetBy(dx: sourceInset, dy: sourceInset))
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: recipe.color.opacity(recipe.opacity),
            blur: recipe.geometry.radius,
            x: recipe.geometry.x,
            y: recipe.geometry.y
        )
    }

    private func pixelAligned(_ value: CGFloat) -> CGFloat {
        guard displayScale > 0 else { return value }
        return (value * displayScale).rounded() / displayScale
    }

    private func pixelAlignedFaceRect(size: CGSize, overflow: CGFloat) -> CGRect {
        let minX = pixelAligned(overflow)
        let minY = pixelAligned(overflow)
        let maxX = pixelAligned(overflow + size.width)
        let maxY = pixelAligned(overflow + size.height)
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
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
            .contentShape(Rectangle())
            .background {
                UserAvatarCanvasBackground(
                    tint: tint,
                    selected: selected,
                    disabled: disabled,
                    increasedContrast: contrast == .increased
                )
            }
            .saturation(disabled ? 0.35 : 1)
            .opacity(disabled ? DesignMaterialAdapter.avatarDisabledOpacity : 1)
            .accessibilityLabel(accessibilityName)
            .accessibilityValue(disabled ? "Disabled" : selected ? "Selected" : "")
            .accessibilityAddTraits(selected ? .isSelected : [])
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
