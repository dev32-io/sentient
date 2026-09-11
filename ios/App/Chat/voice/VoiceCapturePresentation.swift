import SwiftUI

/// The visual shell for the capture control. It composes presentation leaves
/// while `VoiceCaptureControl` supplies semantic actions and gesture handling.
struct VoiceCaptureSurface: View {
    let state: VoiceCaptureState
    let target: VoiceCaptureTarget
    let levels: [Float]
    let disabled: Bool
    let physicallyPressed: Bool
    let announcement: String
    let captureGesture: VoiceCaptureGesture
    let onActivate: () -> Void
    let onStartAccessibleHold: () -> Void
    let onTarget: (VoiceCaptureTarget) -> Void

    @ComposerReduceMotion private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.layoutDirection) private var layoutDirection

    private var presentation: VoiceCapturePresentationState {
        VoiceCapturePresentationState(state: state, disabled: disabled)
    }

    private var idleSize: CGFloat {
        VoiceCaptureLayout.idleSize(horizontalSizeClass: horizontalSizeClass)
    }

    private var liveWidth: CGFloat {
        VoiceCaptureLayout.liveWidth(
            horizontalSizeClass: horizontalSizeClass,
            dynamicTypeSize: dynamicTypeSize
        )
    }

    private var liveHeight: CGFloat {
        VoiceCaptureLayout.liveHeight(horizontalSizeClass: horizontalSizeClass)
    }

    private var crownWidth: CGFloat {
        VoiceCaptureLayout.crownWidth(
            horizontalSizeClass: horizontalSizeClass,
            dynamicTypeSize: dynamicTypeSize
        )
    }

    private var gestureHostGeometry: VoiceCaptureGestureHostGeometry {
        VoiceCaptureGestureHostGeometry(
            idleSize: idleSize,
            podSize: CGSize(width: liveWidth, height: liveHeight),
            crownSize: CGSize(
                width: crownWidth,
                height: VoiceCaptureLayout.crownHeight(dynamicTypeSize)
            ),
            seamOverlap: VoiceCaptureLayout.seamOverlap,
            rightToLeft: layoutDirection == .rightToLeft
        )
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            ZStack(alignment: .bottomTrailing) {
                if presentation.showsTargetDeck {
                    VoiceCaptureTargetDeck(
                        selected: target,
                        width: crownWidth,
                        onSelect: onTarget
                    )
                    .offset(y: gestureHostGeometry.crownBottomAlignmentOffset)
                    .zIndex(0)
                    .transition(
                        reduceMotion
                            ? .identity
                            : .opacity
                                .combined(with: .move(edge: .bottom))
                                .combined(with: .scale(scale: 0.88, anchor: .bottom))
                    )
                }

                VoiceCapturePrimaryButton(
                    presentation: presentation,
                    levels: levels,
                    width: presentation.isExpanded ? liveWidth : idleSize,
                    height: presentation.isExpanded ? liveHeight : idleSize,
                    physicallyPressed: physicallyPressed,
                    onActivate: onActivate,
                    onStartAccessibleHold: onStartAccessibleHold,
                    onTarget: onTarget
                )
                .zIndex(1)
            }
            .frame(
                width: presentation.isExpanded ? liveWidth : idleSize,
                height: presentation.isExpanded ? liveHeight : idleSize,
                alignment: .bottomTrailing
            )
            .overlay(alignment: .bottomTrailing) {
                VoiceCaptureGestureHost(
                    geometry: gestureHostGeometry,
                    disabled: presentation.isDisabled,
                    gesture: captureGesture
                )
                .frame(
                    width: presentation.isAuto ? liveWidth : gestureHostGeometry.hostSize.width,
                    height: presentation.isAuto ? liveHeight : gestureHostGeometry.hostSize.height
                )
                // SwiftUI expands interaction shapes beyond their layout
                // bounds. Counter that platform touch slop here; the hosted
                // UIKit view still enforces its exact visible bounds and owns
                // a gesture continuously after it begins.
                .contentShape(
                    .interaction,
                    Rectangle().inset(by: VoiceCaptureLayout.interactionShapeInset)
                )
                .zIndex(2)
            }

            if presentation.showsFailureNotice {
                VoiceCaptureFailureNotice(message: presentation.failureMessage)
            }
        }
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: state
        )
        .accessibilityElement(children: .contain)
        .accessibilityValue(announcement)
    }
}

private struct VoiceCapturePrimaryButton: View {
    let presentation: VoiceCapturePresentationState
    let levels: [Float]
    let width: CGFloat
    let height: CGFloat
    let physicallyPressed: Bool
    let onActivate: () -> Void
    let onStartAccessibleHold: () -> Void
    let onTarget: (VoiceCaptureTarget) -> Void

