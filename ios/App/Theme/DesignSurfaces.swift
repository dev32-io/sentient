import SwiftUI

/// Renders the geometry of a CSS drop shadow with negative spread. Canvas's
/// `shadowOnly` option guarantees that the opaque source used to create the
/// blur is never painted into the component.
struct DesignSpreadShadow<S: InsettableShape>: View {
    let shape: S
    let color: Color
    let geometry: DesignDropShadowGeometry

    private var extent: CGFloat {
        geometry.radius + max(abs(geometry.x), abs(geometry.y))
    }

    var body: some View {
        GeometryReader { proxy in
            Canvas { context, size in
                let sourceRect = CGRect(
                    x: extent,
                    y: extent,
                    width: max(0, size.width - (extent * 2)),
                    height: max(0, size.height - (extent * 2))
                )
                let path = shape.inset(by: geometry.sourceInset).path(in: sourceRect)
                context.addFilter(
                    .shadow(
                        color: color,
                        radius: geometry.radius,
                        x: geometry.x,
                        y: geometry.y,
                        options: .shadowOnly
                    )
                )
                context.fill(path, with: .color(.white))
            }
            .frame(
                width: proxy.size.width + (extent * 2),
                height: proxy.size.height + (extent * 2)
            )
            .offset(x: -extent, y: -extent)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Shared recessed fill. Semantic controls stay native SwiftUI views while
/// this renderer owns the visual material and can also be reused by capsules
/// and compact selection surfaces.
struct DesignWellFace<S: Shape>: View {
    let shape: S
    let focused: Bool
    let showsInsetHighlights: Bool

    private var face: LinearGradient {
        LinearGradient(
            stops: [
                .init(
                    color: DuskColors.bgSunk.overlaying(.black, opacity: DesignMaterialAdapter.wellTopBlack),
                    location: 0
                ),
                .init(color: DuskColors.bgSunk, location: DesignMaterialAdapter.wellMiddleStop),
                .init(
                    color: DuskColors.bgSunk.overlaying(
                        DuskColors.bgElev,
                        opacity: DesignMaterialAdapter.wellBottomElevated
                    ),
                    location: 1
                ),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    var body: some View {
        shape.fill(
            showsInsetHighlights
                ? AnyShapeStyle(
                    face.shadow(
                        .inner(
                            color: .black.opacity(
                                focused
                                    ? DesignMaterialAdapter.wellInsetFocusOpacity
                                    : DesignMaterialAdapter.wellInsetOpacity
                            ),
                            radius: DesignMaterialAdapter.wellInsetBlur,
                            y: DesignMaterialAdapter.wellInsetY
                        )
                    )
                )
                : AnyShapeStyle(face)
        )
        .overlay {
            if showsInsetHighlights {
                shape
                    .stroke(
                        DuskColors.ink.opacity(
                            focused
                                ? DesignMaterialAdapter.wellBottomHighlightFocused
                                : DesignMaterialAdapter.wellBottomHighlight
                        ),
                        lineWidth: DesignMetrics.hairline
                    )
                    .mask(
                        LinearGradient(
                            colors: [.clear, .clear, .white],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
            }
        }
        .accessibilityHidden(true)
    }
}

private struct PlateSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let elevated: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
        let cast = elevated ? DesignMaterialShadowGeometry.float : DesignMaterialShadowGeometry.plate

        content
            .background {
                shape.fill(
                    DuskColors.paper.shadow(
                        .inner(
                            color: DuskColors.ink.opacity(
                                elevated
                                    ? DesignMaterialAdapter.slateElevatedTopLight
                                    : DesignMaterialAdapter.slateTopLightOpacity
                            ),
                            radius: DesignMaterialAdapter.plateInnerLightBlur,
                            y: DesignMaterialAdapter.plateInnerLightY
                        )
                    )
                )
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(
                    contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(
                            elevated
                                ? DesignMaterialAdapter.slateElevatedBlack
                                : DesignMaterialAdapter.slateRestBlack
                        ),
                        geometry: cast
                    )
                    if elevated {
                        DesignSpreadShadow(
                            shape: shape,
                            color: DuskColors.accent.opacity(DesignMaterialAdapter.slateElevatedEmber),
                            geometry: DesignMaterialShadowGeometry.floatGlow
                        )
                    }
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.bgSunk.overlaying(
                            DuskColors.line,
                            opacity: elevated
                                ? DesignMaterialAdapter.plateElevatedContactMix
                                : DesignMaterialAdapter.plateRestContactMix
                        ),
                        geometry: DesignDropShadowGeometry(
                            radius: 0,
                            y: elevated
                                ? DesignMaterialAdapter.slateElevatedContactY
                                : DesignMaterialAdapter.slateRestContactY,
                            sourceInset: 1
                        )
                    )
                }
            }
    }
}

private struct WellSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let focused: Bool
    let error: Bool
    let cornerRadius: CGFloat
    let showsBorder: Bool
    let showsInsetHighlights: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        content
            .background {
                DesignWellFace(
                    shape: shape,
                    focused: focused,
                    showsInsetHighlights: showsInsetHighlights
                )
            }
            .clipShape(shape)
            .overlay {
                if showsBorder {
                    shape.stroke(
                        error
                            ? DuskColors.stop
                            : focused
                                ? DuskColors.accent.overlaying(
                                    DuskColors.line,
                                    opacity: DesignMaterialAdapter.wellFocusMix
                                )
                                : (contrast == .increased ? DuskColors.ink3 : DuskColors.line),
                        lineWidth: DesignMetrics.hairline
                    )
                }
            }
            .shadow(
                color: DuskColors.line.opacity(DesignMaterialAdapter.wellLineOpacity),
                radius: 0,
                y: DesignMaterialAdapter.wellLineY
            )
            .shadow(
                color: focused ? DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusRingOpacity) : .clear,
                radius: DesignMetrics.focusRing
            )
            .shadow(
                color: focused ? DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusCastOpacity) : .clear,
                radius: DesignMaterialAdapter.wellFocusCastBlur,
                y: DesignMaterialAdapter.wellFocusCastY
            )
    }
}

extension View {
    func designPlate(elevated: Bool = false) -> some View {
        modifier(PlateSurface(elevated: elevated))
    }

    func designFloat() -> some View {
        modifier(PlateSurface(elevated: true))
    }

    func designWell(
        focused: Bool = false,
        error: Bool = false,
        cornerRadius: CGFloat = Radii.sm,
        showsBorder: Bool = true,
        showsInsetHighlights: Bool = true
    ) -> some View {
        modifier(
            WellSurface(
                focused: focused,
                error: error,
                cornerRadius: cornerRadius,
                showsBorder: showsBorder,
                showsInsetHighlights: showsInsetHighlights
            )
        )
    }
}
