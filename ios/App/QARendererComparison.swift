#if DEBUG
import SwiftUI
import UIKit

/// Debug-only renderer experiment. It deliberately does not reuse the current
/// layered button chrome: both candidates paint the same recipe from one path
/// so the catalog compares rendering boundaries rather than art direction.
struct QAIconRendererComparison: View {
    @State private var canvasActive = false
    @State private var coreGraphicsActive = false
    @State private var pressPreview = false
    @State private var motionEpoch = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .top, spacing: Space.xl) {
                rendererColumn(.canvas, isActive: $canvasActive, pressPreview: pressPreview)
                rendererColumn(.coreGraphics, isActive: $coreGraphicsActive, pressPreview: pressPreview)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: Space.sm) {
                stateBadge("Canvas", active: canvasActive)
                stateBadge("Core Graphics", active: coreGraphicsActive)
                Spacer(minLength: 0)
            }

            HStack(spacing: Space.sm) {
                Button(pressPreview ? "Release preview" : "Hold preview") {
                    pressPreview.toggle()
                }
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(pressPreview ? DuskColors.accent : DuskColors.ink2)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
                .accessibilityIdentifier("qa-renderer-press-preview")

                Spacer(minLength: 0)

                Button("Reset") {
                    canvasActive = false
                    coreGraphicsActive = false
                    pressPreview = false
                }
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink2)
                .frame(minWidth: DesignMetrics.minimumTarget, minHeight: DesignMetrics.minimumTarget)
                .contentShape(Rectangle())
                .accessibilityIdentifier("qa-renderer-reset")
            }

            Text("Tap either key. Touch-down collapses its air gap; Hold preview locks that moment for edge inspection. Activation morphs the icon and starts a restrained glow pulse. Reduced Motion keeps the active treatment static.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, Space.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("qa-icon-renderer-comparison")
    }

    private func rendererColumn(
        _ renderer: QAIconRendererKind,
        isActive: Binding<Bool>,
        pressPreview: Bool
    ) -> some View {
        VStack(spacing: Space.sm) {
            QAIconRendererButton(
                renderer: renderer,
                isActive: isActive,
                pressPreview: pressPreview,
                pulseEpoch: motionEpoch,
                onActivate: beginSharedMotionIfNeeded
            )
            .frame(
                width: QAIconChromeGeometry.fieldSize,
                height: QAIconChromeGeometry.fieldSize
            )
            Text(renderer.title)
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            Text(renderer.detail)
                .font(Typo.mono(TypeScale.xs))
                .foregroundStyle(DuskColors.ink4)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }

    private func beginSharedMotionIfNeeded() {
        if !canvasActive && !coreGraphicsActive {
            motionEpoch = Date()
        }
    }

    private func stateBadge(_ title: String, active: Bool) -> some View {
        Text("\(title): \(active ? "active" : "rest")")
            .font(Typo.mono(TypeScale.xs))
            .foregroundStyle(active ? DuskColors.accent : DuskColors.ink3)
    }
}

private enum QAIconRendererKind: String {
    case canvas
    case coreGraphics

    var title: String {
        switch self {
        case .canvas: "Canvas"
        case .coreGraphics: "Core Graphics"
        }
    }

    var detail: String {
        switch self {
        case .canvas: "one GraphicsContext"
        case .coreGraphics: "one scale-aware UIView"
        }
    }

    var accessibilityID: String { "qa-renderer-\(rawValue)-button" }
}