    var body: some View {
        ZStack {
            PttBigWave(
                levels: levels,
                tint: presentation.isAuto ? DuskColors.sage : DuskColors.accent,
                isActive: presentation.showsWaveform
            )
            .frame(height: VoiceCaptureLayout.waveformHeight)
            .padding(.leading, VoiceCaptureLayout.waveformLeadingInset)
            .padding(.trailing, VoiceCaptureLayout.glyphWellWidth)
            .opacity(presentation.showsWaveform ? 1 : 0)
            .scaleEffect(
                x: presentation.showsWaveform ? 1 : 0.25,
                y: 1,
                anchor: .trailing
            )
            .accessibilityHidden(true)

            captureGlyph
                .frame(maxWidth: .infinity, alignment: presentation.isExpanded ? .trailing : .center)
                .padding(.trailing, presentation.isExpanded ? VoiceCaptureLayout.glyphTrailingInset : 0)
        }
        .frame(width: width, height: height)
        .modifier(VoicePodSurfaceModifier(
            presentation: presentation,
            width: width,
            height: height,
            physicallyPressed: physicallyPressed
        ))
        .disabled(presentation.isDisabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.primaryLabel)
        .accessibilityHint(presentation.primaryHint)
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(presentation.isAuto ? .isSelected : [])
        .accessibilityAction { onActivate() }
        .voiceCaptureAccessibilityActions(
            presentation: presentation,
            onStartHold: onStartAccessibleHold,
            onTarget: onTarget
        )
        .accessibilityIdentifier("chat-mic")
    }

    private var captureGlyph: some View {
        ZStack {
            ComposerGlyphView(.microphone)
                .frame(width: 20, height: 20)
                .opacity(presentation.isExpanded ? 0 : 1)
                .rotationEffect(.degrees(presentation.isExpanded ? -70 : 0))
                .scaleEffect(presentation.isExpanded ? 0.28 : 1)

            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(DuskColors.accent)
                .frame(width: 11, height: 11)
                .rotationEffect(.degrees(presentation.isHolding ? 45 : 0))
                .scaleEffect(presentation.isHolding ? 1 : 0.4)
                .opacity(presentation.isHolding ? 1 : 0)
                .shadow(
                    color: DuskColors.accent.opacity(presentation.isHolding ? 0.56 : 0),
                    radius: 7
                )
                .overlay {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .stroke(
                            DuskColors.accent.opacity(presentation.isHolding ? 0.2 : 0),
                            lineWidth: 5
                        )
                        .rotationEffect(.degrees(45))
                }

            ComposerGlyphView(.auto)
                .frame(width: 20, height: 20)
                .opacity(presentation.isAuto ? 1 : 0)
                .scaleEffect(presentation.isAuto ? 1 : 0.4)
        }
        .frame(width: 22, height: 22)
    }
}

private struct VoiceCaptureTargetDeck: View {
    let selected: VoiceCaptureTarget
    let width: CGFloat
    let onSelect: (VoiceCaptureTarget) -> Void

    @ComposerReduceMotion private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.layoutDirection) private var layoutDirection

    private let choices: [VoiceCaptureTarget] = [.auto, .cancel, .send]

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            VoiceCrownSpineCanvas()

            HStack(spacing: 0) {
                ForEach(choices, id: \.self) { choice in
                    targetButton(choice)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            GeometryReader { proxy in
                let segment = proxy.size.width / CGFloat(choices.count)
                VoiceCrownSelectionSeam(color: selectionColor)
                    .frame(width: max(24, segment - 16), height: 3)
                    .offset(
                        x: CGFloat(selectedVisualIndex) * segment + 8,
                        y: proxy.size.height - 4
                    )
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .frame(width: width, height: VoiceCaptureLayout.crownHeight(dynamicTypeSize))
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.feedback, bounce: 0),
            value: selected
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voice capture actions")
    }

    private func targetButton(_ choice: VoiceCaptureTarget) -> some View {
        Button {
            onSelect(choice)
        } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 2) {
                        targetIcon(choice)
                        Text(choice.rawValue.capitalized)
                    }
                } else {
                    HStack(spacing: 4) {
                        targetIcon(choice)
                        Text(choice.rawValue.capitalized)
                    }
                }
            }
            .font(Typo.ui(TypeScale.sm, .regular))
            .lineLimit(1)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.bottom, 7)
        }
        .buttonStyle(VoiceTargetButtonStyle(choice: choice, selected: selected == choice))
        .accessibilityLabel(targetLabel(choice))
        .accessibilityAddTraits(selected == choice ? .isSelected : [])
        .accessibilityIdentifier("voice-\(choice.rawValue)")
    }

    @ViewBuilder
    private func targetIcon(_ choice: VoiceCaptureTarget) -> some View {
        ComposerGlyphView(
            choice == .auto ? .auto : choice == .cancel ? .cancel : .send
        )
        .frame(width: 15, height: 15)
    }

    private func targetLabel(_ choice: VoiceCaptureTarget) -> String {
        switch choice {
        case .auto: "Switch to Auto listening"
        case .cancel: "Cancel voice message"
        case .send: "Send voice message"
        }
    }

    private var selectedVisualIndex: Int {
        let logicalIndex = choices.firstIndex(of: selected) ?? choices.count - 1
        return layoutDirection == .rightToLeft
            ? choices.count - 1 - logicalIndex
            : logicalIndex
    }

    private var selectionColor: Color {
        switch selected {
        case .auto: DuskColors.sage
        case .cancel: DuskColors.stop
        case .send: DuskColors.accent
        }
    }
}

