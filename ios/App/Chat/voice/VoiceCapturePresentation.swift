import SwiftUI

/// The visual shell for the capture control. It composes presentation leaves
/// while `VoiceCaptureControl` supplies semantic actions and gesture handling.
struct VoiceCaptureSurface: View {
    let state: VoiceCaptureState
    let target: VoiceCaptureTarget
    let levels: [Float]
    let disabled: Bool
    let announcement: String
    let captureGesture: VoiceCaptureGesture
    let onActivate: () -> Void
    let onStartAccessibleHold: () -> Void
    let onTarget: (VoiceCaptureTarget) -> Void

    @ComposerReduceMotion private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

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

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            ZStack(alignment: .bottomTrailing) {
                if presentation.showsTargetDeck {
                    VoiceCaptureTargetDeck(
                        selected: target,
                        width: crownWidth,
                        onSelect: onTarget
                    )
                    .offset(y: -(VoiceCaptureLayout.crownHeight(dynamicTypeSize) - VoiceCaptureLayout.seamOverlap))
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
                    captureGesture: captureGesture,
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
    let captureGesture: VoiceCaptureGesture
    let onActivate: () -> Void
    let onStartAccessibleHold: () -> Void
    let onTarget: (VoiceCaptureTarget) -> Void

    @ComposerReduceMotion private var reduceMotion

    var body: some View {
        Button(action: onActivate) {
            ZStack {
                if presentation.showsWaveform {
                    PttBigWave(
                        levels: levels,
                        tint: presentation.isAuto ? DuskColors.sage : DuskColors.accent,
                        animates: !reduceMotion
                    )
                    .frame(height: VoiceCaptureLayout.waveformHeight)
                    .padding(.leading, VoiceCaptureLayout.waveformLeadingInset)
                    .padding(.trailing, VoiceCaptureLayout.glyphWellWidth)
                    .accessibilityHidden(true)
                }

                captureGlyph
                    .frame(maxWidth: .infinity, alignment: presentation.isExpanded ? .trailing : .center)
                    .padding(.trailing, presentation.isExpanded ? VoiceCaptureLayout.glyphTrailingInset : 0)
            }
            .frame(width: width, height: height)
        }
        .buttonStyle(VoicePodButtonStyle(
            presentation: presentation,
            width: width,
            height: height
        ))
        .disabled(presentation.isDisabled)
        .gesture(captureGesture)
        .accessibilityLabel(presentation.primaryLabel)
        .accessibilityHint(presentation.primaryHint)
        .accessibilityAddTraits(presentation.isAuto ? .isSelected : [])
        .voiceCaptureAccessibilityActions(
            presentation: presentation,
            onStartHold: onStartAccessibleHold,
            onTarget: onTarget
        )
        .accessibilityIdentifier("chat-mic")
    }

    @ViewBuilder
    private var captureGlyph: some View {
        if presentation.isHolding {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(DuskColors.accent)
                .frame(width: 11, height: 11)
                .rotationEffect(.degrees(45))
                .shadow(color: DuskColors.accent.opacity(0.56), radius: 7)
                .overlay {
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .stroke(DuskColors.accent.opacity(0.2), lineWidth: 5)
                        .rotationEffect(.degrees(45))
                }
        } else {
            Image(systemName: presentation.isAuto ? "waveform" : "mic.fill")
                .font(.system(size: 20, weight: .semibold))
        }
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
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            DuskColors.paper.overlaying(DuskColors.line, opacity: 0.12),
                            DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.32)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(height: 15)
                .padding(.horizontal, 5)
                .shadow(color: Color.black.opacity(0.5), radius: 4, y: 2)

            HStack(spacing: 0) {
                ForEach(choices, id: \.self) { choice in
                    targetButton(choice)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            GeometryReader { proxy in
                let segment = proxy.size.width / CGFloat(choices.count)
                Capsule()
                    .fill(selectionColor)
                    .frame(width: max(24, segment - 16), height: 3)
                    .shadow(color: selectionColor.opacity(0.55), radius: 6)
                    .offset(
                        x: CGFloat(selectedVisualIndex) * segment + 8,
                        y: proxy.size.height - 4
                    )
            }
            .allowsHitTesting(false)
        }
        .frame(width: width, height: VoiceCaptureLayout.crownHeight(dynamicTypeSize))
        .shadow(color: Color.black.opacity(0.42), radius: 10, y: 8)
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

    private func targetIcon(_ choice: VoiceCaptureTarget) -> some View {
        Image(systemName: targetIconName(choice))
            .font(.system(size: 15, weight: .semibold))
    }

    private func targetIconName(_ choice: VoiceCaptureTarget) -> String {
        switch choice {
        case .auto: "waveform"
        case .cancel: "xmark"
        case .send: "paperplane"
        }
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
    static let waveformHeight: CGFloat = 30
    static let waveformLeadingInset: CGFloat = 15
    static let glyphWellWidth: CGFloat = 52
    static let glyphTrailingInset: CGFloat = 17
    static let failureNoticeWidth: CGFloat = 240

    static let podShadow = DesignDropShadowGeometry(
        radius: 20, y: 13, sourceInset: 13
    )
    static let podGlow = DesignDropShadowGeometry(
        radius: 22, x: 3, y: 14, sourceInset: 14
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

    static func targetGeometry(
        podSize: CGSize,
        horizontalSizeClass: UserInterfaceSizeClass?,
        dynamicTypeSize: DynamicTypeSize,
        layoutDirection: LayoutDirection
    ) -> VoiceCaptureTargetGeometry {
        VoiceCaptureTargetGeometry(
            podSize: podSize,
            crownSize: CGSize(
                width: crownWidth(
                    horizontalSizeClass: horizontalSizeClass,
                    dynamicTypeSize: dynamicTypeSize
                ),
                height: crownHeight(dynamicTypeSize)
            ),
            seamOverlap: seamOverlap,
            rightToLeft: layoutDirection == .rightToLeft
        )
    }

    static func podShape(
        expanded: Bool,
        layoutDirection: LayoutDirection
    ) -> UnevenRoundedRectangle {
        guard expanded else {
            return UnevenRoundedRectangle(
                topLeadingRadius: 14,
                bottomLeadingRadius: 14,
                bottomTrailingRadius: 14,
                topTrailingRadius: 14,
                style: .continuous
            )
        }
        let leading: CGFloat = 17
        let trailing: CGFloat = 10
        return UnevenRoundedRectangle(
            topLeadingRadius: layoutDirection == .leftToRight ? leading : trailing,
            bottomLeadingRadius: layoutDirection == .leftToRight ? leading : trailing,
            bottomTrailingRadius: layoutDirection == .leftToRight ? trailing : leading,
            topTrailingRadius: layoutDirection == .leftToRight ? trailing : leading,
            style: .continuous
        )
    }
}

private struct VoicePodButtonStyle: ButtonStyle {
    let presentation: VoiceCapturePresentationState
    let width: CGFloat
    let height: CGFloat

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

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(foregroundColor)
            .frame(width: width, height: height)
            .background { podFace(pressed: configuration.isPressed) }
            .overlay {
                if presentation.isAuto {
                    VoiceAutoOrbit(shape: shape)
                        .padding(-5)
                }
            }
            .contentShape(shape)
            .offset(y: configuration.isPressed && !reduceMotion ? 1 : 0)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
    }

    private var baseColor: Color {
        if !isEnabled {
            return DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.48)
        }
        if presentation.isAuto {
            return DuskColors.paper.overlaying(DuskColors.sage, opacity: 0.48)
        }
        if presentation.isHolding || presentation.state == .transitioning {
            return DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.3)
        }
        return DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.09)
    }

    private var foregroundColor: Color {
        if !isEnabled { return DuskColors.ink4 }
        return presentation.isAuto ? DuskColors.bgSunk : DuskColors.ink
    }

    @ViewBuilder
    private func podFace(pressed: Bool) -> some View {
        ZStack {
            if !pressed {
                DesignSpreadShadow(
                    shape: shape,
                    color: Color.black.opacity(isEnabled ? 0.78 : 0.42),
                    geometry: VoiceCaptureLayout.podShadow
                )
                if presentation.isExpanded, isEnabled {
                    DesignSpreadShadow(
                        shape: shape,
                        color: (presentation.isAuto ? DuskColors.sage : DuskColors.accent).opacity(0.5),
                        geometry: VoiceCaptureLayout.podGlow
                    )
                }
            }
            designSlateFace(
                role: presentation.isAuto ? .action : .secondary,
                muted: !isEnabled,
                hovered: false,
                baseOverride: pressed
                    ? baseColor.overlaying(DuskColors.bgSunk, opacity: 0.18)
                    : baseColor
            )
            .clipShape(shape)
            shape.fill(
                LinearGradient(
                    colors: [
                        Color.clear,
                        (presentation.isAuto ? DuskColors.sage : DuskColors.accent).opacity(
                            presentation.isExpanded ? 0.1 : 0.035
                        )
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            shape.stroke(
                contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                lineWidth: DesignMetrics.hairline
            )
            ComposerMaterialContactEdge(shape: shape, color: DuskColors.bgSunk.opacity(0.94), y: pressed ? 1 : 2)
            if !pressed {
                DesignTopEdgeLight(shape: shape, color: DuskColors.ink.opacity(0.17))
            }
            if isFocused {
                ComposerMaterialFocusRing(shape: shape)
            }
        }
    }
}

private struct VoiceTargetButtonStyle: ButtonStyle {
    let choice: VoiceCaptureTarget
    let selected: Bool

    @Environment(\.isFocused) private var isFocused
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection

    private var shape: UnevenRoundedRectangle {
        let outer: CGFloat = selected ? 19 : 14
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

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(selected ? selectedForeground : DuskColors.ink2)
            .background {
                ZStack {
                    designSlateFace(
                        role: choice == .cancel && selected
                            ? .destructive
                            : selected ? .action : .secondary,
                        muted: false,
                        hovered: false,
                        baseOverride: (selected ? selectedColor : restingColor).overlaying(
                            DuskColors.bgSunk,
                            opacity: configuration.isPressed ? 0.18 : 0
                        )
                    )
                    .clipShape(shape)
                    shape.stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
                    DesignTopEdgeLight(shape: shape, color: DuskColors.ink.opacity(selected ? 0.2 : 0.12))
                    if isFocused {
                        ComposerMaterialFocusRing(shape: shape)
                    }
                }
            }
            .contentShape(shape)
            .offset(y: selected && !configuration.isPressed ? -5 : configuration.isPressed && !reduceMotion ? 1 : 0)
            .scaleEffect(selected && !configuration.isPressed ? 1.015 : 1)
            .animation(
                reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
                value: configuration.isPressed
            )
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

    private var selectedForeground: Color {
        choice == .cancel ? DuskColors.ink : DuskColors.bgSunk
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
            shape
                .stroke(DuskColors.sage.opacity(0.48 + phase * 0.24), lineWidth: 1)
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