private struct QAIconRendererButton: View {
    let renderer: QAIconRendererKind
    @Binding var isActive: Bool
    let pressPreview: Bool
    let pulseEpoch: Date
    let onActivate: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(
            .animation(minimumInterval: 1 / 30, paused: reduceMotion || !isActive || pressPreview)
        ) { timeline in
            let elapsed = max(0, timeline.date.timeIntervalSince(pulseEpoch))
            let pulse = reduceMotion || !isActive || pressPreview
                ? 1
                : (cos(elapsed * 4.05) + 1) / 2

            Button {
                if !isActive { onActivate() }
                isActive.toggle()
            } label: {
                ZStack {
                    Image(systemName: "plus")
                        .opacity(isActive ? 0 : 1)
                        .rotationEffect(.degrees(isActive ? -70 : 0))
                        .scaleEffect(isActive ? 0.55 : 1)
                        .accessibilityHidden(true)
                    Image(systemName: "checkmark")
                        .opacity(isActive ? 1 : 0)
                        .rotationEffect(.degrees(isActive ? 0 : 55))
                        .scaleEffect(isActive ? 1 : 0.55)
                        .accessibilityHidden(true)
                }
                .font(.system(size: 16, weight: .medium, design: .rounded))
                .frame(width: QAIconChromeGeometry.semanticSize, height: QAIconChromeGeometry.semanticSize)
                .contentShape(Rectangle())
                .animation(
                    reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0.12),
                    value: isActive
                )
                .accessibilityHidden(true)
            }
            .buttonStyle(QAIconRendererButtonStyle(
                renderer: renderer,
                active: isActive,
                pulse: pulse,
                pressPreview: pressPreview
            ))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(renderer.title) renderer icon button")
            .accessibilityValue(
                "\(isActive ? "Active" : "Resting"), \(pressPreview ? "pressed preview" : "released")"
            )
            .accessibilityAddTraits(isActive ? .isSelected : [])
            .accessibilityHint(
                isActive
                    ? "Deactivates the renderer glow and restores the plus icon"
                    : "Activates the renderer glow and checkmark transition"
            )
            .accessibilityIdentifier(renderer.accessibilityID)
        }
    }
}

private struct QAIconRendererButtonStyle: ButtonStyle {
    let renderer: QAIconRendererKind
    let active: Bool
    let pulse: Double
    let pressPreview: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed || pressPreview

        configuration.label
            .foregroundStyle(QAIconChromeVisualState(
                activation: active ? 1 : 0,
                press: pressed ? 1 : 0,
                pulse: pulse,
                increasedContrast: contrast == .increased
            ).foreground)
            .frame(width: QAIconChromeGeometry.semanticSize, height: QAIconChromeGeometry.semanticSize)
            .background {
                QAIconChrome(
                    renderer: renderer,
                    activation: active ? 1 : 0,
                    press: pressed ? 1 : 0,
                    pulse: pulse,
                    increasedContrast: contrast == .increased
                )
                .frame(width: QAIconChromeGeometry.fieldSize, height: QAIconChromeGeometry.fieldSize)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: active
            )
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.07),
                value: pressed
            )
            .contentShape(Rectangle())
    }
}

private enum QAIconChromeGeometry {
    static let semanticSize: CGFloat = DesignMetrics.minimumTarget
    static let faceSize: CGFloat = DesignMetrics.actionButtonVisualHeight
    static let fieldSize: CGFloat = 96
    static let cornerRadius: CGFloat = DesignMetrics.actionButtonCornerRadius
    static let activeOrbitInset: CGFloat = -2.5

    static func faceRect(in size: CGSize) -> CGRect {
        CGRect(
            x: (size.width - faceSize) / 2,
            y: (size.height - faceSize) / 2,
            width: faceSize,
            height: faceSize
        )
    }

    static func path(in rect: CGRect, inset: CGFloat = 0) -> Path {
        Path(cgPath(in: rect, inset: inset))
    }

    static func cgPath(in rect: CGRect, inset: CGFloat = 0) -> CGPath {
        let insetRect = rect.insetBy(dx: inset, dy: inset)
        let radius = max(0, cornerRadius - inset)
        return UIBezierPath(roundedRect: insetRect, cornerRadius: radius).cgPath
    }
}

private struct QAIconChromeVisualState {
    let activation: CGFloat
    let press: CGFloat
    let pulse: Double
    let increasedContrast: Bool