private struct VoiceCaptureFailureNotice: View {
    let message: String

    var body: some View {
        Text(message)
            .font(Typo.ui(TypeScale.sm, .medium))
            .foregroundStyle(DuskColors.stop)
            .multilineTextAlignment(.trailing)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: VoiceCaptureLayout.failureNoticeWidth, alignment: .trailing)
            .accessibilityIdentifier("mic-denied-notice")
    }
}

// MARK: - Purpose-built voice material

enum VoicePodPressBehavior {
    static func appliesPressedDepth(
        presentation: VoiceCapturePresentationState,
        pressed: Bool
    ) -> Bool {
        pressed && !presentation.isExpanded
    }
}

enum VoiceCaptureLayout {
    static let compactIdleSize: CGFloat = 48
    static let regularIdleSize: CGFloat = 44
    static let compactLiveWidth: CGFloat = 198
    static let regularLiveWidth: CGFloat = 238
    static let accessibilityLiveWidth: CGFloat = 276
    static let compactCrownWidth: CGFloat = 210
    static let compactLiveHeight: CGFloat = 52
    static let regularLiveHeight: CGFloat = 54
    static let standardCrownHeight: CGFloat = 58
    static let accessibilityCrownHeight: CGFloat = 72
    static let seamOverlap: CGFloat = 8
    static let interactionShapeInset: CGFloat = 12
    static let waveformHeight: CGFloat = 30
    static let waveformLeadingInset: CGFloat = 15
    static let glyphWellWidth: CGFloat = 52
    static let glyphTrailingInset: CGFloat = 17
    static let failureNoticeWidth: CGFloat = 240

    static let podShadow = DesignDropShadowGeometry(
        radius: 20, y: 13, sourceInset: 13
    )
    static let podGlow = DesignDropShadowGeometry(
        radius: 22, y: 13, sourceInset: 12
    )

    static func idleSize(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularIdleSize : compactIdleSize
    }

    static func liveWidth(
        horizontalSizeClass: UserInterfaceSizeClass?,
        dynamicTypeSize: DynamicTypeSize
    ) -> CGFloat {
        if dynamicTypeSize.isAccessibilitySize { return accessibilityLiveWidth }
        return horizontalSizeClass == .regular ? regularLiveWidth : compactLiveWidth
    }

    static func liveHeight(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularLiveHeight : compactLiveHeight
    }

    static func crownWidth(
        horizontalSizeClass: UserInterfaceSizeClass?,
        dynamicTypeSize: DynamicTypeSize
    ) -> CGFloat {
        if dynamicTypeSize.isAccessibilitySize { return accessibilityLiveWidth }
        return horizontalSizeClass == .regular ? regularLiveWidth : compactCrownWidth
    }

    static func crownHeight(_ dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        dynamicTypeSize.isAccessibilitySize ? accessibilityCrownHeight : standardCrownHeight
    }

    static func podShape(
        expanded: Bool,
        layoutDirection: LayoutDirection
    ) -> UnevenRoundedRectangle {
        podShape(expansion: expanded ? 1 : 0, layoutDirection: layoutDirection)
    }

    static func podShape(
        expansion: CGFloat,
        layoutDirection: LayoutDirection
    ) -> UnevenRoundedRectangle {
        let amount = min(max(expansion, 0), 1)
        let leading = 14 + 3 * amount
        let trailing = 14 - 4 * amount
        return UnevenRoundedRectangle(
            topLeadingRadius: layoutDirection == .leftToRight ? leading : trailing,
            bottomLeadingRadius: layoutDirection == .leftToRight ? leading : trailing,
            bottomTrailingRadius: layoutDirection == .leftToRight ? trailing : leading,
            topTrailingRadius: layoutDirection == .leftToRight ? trailing : leading,
            style: .continuous
        )
    }

