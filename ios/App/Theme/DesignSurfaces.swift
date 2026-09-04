import SwiftUI
import UIKit

/// Renders a CSS box-shadow source with a negative spread using a native
/// Core Graphics shadow operation. The source path is still inset before the
/// blur, which is the CSS spread operation rather than a visual approximation
/// of it; the view is expanded so the transparent shadow tail remains visible.
struct DesignSpreadShadow<S: InsettableShape>: View {
    let shape: S
    let color: Color
    let geometry: DesignDropShadowGeometry

    private var extent: CGFloat {
        // A negative spread moves the source edge inward before the blur. The
        // expanded drawing field must include that inset as well as the
        // translated blur envelope; otherwise the outer CSS tail is clipped.
        geometry.sourceInset + geometry.radius + max(abs(geometry.x), abs(geometry.y))
    }

    var body: some View {
        GeometryReader { proxy in
            DesignSpreadShadowRenderer(
                shape: shape,
                color: color,
                geometry: geometry,
                extent: extent,
                faceSize: proxy.size
            )
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

private struct DesignSpreadShadowRenderer<S: InsettableShape>: UIViewRepresentable {
    let shape: S
    let color: Color
    let geometry: DesignDropShadowGeometry
    let extent: CGFloat
    let faceSize: CGSize

    func makeUIView(context: Context) -> DesignSpreadShadowView {
        DesignSpreadShadowView(
            path: sourcePath,
            color: color,
            geometry: geometry,
            extent: extent,
            faceSize: faceSize
        )
    }

    func updateUIView(_ view: DesignSpreadShadowView, context: Context) {
        view.path = sourcePath
        view.color = color
        view.geometry = geometry
        view.extent = extent
        view.faceSize = faceSize
        view.setNeedsDisplay()
    }

    private var sourcePath: (CGRect) -> CGPath {
        { faceRect in
            shape.inset(by: geometry.sourceInset).path(in: faceRect).cgPath
        }
    }
}

private final class DesignSpreadShadowView: UIView {
    var path: (CGRect) -> CGPath
    var color: Color
    var geometry: DesignDropShadowGeometry
    var extent: CGFloat
    var faceSize: CGSize

    init(
        path: @escaping (CGRect) -> CGPath,
        color: Color,
        geometry: DesignDropShadowGeometry,
        extent: CGFloat,
        faceSize: CGSize
    ) {
        self.path = path
        self.color = color
        self.geometry = geometry
        self.extent = extent
        self.faceSize = faceSize
        super.init(frame: .zero)
        // SwiftUI's allowsHitTesting(false) does not reliably disable the
        // bridged UIKit leaf outside its source frame. Shadows are decorative;
        // make that boundary explicit so their expanded draw fields cannot
        // intercept neighboring controls.
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        contentMode = .redraw
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), bounds.width > 0, bounds.height > 0 else { return }

        let faceRect = CGRect(
            x: extent,
            y: extent,
            width: faceSize.width,
            height: faceSize.height
        )
        let sourcePath = path(faceRect)
        context.saveGState()
        context.setShadow(
            offset: CGSize(width: geometry.x, height: geometry.y),
            blur: geometry.radius,
            color: UIColor(color).cgColor
        )
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(sourcePath)
        context.fillPath()
        context.restoreGState()

        // The source shape is rendered only to seed the shadow. Clear that
        // seed from this transparent view so the face remains owned by the
        // SwiftUI material above it.
        context.saveGState()
        context.setBlendMode(.clear)
        context.addPath(sourcePath)
        context.fillPath()
        context.restoreGState()
    }
}

/// Renders CSS `inset 0 1px 0` from the rounded inner border contour.
///
/// A zero-blur inset shadow is the area of the inner contour that is not
/// covered by that same contour translated by its positive y offset. The
/// even-odd fill preserves the directional corner portions of that
/// difference, rather than approximating the shadow with a rectangular line
/// clipped to the face. Canvas keeps the existing SwiftUI color pipeline for
/// the already-converged shine color.
struct DesignTopEdgeLight<S: InsettableShape>: View {
    let shape: S
    let color: Color

    var body: some View {
        Canvas { context, size in
            let faceRect = CGRect(origin: .zero, size: size)
            let innerPath = shape.inset(by: DesignMetrics.hairline).path(in: faceRect)
            let translatedPath = innerPath.applying(
                CGAffineTransform(translationX: 0, y: DesignMetrics.hairline)
            )
            var difference = innerPath
            difference.addPath(translatedPath)

            context.clip(to: innerPath)
            context.fill(
                difference,
                with: .color(color),
                style: FillStyle(eoFill: true)
            )
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
                if elevated {
                    // Keep the existing float rendering unchanged.
                    shape.stroke(
                        contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                        lineWidth: DesignMetrics.hairline
                    )
                } else {
                    // CSS borders paint inside the border box; the default
                    // plate must not grow a half-stroke beyond its shape.
                    shape.strokeBorder(
                        contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                        lineWidth: DesignMetrics.hairline
                    )
                }
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