    private var active: CGFloat { activation.clamped(to: 0...1) }
    private var down: CGFloat { press.clamped(to: 0...1) }

    private var restBase: Color {
        DuskColors.paper.overlaying(DuskColors.ink2, opacity: DesignMaterialAdapter.slateSecondaryInkMix)
    }

    private var baseBeforePress: Color {
        restBase.mix(with: DuskColors.accent, by: Double(active), in: .perceptual)
    }

    var base: Color { baseBeforePress }

    var linearTop: Color {
        base.overlaying(DuskColors.ink, opacity: 0.04)
    }

    var linearBottom: Color { base }

    var radialCenter: Color {
        base.overlaying(DuskColors.bgSunk, opacity: 0.20)
    }

    var radialRing: Color {
        base.overlaying(DuskColors.bgSunk, opacity: 0.12)
    }

    var border: Color {
        if increasedContrast { return DuskColors.ink3 }
        let activeBorder = DuskColors.accent.overlaying(
            DuskColors.bgSunk,
            opacity: 1 - DesignMaterialAdapter.slateActionBorder
        )
        return DuskColors.line.mix(with: activeBorder, by: Double(active), in: .perceptual)
    }

    var foreground: Color {
        DuskColors.ink.mix(with: DuskColors.bgSunk, by: Double(active), in: .perceptual)
    }

    var topLight: Color {
        let rest = DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightRest)
        let selected = Color.white.opacity(DesignMaterialAdapter.slateActionTopLight)
        return rest
            .mix(with: selected, by: Double(active), in: .perceptual)
            .opacity(Double(1 - down))
    }

    var pressedOcclusion: Color {
        DuskColors.bgSunk.opacity(0.42 * Double(down))
    }

    var activeOrbit: Color {
        DuskColors.accent.opacity(
            Double(active * (1 - down)) * (0.14 + pulse * 0.08)
        )
    }

    var contact: Color {
        let rest = DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.12)
        let selected = DuskColors.bgSunk.overlaying(DuskColors.accent, opacity: 0.22)
        let up = rest.mix(with: selected, by: Double(active), in: .perceptual)
        let pressed = DuskColors.bgSunk.overlaying(DuskColors.line, opacity: 0.10)
        return up.mix(with: pressed, by: Double(down), in: .perceptual)
    }

    var blackCast: Color {
        Color.black.opacity(
            Double.lerp(
                0.90 + 0.02 * Double(active),
                0.88,
                by: Double(down)
            )
        )
    }

    var blackCastGeometry: DesignDropShadowGeometry {
        DesignDropShadowGeometry(
            radius: CGFloat.lerp(DesignMaterialAdapter.slateCastBlur, 6, by: down),
            y: CGFloat.lerp(DesignMaterialAdapter.slateCastY, 3, by: down),
            sourceInset: CGFloat.lerp(DesignMaterialAdapter.slateCastInset, 5, by: down)
        )
    }

    var glow: Color {
        let baseOpacity = Double.lerp(
            DesignMaterialAdapter.slateDefaultGlow,
            DesignMaterialAdapter.slateActionGlow,
            by: Double(active)
        )
        let activeBreathing = 0.88 + (pulse * 0.12)
        let breathing = 1 + (Double(active) * (activeBreathing - 1))
        return DuskColors.accent.opacity(baseOpacity * breathing * Double(1 - down))
    }

    var glowGeometry: DesignDropShadowGeometry {
        DesignDropShadowGeometry(
            radius: CGFloat.lerp(
                DesignMaterialAdapter.slateEmberBlur,
                22,
                by: active
            ),
            y: CGFloat.lerp(
                DesignMaterialAdapter.slateEmberY,
                13,
                by: active
            ),
            sourceInset: CGFloat.lerp(
                DesignMaterialAdapter.slateEmberInset,
                13,
                by: active
            )
        )
    }

    var contactY: CGFloat { CGFloat.lerp(2, 1, by: down) }
}