    static func targetShape(
        choice: VoiceCaptureTarget,
        selected: CGFloat,
        layoutDirection: LayoutDirection
    ) -> UnevenRoundedRectangle {
        let outer = 14 + 5 * min(max(selected, 0), 1)
        let inner: CGFloat = 8
        switch choice {
        case .auto:
            return UnevenRoundedRectangle(
                topLeadingRadius: layoutDirection == .leftToRight ? outer : 11,
                bottomLeadingRadius: layoutDirection == .leftToRight ? 16 : inner,
                bottomTrailingRadius: layoutDirection == .leftToRight ? inner : 16,
                topTrailingRadius: layoutDirection == .leftToRight ? 11 : outer,
                style: .continuous
            )
        case .cancel:
            return UnevenRoundedRectangle(
                topLeadingRadius: 14,
                bottomLeadingRadius: inner,
                bottomTrailingRadius: inner,
                topTrailingRadius: 14,
                style: .continuous
            )
        case .send:
            return UnevenRoundedRectangle(
                topLeadingRadius: layoutDirection == .leftToRight ? 11 : outer,
                bottomLeadingRadius: layoutDirection == .leftToRight ? inner : 16,
                bottomTrailingRadius: layoutDirection == .leftToRight ? 16 : inner,
                topTrailingRadius: layoutDirection == .leftToRight ? outer : 11,
                style: .continuous
            )
        }
    }
}

private struct VoicePodSurfaceModifier: ViewModifier {
    let presentation: VoiceCapturePresentationState
    let width: CGFloat
    let height: CGFloat
    let physicallyPressed: Bool

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.layoutDirection) private var layoutDirection

    private var shape: UnevenRoundedRectangle {
        VoiceCaptureLayout.podShape(
            expanded: presentation.isExpanded,
            layoutDirection: layoutDirection
        )
    }

    func body(content: Content) -> some View {
        let pressed = VoicePodPressBehavior.appliesPressedDepth(
            presentation: presentation,
            pressed: physicallyPressed
        )

        content
            .foregroundStyle(foregroundColor)
            .frame(width: width, height: height)
            .background { podFace(pressed: pressed) }
            .overlay {
                if presentation.isAuto {
                    VoiceAutoOrbit(shape: shape)
                        .padding(-5)
                }
            }
            .offset(y: pressed && !reduceMotion ? 1 : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: pressed
            )
    }

    private var foregroundColor: Color {
        if !isEnabled { return DuskColors.ink4 }
        return presentation.isAuto ? DuskColors.bgSunk : DuskColors.ink
    }

    private func podFace(pressed: Bool) -> some View {
        VoicePodCanvas(
            presentation: presentation,
            enabled: isEnabled,
            pressed: pressed,
            focused: isFocused,
            increasedContrast: contrast == .increased,
            layoutDirection: layoutDirection
        )
    }
}

private struct VoiceTargetButtonStyle: ButtonStyle {
    let choice: VoiceCaptureTarget
    let selected: Bool

    @Environment(\.isFocused) private var isFocused
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.layoutDirection) private var layoutDirection

    private var shape: UnevenRoundedRectangle {
        VoiceCaptureLayout.targetShape(
            choice: choice,
            selected: selected ? 1 : 0,
            layoutDirection: layoutDirection
        )
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(selected ? selectedForeground : DuskColors.ink2)
            .background {
                VoiceTargetFacetCanvas(
                    choice: choice,
                    selected: selected,
                    pressed: configuration.isPressed,
                    focused: isFocused,
                    increasedContrast: contrast == .increased,
                    layoutDirection: layoutDirection
                )
            }
            .contentShape(shape)
            .offset(y: selected && !configuration.isPressed ? -5 : configuration.isPressed && !reduceMotion ? 1 : 0)
            .scaleEffect(selected && !configuration.isPressed ? 1.015 : 1)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
    }

    private var selectedForeground: Color {
        choice == .cancel ? DuskColors.ink : DuskColors.bgSunk
    }
}

private enum VoiceCanvasDrawing {
    static func shadow<S: InsettableShape>(
        shape: S,
        color: Color,
        geometry: DesignDropShadowGeometry,
        in context: inout GraphicsContext,
        faceRect: CGRect,
        blur: CGFloat? = nil
    ) {
        guard faceRect.width - 2 * geometry.sourceInset > 0,
              faceRect.height - 2 * geometry.sourceInset > 0 else { return }
        let source = shape.inset(by: geometry.sourceInset).path(in: faceRect)
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: color,
            blur: blur ?? geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    static func slateFace(
        path: Path,
        base: Color,
        muted: Bool = false,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.fill(path, with: .linearGradient(
            Gradient(colors: [
                base.overlaying(
                    muted ? DuskColors.ink4 : DuskColors.ink,
                    opacity: muted
                        ? DesignMaterialAdapter.slateMutedBaseLight
                        : DesignMaterialAdapter.slateBaseLight
                ),
                base,
            ]),
            startPoint: CGPoint(x: faceRect.midX, y: faceRect.minY),
            endPoint: CGPoint(x: faceRect.midX, y: faceRect.maxY)
        ))

        let center = base.overlaying(
            DuskColors.bgSunk,
            opacity: muted
                ? DesignMaterialAdapter.slateMutedCenterSunk
                : DesignMaterialAdapter.slateCenterSunk
        )
        let stops: [Gradient.Stop]
        if muted {
            stops = [
                .init(color: center, location: 0),
                .init(color: center.opacity(0), location: DesignMaterialAdapter.slateMutedFadeStop),
            ]
        } else {
            let ring = base.overlaying(
                DuskColors.bgSunk,
                opacity: DesignMaterialAdapter.slateRingSunk
            )
            stops = [
                .init(color: center, location: 0),
                .init(color: ring, location: DesignMaterialAdapter.slateCenterStop),
                .init(color: ring.opacity(0), location: DesignMaterialAdapter.slateFadeStop),
            ]
        }
        ellipticalRadial(
            clippingTo: path,
            center: CGPoint(
                x: DesignMaterialAdapter.slateRadialCenterX,
                y: DesignMaterialAdapter.slateRadialCenterY
            ),
            radiusScale: DesignMaterialAdapter.slateRadialScale,
            stops: stops,
            in: &context,
            faceRect: faceRect
        )
    }

    static func facetFace(
        path: Path,
        base: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.fill(path, with: .color(base))
        ellipticalRadial(
            clippingTo: path,
            center: CGPoint(x: 0.5, y: 0.58),
            radiusScale: CGSize(width: 0.9, height: 1.18),
            stops: [
                .init(
                    color: base.overlaying(DuskColors.bgSunk, opacity: 0.26),
                    location: 0
                ),
                .init(color: base, location: 1),
            ],
            in: &context,
            faceRect: faceRect
        )
    }

    static func holdFace(
        path: Path,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.fill(path, with: .linearGradient(
            Gradient(colors: [
                DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.12),
                DuskColors.paper.overlaying(DuskColors.accent, opacity: 0.12),
            ]),
            startPoint: CGPoint(x: faceRect.minX, y: faceRect.minY + faceRect.height * 0.36),
            endPoint: CGPoint(x: faceRect.maxX, y: faceRect.minY + faceRect.height * 0.64)
        ))

        let center = DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.32)
        ellipticalRadial(
            clippingTo: path,
            center: CGPoint(x: 0.46, y: 0.54),
            radiusScale: CGSize(width: 0.70, height: 1.20),
            stops: [
                .init(color: center, location: 0),
                .init(color: center.opacity(0), location: 0.72),
            ],
            in: &context,
            faceRect: faceRect
        )
    }

    static func topEdge<S: InsettableShape>(
        shape: S,
        color: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let inner = shape.inset(by: DesignMetrics.hairline).path(in: faceRect)
        let translated = inner.applying(CGAffineTransform(
            translationX: 0,
            y: DesignMetrics.hairline
        ))
        var difference = inner
        difference.addPath(translated)

        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
    }

    static func pressedOcclusion(
        path: Path,
        amount: CGFloat,
        in context: inout GraphicsContext
    ) {
        guard amount > 0 else { return }
        DesignCanvasEffects.insetShadow(
            in: &context,
            facePath: path,
            sourcePath: path,
            color: DuskColors.bgSunk.opacity(0.42 * Double(amount)),
            blur: 3,
            y: 2
        )
    }

    static func ellipticalRadial(
        clippingTo path: Path,
        center: CGPoint,
        radiusScale: CGSize,
        stops: [Gradient.Stop],
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        let radius = CGSize(
            width: faceRect.width * radiusScale.width,
            height: faceRect.height * radiusScale.height
        )
        guard radius.width > 0, radius.height > 0 else { return }

        var radial = context
        radial.clip(to: path)
        radial.translateBy(
            x: faceRect.minX + faceRect.width * center.x,
            y: faceRect.minY + faceRect.height * center.y
        )
        radial.scaleBy(x: radius.width, y: radius.height)
        radial.fill(
            Path(CGRect(x: -1, y: -1, width: 2, height: 2)),
            with: .radialGradient(
                Gradient(stops: stops),
                center: .zero,
                startRadius: 0,
                endRadius: 1
            )
        )
    }

    static func border<S: InsettableShape>(
        shape: S,
        color: Color,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.stroke(
            shape.inset(by: DesignMetrics.hairline / 2).path(in: faceRect),
            with: .color(color),
            lineWidth: DesignMetrics.hairline
        )
    }

    static func focusRing<S: InsettableShape>(
        shape: S,
        in context: inout GraphicsContext,
        faceRect: CGRect
    ) {
        context.stroke(
            shape.inset(by: -3).path(in: faceRect),
            with: .color(DuskColors.accent),
            lineWidth: DesignMetrics.focusRing
        )
    }
}