private struct QAIconChrome: View, Animatable {
    let renderer: QAIconRendererKind
    var activation: CGFloat
    var press: CGFloat
    let pulse: Double
    let increasedContrast: Bool

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(activation, press) }
        set {
            activation = newValue.first
            press = newValue.second
        }
    }

    var body: some View {
        let state = QAIconChromeVisualState(
            activation: activation,
            press: press,
            pulse: pulse,
            increasedContrast: increasedContrast
        )

        Group {
            switch renderer {
            case .canvas:
                QACanvasIconChrome(state: state)
            case .coreGraphics:
                QACoreGraphicsIconChrome(state: state)
            }
        }
    }
}

private struct QACanvasIconChrome: View {
    let state: QAIconChromeVisualState

    var body: some View {
        Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, size in
            let faceRect = QAIconChromeGeometry.faceRect(in: size)
            let facePath = QAIconChromeGeometry.path(in: faceRect)

            drawShadow(
                in: &context,
                faceRect: faceRect,
                color: state.glow,
                geometry: state.glowGeometry
            )
            drawShadow(
                in: &context,
                faceRect: faceRect,
                color: state.blackCast,
                geometry: state.blackCastGeometry
            )
            drawShadow(
                in: &context,
                faceRect: faceRect,
                color: state.contact,
                geometry: DesignDropShadowGeometry(radius: 0, y: state.contactY, sourceInset: 1)
            )

            context.fill(
                facePath,
                with: .linearGradient(
                    Gradient(colors: [state.linearTop, state.linearBottom]),
                    startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
                    endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
                )
            )
            drawEllipticalRadial(in: &context, faceRect: faceRect, facePath: facePath)

            let borderPath = QAIconChromeGeometry.path(in: faceRect, inset: DesignMetrics.hairline / 2)
            context.stroke(
                borderPath,
                with: .color(state.border),
                lineWidth: DesignMetrics.hairline
            )

            drawTopLight(in: &context, faceRect: faceRect)
            drawPressedInset(in: &context, faceRect: faceRect, facePath: facePath)
            drawActiveOrbit(in: &context, faceRect: faceRect)
        }
    }

    private func drawShadow(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        color: Color,
        geometry: DesignDropShadowGeometry
    ) {
        var shadow = context
        shadow.addFilter(.shadow(
            color: color,
            radius: geometry.radius,
            x: geometry.x,
            y: geometry.y,
            options: [.shadowOnly]
        ))
        shadow.fill(
            QAIconChromeGeometry.path(in: faceRect, inset: geometry.sourceInset),
            with: .color(.white)
        )
    }

    private func drawEllipticalRadial(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
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
        radial.translateBy(x: center.x, y: center.y)
        radial.scaleBy(x: radius.width, y: radius.height)
        radial.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: [
                    .init(color: state.radialCenter, location: 0),
                    .init(color: state.radialRing, location: DesignMaterialAdapter.slateCenterStop),
                    .init(color: state.radialRing.opacity(0), location: DesignMaterialAdapter.slateFadeStop),
                ]),
                center: .zero,
                startRadius: 0,
                endRadius: 1
            )
        )
    }

    private func drawTopLight(
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let inner = QAIconChromeGeometry.path(in: faceRect, inset: DesignMetrics.hairline)
        var translated = Path()
        translated.addPath(
            inner,
            transform: CGAffineTransform(translationX: 0, y: DesignMetrics.hairline)
        )
        var difference = Path()
        difference.addPath(inner)
        difference.addPath(translated)

        var highlight = context
        // Clipping to the inner contour removes the opposite lower rim from
        // the even-odd difference, leaving only CSS `inset 0 1px 0` light.
        highlight.clip(to: inner)
        highlight.fill(
            difference,
            with: .color(state.topLight),
            style: FillStyle(eoFill: true)
        )
    }

    private func drawPressedInset(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        facePath: Path
    ) {
        var inset = context
        inset.addFilter(.shadow(
            color: state.pressedOcclusion,
            radius: 3,
            x: 0,
            y: 2,
            blendMode: .sourceAtop,
            options: [.invertsAlpha, .shadowAbove, .shadowOnly]
        ))
        inset.fill(facePath, with: .color(.white))
    }

    private func drawActiveOrbit(
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.stroke(
            QAIconChromeGeometry.path(
                in: faceRect,
                inset: QAIconChromeGeometry.activeOrbitInset
            ),
            with: .color(state.activeOrbit),
            lineWidth: DesignMetrics.hairline
        )
    }
}