private struct VoicePodCanvas: View, Animatable {
    let presentation: VoiceCapturePresentationState
    let enabled: Bool
    let focused: Bool
    let increasedContrast: Bool
    let layoutDirection: LayoutDirection

    private var expansionAmount: CGFloat
    private var holdingAmount: CGFloat
    private var autoAmount: CGFloat
    private var pressAmount: CGFloat

    init(
        presentation: VoiceCapturePresentationState,
        enabled: Bool,
        pressed: Bool,
        focused: Bool,
        increasedContrast: Bool,
        layoutDirection: LayoutDirection
    ) {
        self.presentation = presentation
        self.enabled = enabled
        self.focused = focused
        self.increasedContrast = increasedContrast
        self.layoutDirection = layoutDirection
        expansionAmount = presentation.isExpanded ? 1 : 0
        holdingAmount = presentation.isHolding ? 1 : 0
        autoAmount = presentation.isAuto ? 1 : 0
        pressAmount = pressed ? 1 : 0
    }

    var animatableData: AnimatablePair<
        AnimatablePair<CGFloat, CGFloat>,
        AnimatablePair<CGFloat, CGFloat>
    > {
        get {
            AnimatablePair(
                AnimatablePair(expansionAmount, holdingAmount),
                AnimatablePair(autoAmount, pressAmount)
            )
        }
        set {
            expansionAmount = newValue.first.first
            holdingAmount = newValue.first.second
            autoAmount = newValue.second.first
            pressAmount = newValue.second.second
        }
    }

    private var isEnabled: Bool { enabled && !presentation.isDisabled }

    var body: some View {
        GeometryReader { proxy in
            let overflow = VoiceCaptureLayout.podGlow.sourceInset
                + VoiceCaptureLayout.podGlow.radius
                + max(abs(VoiceCaptureLayout.podGlow.x), abs(VoiceCaptureLayout.podGlow.y))
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let shape = VoiceCaptureLayout.podShape(
                expansion: expansionAmount,
                layoutDirection: layoutDirection
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                let facePath = shape.path(in: faceRect)
                let castOpacity = (isEnabled ? 0.78 : 0.42) * Double(1 - pressAmount)
                VoiceCanvasDrawing.shadow(
                    shape: shape,
                    color: Color.black.opacity(castOpacity),
                    geometry: VoiceCaptureLayout.podShadow,
                    in: &context,
                    faceRect: faceRect
                )
                if isEnabled, expansionAmount > 0 {
                    let glow = DuskColors.accent.mix(
                        with: DuskColors.sage,
                        by: Double(autoAmount),
                        in: .perceptual
                    )
                    VoiceCanvasDrawing.shadow(
                        shape: shape,
                        color: glow.opacity((0.68 - 0.10 * Double(autoAmount)) * Double(expansionAmount)),
                        geometry: DesignDropShadowGeometry(
                            radius: VoiceCaptureLayout.podGlow.radius - 4 * autoAmount,
                            y: VoiceCaptureLayout.podGlow.y - 2 * autoAmount,
                            sourceInset: VoiceCaptureLayout.podGlow.sourceInset - autoAmount
                        ),
                        in: &context,
                        faceRect: faceRect
                    )
                }
                VoiceCanvasDrawing.shadow(
                    shape: shape,
                    color: DuskColors.bgSunk.opacity(0.94),
                    geometry: DesignDropShadowGeometry(
                        radius: 0,
                        y: 2 - pressAmount,
                        sourceInset: 1
                    ),
                    in: &context,
                    faceRect: faceRect
                )

                let idleBase = DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.09)
                let autoBase = DuskColors.paper.overlaying(DuskColors.sage, opacity: 0.48)
                let enabledBase = idleBase.mix(
                    with: autoBase,
                    by: Double(autoAmount),
                    in: .perceptual
                )
                let disabledBase = DuskColors.bgElev.overlaying(
                    DuskColors.ink4,
                    opacity: DesignMaterialAdapter.slateDisabledBaseInkMix
                )
                VoiceCanvasDrawing.slateFace(
                    path: facePath,
                    base: (isEnabled ? enabledBase : disabledBase).overlaying(
                        DuskColors.bgSunk,
                        opacity: 0.18 * Double(pressAmount)
                    ),
                    muted: !isEnabled,
                    in: &context,
                    faceRect: faceRect
                )
                if isEnabled, holdingAmount > 0 {
                    var holdContext = context
                    holdContext.opacity = Double(holdingAmount)
                    VoiceCanvasDrawing.holdFace(
                        path: facePath,
                        in: &holdContext,
                        faceRect: faceRect
                    )
                }

                VoiceCanvasDrawing.pressedOcclusion(
                    path: facePath,
                    amount: pressAmount,
                    in: &context
                )
                VoiceCanvasDrawing.border(
                    shape: shape,
                    color: increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft,
                    in: &context,
                    faceRect: faceRect
                )
                VoiceCanvasDrawing.topEdge(
                    shape: shape,
                    color: DuskColors.ink.opacity(0.17 * Double(1 - pressAmount)),
                    in: &context,
                    faceRect: faceRect
                )
                if focused {
                    VoiceCanvasDrawing.focusRing(shape: shape, in: &context, faceRect: faceRect)
                }
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct VoiceCrownSpineCanvas: View {
    var body: some View {
        GeometryReader { proxy in
            let overflow = DesignCanvasEffects.overflow(blur: 20, y: 8)
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let deckShape = RoundedRectangle(cornerRadius: 14, style: .continuous)
            let spineRect = CGRect(
                x: faceRect.minX + 5,
                y: faceRect.maxY - 15,
                width: max(0, faceRect.width - 10),
                height: 15
            )
            let spineShape = RoundedRectangle(cornerRadius: 8, style: .continuous)

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                let deckDropShadow = DesignDropShadowGeometry(radius: 10, y: 8, sourceInset: 0)
                VoiceCanvasDrawing.shadow(
                    shape: deckShape,
                    color: Color.black.opacity(0.42),
                    geometry: deckDropShadow,
                    in: &context,
                    faceRect: faceRect,
                    // CSS filter drop-shadow authors sigma directly; the
                    // shared box-shadow helper accepts CSS blur instead.
                    blur: deckDropShadow.radius * 2
                )
                VoiceCanvasDrawing.shadow(
                    shape: spineShape,
                    color: Color.black.opacity(0.5),
                    geometry: DesignDropShadowGeometry(radius: 4, y: 2, sourceInset: 0),
                    in: &context,
                    faceRect: spineRect
                )

                let spinePath = spineShape.path(in: spineRect)
                context.fill(spinePath, with: .linearGradient(
                    Gradient(colors: [
                        DuskColors.paper.overlaying(DuskColors.line, opacity: 0.12),
                        DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.32),
                    ]),
                    startPoint: CGPoint(x: spineRect.midX, y: spineRect.minY),
                    endPoint: CGPoint(x: spineRect.midX, y: spineRect.maxY)
                ))
                var occlusion = context
                occlusion.clip(to: spinePath)
                occlusion.fill(spinePath, with: .linearGradient(
                    Gradient(colors: [Color.black.opacity(0.18), .clear]),
                    startPoint: CGPoint(x: spineRect.midX, y: spineRect.minY),
                    endPoint: CGPoint(x: spineRect.midX, y: spineRect.minY + 6)
                ))
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct VoiceTargetFacetCanvas: View, Animatable {
    let choice: VoiceCaptureTarget
    let focused: Bool
    let increasedContrast: Bool
    let layoutDirection: LayoutDirection

    private var selectionAmount: CGFloat
    private var pressAmount: CGFloat

    init(
        choice: VoiceCaptureTarget,
        selected: Bool,
        pressed: Bool,
        focused: Bool,
        increasedContrast: Bool,
        layoutDirection: LayoutDirection
    ) {
        self.choice = choice
        self.focused = focused
        self.increasedContrast = increasedContrast
        self.layoutDirection = layoutDirection
        selectionAmount = selected ? 1 : 0
        pressAmount = pressed ? 1 : 0
    }

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(selectionAmount, pressAmount) }
        set {
            selectionAmount = newValue.first
            pressAmount = newValue.second
        }
    }

    private var restingColor: Color {
        choice == .auto
            ? DuskColors.paper.overlaying(DuskColors.sage, opacity: 0.18)
            : DuskColors.paper.overlaying(DuskColors.bgElev, opacity: 0.06)
    }

    private var selectedColor: Color {
        switch choice {
        case .auto: DuskColors.sage.overlaying(DuskColors.paper, opacity: 0.22)
        case .cancel: DuskColors.stop
        case .send: DuskColors.accent
        }
    }

    private var semanticColor: Color {
        switch choice {
        case .auto: DuskColors.sage
        case .cancel: DuskColors.stop
        case .send: DuskColors.accent
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let overflow = DesignCanvasEffects.overflow(blur: 18, y: 8)
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let shape = VoiceCaptureLayout.targetShape(
                choice: choice,
                selected: selectionAmount,
                layoutDirection: layoutDirection
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                let facePath = shape.path(in: faceRect)
                let shadowAmount = selectionAmount * (1 - pressAmount)
                let facetDropShadow = DesignDropShadowGeometry(radius: 9, y: 8, sourceInset: 0)
                VoiceCanvasDrawing.shadow(
                    shape: shape,
                    color: Color.black.opacity(0.52 * Double(shadowAmount)),
                    geometry: facetDropShadow,
                    in: &context,
                    faceRect: faceRect,
                    // The approved facet uses filter drop-shadow, whose blur
                    // argument is already sigma rather than CSS box blur.
                    blur: facetDropShadow.radius * 2
                )
                VoiceCanvasDrawing.shadow(
                    shape: shape,
                    color: semanticColor.opacity(
                        (choice == .auto ? 0.38 : 0.34) * Double(shadowAmount)
                    ),
                    geometry: facetDropShadow,
                    in: &context,
                    faceRect: faceRect,
                    blur: facetDropShadow.radius * 2
                )

                let base = restingColor.mix(
                    with: selectedColor,
                    by: Double(selectionAmount),
                    in: .perceptual
                )
                VoiceCanvasDrawing.facetFace(
                    path: facePath,
                    base: base.overlaying(
                        DuskColors.bgSunk,
                        opacity: 0.18 * Double(pressAmount)
                    ),
                    in: &context,
                    faceRect: faceRect
                )
                VoiceCanvasDrawing.pressedOcclusion(
                    path: facePath,
                    amount: pressAmount,
                    in: &context
                )
                VoiceCanvasDrawing.border(
                    shape: shape,
                    color: increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft,
                    in: &context,
                    faceRect: faceRect
                )
                VoiceCanvasDrawing.topEdge(
                    shape: shape,
                    color: DuskColors.ink.opacity(
                        Double((0.12 + 0.08 * selectionAmount) * (1 - pressAmount))
                    ),
                    in: &context,
                    faceRect: faceRect
                )
                if focused {
                    VoiceCanvasDrawing.focusRing(shape: shape, in: &context, faceRect: faceRect)
                }
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct VoiceCrownSelectionSeam: View {
    let color: Color

    var body: some View {
        GeometryReader { proxy in
            let overflow: CGFloat = 8
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let shape = Capsule(style: .continuous)

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                VoiceCanvasDrawing.shadow(
                    shape: shape,
                    color: color.opacity(0.55),
                    geometry: DesignDropShadowGeometry(radius: 6, y: 0, sourceInset: 0),
                    in: &context,
                    faceRect: faceRect
                )
                context.fill(shape.path(in: faceRect), with: .color(color))
            }
            .frame(
                width: proxy.size.width + overflow * 2,
                height: proxy.size.height + overflow * 2
            )
            .offset(x: -overflow, y: -overflow)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct VoiceAutoOrbit<S: InsettableShape>: View {
    let shape: S

    @ComposerReduceMotion private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
            let phase = reduceMotion
                ? 0.0
                : (sin(timeline.date.timeIntervalSinceReferenceDate * 4.05) + 1) / 2
            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, size in
                let rect = CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5)
                context.stroke(
                    shape.path(in: rect),
                    with: .color(DuskColors.sage.opacity(0.48 + phase * 0.24)),
                    lineWidth: 1
                )
            }
            .scaleEffect(reduceMotion ? 1 : 1 + phase * 0.055)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private extension View {
    @ViewBuilder
    func voiceCaptureAccessibilityActions(
        presentation: VoiceCapturePresentationState,
        onStartHold: @escaping () -> Void,
        onTarget: @escaping (VoiceCaptureTarget) -> Void
    ) -> some View {
        if presentation.isHolding {
            self
                .accessibilityAction(named: "Send voice message") { onTarget(.send) }
                .accessibilityAction(named: "Cancel voice message") { onTarget(.cancel) }
                .accessibilityAction(named: "Switch to Auto listening") { onTarget(.auto) }
        } else if !presentation.isAuto && !presentation.isDisabled {
            self.accessibilityAction(named: "Start Hold voice capture", onStartHold)
        } else {
            self
        }
    }
}