private struct QACoreGraphicsIconChrome: UIViewRepresentable {
    let state: QAIconChromeVisualState

    func makeUIView(context: Context) -> QACoreGraphicsIconChromeView {
        QACoreGraphicsIconChromeView()
    }

    func updateUIView(_ view: QACoreGraphicsIconChromeView, context: Context) {
        view.state = state
        view.setNeedsDisplay()
    }
}

private final class QACoreGraphicsIconChromeView: UIView {
    var state = QAIconChromeVisualState(
        activation: 0,
        press: 0,
        pulse: 0.5,
        increasedContrast: false
    )

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
        backgroundColor = .clear
        contentMode = .redraw
        registerForTraitChanges([UITraitDisplayScale.self]) {
            (view: QACoreGraphicsIconChromeView, _: UITraitCollection) in
            view.syncDisplayScale()
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        syncDisplayScale()
    }

    private func syncDisplayScale() {
        contentScaleFactor = traitCollection.displayScale
        layer.contentsScale = traitCollection.displayScale
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext(), bounds.width > 0, bounds.height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
        else { return }

        context.setAllowsAntialiasing(true)
        context.setShouldAntialias(true)
        let faceRect = QAIconChromeGeometry.faceRect(in: bounds.size)
        let facePath = QAIconChromeGeometry.cgPath(in: faceRect)

        drawShadow(context, faceRect: faceRect, color: state.glow, geometry: state.glowGeometry)
        drawShadow(context, faceRect: faceRect, color: state.blackCast, geometry: state.blackCastGeometry)
        drawShadow(
            context,
            faceRect: faceRect,
            color: state.contact,
            geometry: DesignDropShadowGeometry(radius: 0, y: state.contactY, sourceInset: 1)
        )

        context.saveGState()
        context.addPath(facePath)
        context.clip()
        drawLinearFace(context, colorSpace: colorSpace, faceRect: faceRect)
        drawRadialFace(context, colorSpace: colorSpace, faceRect: faceRect)
        context.restoreGState()

        context.saveGState()
        context.setStrokeColor(resolved(state.border).cgColor)
        context.setLineWidth(DesignMetrics.hairline)
        context.addPath(QAIconChromeGeometry.cgPath(
            in: faceRect,
            inset: DesignMetrics.hairline / 2
        ))
        context.strokePath()
        context.restoreGState()

        drawTopLight(context, faceRect: faceRect)
        drawPressedInset(context, faceRect: faceRect, facePath: facePath)
        drawActiveOrbit(context, faceRect: faceRect)
    }

    private func drawShadow(
        _ context: CGContext,
        faceRect: CGRect,
        color: Color,
        geometry: DesignDropShadowGeometry
    ) {
        context.saveGState()
        context.setShadow(
            offset: CGSize(width: geometry.x, height: geometry.y),
            blur: geometry.radius,
            color: resolved(color).cgColor
        )
        // The opaque seed remains inside the face and is covered by the face
        // pass below, leaving only the requested shadow in the transparent field.
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(QAIconChromeGeometry.cgPath(in: faceRect, inset: geometry.sourceInset))
        context.fillPath()
        context.restoreGState()
    }

    private func drawLinearFace(
        _ context: CGContext,
        colorSpace: CGColorSpace,
        faceRect: CGRect
    ) {
        guard let gradient = CGGradient(
            colorsSpace: colorSpace,
            colors: [resolved(state.linearTop).cgColor, resolved(state.linearBottom).cgColor] as CFArray,
            locations: [0, 1]
        ) else { return }
        context.drawLinearGradient(
            gradient,
            start: CGPoint(x: faceRect.midX, y: faceRect.minY),
            end: CGPoint(x: faceRect.midX, y: faceRect.maxY),
            options: []
        )
    }

    private func drawRadialFace(
        _ context: CGContext,
        colorSpace: CGColorSpace,
        faceRect: CGRect
    ) {
        guard let gradient = CGGradient(
            colorsSpace: colorSpace,
            colors: [
                resolved(state.radialCenter).cgColor,
                resolved(state.radialRing).cgColor,
                resolved(state.radialRing).withAlphaComponent(0).cgColor,
            ] as CFArray,
            locations: [
                0,
                DesignMaterialAdapter.slateCenterStop,
                DesignMaterialAdapter.slateFadeStop,
            ]
        ) else { return }

        let center = CGPoint(
            x: faceRect.minX + faceRect.width * DesignMaterialAdapter.slateRadialCenterX,
            y: faceRect.minY + faceRect.height * DesignMaterialAdapter.slateRadialCenterY
        )
        let radius = CGSize(
            width: faceRect.width * DesignMaterialAdapter.slateRadialScale.width,
            height: faceRect.height * DesignMaterialAdapter.slateRadialScale.height
        )
        guard radius.width > 0, radius.height > 0 else { return }

        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.scaleBy(x: radius.width, y: radius.height)
        context.drawRadialGradient(
            gradient,
            startCenter: .zero,
            startRadius: 0,
            endCenter: .zero,
            endRadius: 1,
            options: []
        )
        context.restoreGState()
    }

    private func drawTopLight(
        _ context: CGContext,
        faceRect: CGRect
    ) {
        let inner = QAIconChromeGeometry.cgPath(in: faceRect, inset: DesignMetrics.hairline)
        var translation = CGAffineTransform(translationX: 0, y: DesignMetrics.hairline)
        guard let translated = inner.copy(using: &translation) else { return }

        context.saveGState()
        context.addPath(inner)
        context.clip()
        context.setFillColor(resolved(state.topLight).cgColor)
        context.addPath(inner)
        context.addPath(translated)
        context.drawPath(using: .eoFill)
        context.restoreGState()
    }

    private func drawPressedInset(
        _ context: CGContext,
        faceRect: CGRect,
        facePath: CGPath
    ) {
        let exterior = CGMutablePath()
        exterior.addRect(faceRect.insetBy(dx: -12, dy: -12))
        exterior.addPath(facePath)

        context.saveGState()
        context.addPath(facePath)
        context.clip()
        context.setShadow(
            offset: CGSize(width: 0, height: 2),
            blur: 3,
            color: resolved(state.pressedOcclusion).cgColor
        )
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(exterior)
        context.drawPath(using: .eoFill)
        context.restoreGState()
    }

    private func drawActiveOrbit(
        _ context: CGContext,
        faceRect: CGRect
    ) {
        context.saveGState()
        context.setStrokeColor(resolved(state.activeOrbit).cgColor)
        context.setLineWidth(DesignMetrics.hairline)
        context.addPath(QAIconChromeGeometry.cgPath(
            in: faceRect,
            inset: QAIconChromeGeometry.activeOrbitInset
        ))
        context.strokePath()
        context.restoreGState()
    }

    private func resolved(_ color: Color) -> UIColor {
        UIColor(color).resolvedColor(with: traitCollection)
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

private extension CGFloat {
    static func lerp(_ from: CGFloat, _ to: CGFloat, by amount: CGFloat) -> CGFloat {
        from + ((to - from) * amount)
    }
}

private extension Double {
    static func lerp(_ from: Double, _ to: Double, by amount: Double) -> Double {
        from + ((to - from) * amount)
    }
}
#endif
