import MobileData
import SwiftUI

/// Encapsulated native composer. Draft ownership stays here so permission,
/// capture failures, reconnects, and Hold/Auto transitions never erase text.
struct Composer: View {
    let tasks: [TaskListItem]
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let onSend: (String) -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void
    let onFocusGained: () -> Void

    @State private var draft: String
    @FocusState private var inputFocused: Bool
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    init(
        tasks: [TaskListItem],
        ttsEnabled: Bool,
        talkMode: TalkMode,
        micLevels: [Float],
        voiceDisabled: Bool,
        canInterrupt: Bool,
        initialDraft: String = "",
        onSend: @escaping (String) -> Void,
        onVoiceIntent: @escaping (VoiceCaptureIntent) -> Void,
        onTtsToggle: @escaping () -> Void,
        onInterrupt: @escaping () -> Void,
        onFocusGained: @escaping () -> Void
    ) {
        self.tasks = tasks
        self.ttsEnabled = ttsEnabled
        self.talkMode = talkMode
        self.micLevels = micLevels
        self.voiceDisabled = voiceDisabled
        self.canInterrupt = canInterrupt
        self.onSend = onSend
        self.onVoiceIntent = onVoiceIntent
        self.onTtsToggle = onTtsToggle
        self.onInterrupt = onInterrupt
        self.onFocusGained = onFocusGained
        _draft = State(initialValue: initialDraft)
    }

    private var isHolding: Bool { talkMode == .hold }
    private var draftPresent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: tasks.isEmpty ? 0 : ComposerGeometry.joinOverlap) {
            if !tasks.isEmpty {
                ComposerTaskStrip(items: tasks)
                    .padding(
                        .horizontal,
                        ComposerGeometry.taskShelfInset(horizontalSizeClass: horizontalSizeClass)
                    )
                    .zIndex(0)
            }

            composerFace
                .zIndex(1)
        }
        .frame(maxWidth: ComposerGeometry.maximumWidth)
        .padding(.horizontal, ComposerGeometry.dockHorizontalInset)
        .padding(.top, Space.sm)
        .padding(.bottom, Space.sm)
        .onChange(of: inputFocused) { _, focused in
            if focused { onFocusGained() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-composer")
    }

    private var composerFace: some View {
        VStack(spacing: ComposerGeometry.contentGap(horizontalSizeClass: horizontalSizeClass)) {
            DraftEditor(
                text: $draft,
                isFocused: $inputFocused,
                isReceded: isHolding,
                minimumHeight: ComposerGeometry.editorMinimumHeight(
                    horizontalSizeClass: horizontalSizeClass
                ),
                horizontalInset: ComposerGeometry.editorHorizontalInset(
                    horizontalSizeClass: horizontalSizeClass
                ),
                onSubmit: sendDraft
            )

            ComposerActions(
                draftPresent: draftPresent && !isHolding,
                held: isHolding,
                ttsEnabled: ttsEnabled,
                talkMode: talkMode,
                micLevels: micLevels,
                voiceDisabled: voiceDisabled,
                canInterrupt: canInterrupt,
                onSend: sendDraft,
                onVoiceIntent: onVoiceIntent,
                onTtsToggle: onTtsToggle,
                onInterrupt: onInterrupt
            )
        }
        .padding(
            .horizontal,
            ComposerGeometry.faceHorizontalPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .padding(
            .top,
            ComposerGeometry.faceTopPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .padding(
            .bottom,
            ComposerGeometry.faceBottomPadding(horizontalSizeClass: horizontalSizeClass)
        )
        .frame(maxWidth: .infinity)
        .contentShape(
            RoundedRectangle(
                cornerRadius: ComposerGeometry.faceRadius(horizontalSizeClass: horizontalSizeClass),
                style: .continuous
            )
        )
        .onTapGesture {
            if !isHolding { inputFocused = true }
        }
        .background {
            ComposerFaceBackground(
                cornerRadius: ComposerGeometry.faceRadius(horizontalSizeClass: horizontalSizeClass),
                isFocused: inputFocused,
                isVoiceActive: talkMode != .idle
            )
        }
    }

    private func sendDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onSend(text)
        draft = ""
        inputFocused = false
    }
}

// MARK: - Draft editor

private struct DraftEditor: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let isReceded: Bool
    let minimumHeight: CGFloat
    let horizontalInset: CGFloat
    let onSubmit: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var promptText: String {
        horizontalSizeClass == .regular
            ? "Message or speak to Sentient"
            : "Message or speak"
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Text(text.isEmpty ? " " : text)
                .font(Typo.ui(TypeScale.base))
                .lineSpacing(2)
                .lineLimit(6)
                .foregroundStyle(Color.clear)
                .padding(.bottom, ComposerGeometry.editorGrowthReserve)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)

            TextField(
                "Message Sentient",
                text: $text,
                prompt: Text(promptText)
                    .foregroundStyle(DuskColors.ink3),
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .tint(DuskColors.accent)
            .lineSpacing(2)
            .lineLimit(1...6)
            .submitLabel(.send)
            .onSubmit(onSubmit)
            .focused(isFocused)
            .accessibilityLabel("Message Sentient")
            .accessibilityIdentifier("composer-input")
        }
        .frame(minHeight: minimumHeight, alignment: .topLeading)
        .padding(.horizontal, horizontalInset)
        .opacity(isReceded ? ComposerGeometry.recededOpacity : 1)
        .offset(y: isReceded ? ComposerGeometry.recededOffset : 0)
        .allowsHitTesting(!isReceded)
        .accessibilityHidden(isReceded)
        .animation(
            reduceMotion ? nil : .easeOut(duration: DesignV2.Motion.feedback),
            value: isReceded
        )
    }
}

// MARK: - Composer actions

struct ComposerActionState: Equatable {
    let draftPresent: Bool
    let talkMode: TalkMode

    var showsSend: Bool { draftPresent }
    var showsVoiceCapture: Bool { !draftPresent || talkMode != .idle }
}

private struct ComposerActions: View {
    let draftPresent: Bool
    let held: Bool
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let onSend: () -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        let actions = ComposerActionState(draftPresent: draftPresent, talkMode: talkMode)

        ComposerActionLayout(
            spacing: ComposerGeometry.actionGap,
            layoutDirection: layoutDirection
        ) {
            HStack(spacing: ComposerGeometry.actionGap) {
                if !held {
                    Button(action: {}) {
                        Image(systemName: "paperclip")
                    }
                    .buttonStyle(ComposerControlButtonStyle(tone: .quiet, size: ComposerGeometry.smallControlSize))
                    .disabled(true)
                    .accessibilityLabel("Attachments are not available")
                    .accessibilityIdentifier("chat-attach")

                    Button(action: onTtsToggle) {
                        Image(systemName: ttsEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill")
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: ttsEnabled ? .toggleOn : .quiet,
                        size: ComposerGeometry.smallControlSize
                    ))
                    .accessibilityLabel(ttsEnabled ? "Spoken responses on; turn off" : "Spoken responses off; turn on")
                    .accessibilityValue(ttsEnabled ? "On" : "Off")
                    .accessibilityAddTraits(ttsEnabled ? .isSelected : [])
                    .accessibilityIdentifier("chat-tts-toggle")
                }
            }

            HStack(spacing: ComposerGeometry.trailingActionGap) {
                if canInterrupt && !held {
                    Button(action: onInterrupt) {
                        Image(systemName: "stop.fill")
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: .stop,
                        size: ComposerGeometry.smallControlSize
                    ))
                    .accessibilityLabel("Stop Sentient response")
                    .accessibilityIdentifier("chat-interrupt")
                    .transition(.scale(scale: 0.82).combined(with: .opacity))
                }

                if actions.showsSend {
                    Button(action: onSend) {
                        Image(systemName: "paperplane")
                    }
                    .buttonStyle(ComposerControlButtonStyle(
                        tone: .send,
                        size: ComposerGeometry.trailingControlSize(
                            horizontalSizeClass: horizontalSizeClass
                        )
                    ))
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("chat-send")
                    .transition(.scale(scale: 0.88).combined(with: .opacity))
                }

                if actions.showsVoiceCapture {
                    VoiceCaptureControl(
                        talkMode: talkMode,
                        levels: micLevels,
                        disabled: voiceDisabled,
                        onIntent: onVoiceIntent
                    )
                    .transition(.scale(scale: 0.88).combined(with: .opacity))
                }
            }
        }
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: actions
        )
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: held
        )
        .animation(
            reduceMotion ? nil : .spring(duration: DesignV2.Motion.state, bounce: 0),
            value: canInterrupt
        )
    }
}

/// Lays out the two action groups against the current parent proposal. On a
/// narrow or large-text proposal, the trailing group moves below rather than
/// shrinking controls or measuring against global screen bounds.
struct ComposerActionLayout: Layout {
    let spacing: CGFloat
    let layoutDirection: LayoutDirection

    static func shouldStack(
        availableWidth: CGFloat,
        leadingWidth: CGFloat,
        trailingWidth: CGFloat,
        spacing: CGFloat
    ) -> Bool {
        leadingWidth > 0 && leadingWidth + spacing + trailingWidth > availableWidth
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let leading = subviews[0].sizeThatFits(.unspecified)
        let trailing = subviews[1].sizeThatFits(.unspecified)
        let naturalWidth = leading.width + (leading.width > 0 ? spacing : 0) + trailing.width
        let width = proposal.width ?? naturalWidth
        let stacked = Self.shouldStack(
            availableWidth: width,
            leadingWidth: leading.width,
            trailingWidth: trailing.width,
            spacing: spacing
        )
        let height = stacked
            ? leading.height + spacing + trailing.height
            : max(leading.height, trailing.height)
        return CGSize(width: width, height: height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard subviews.count == 2 else { return }
        let leading = subviews[0].sizeThatFits(.unspecified)
        let trailing = subviews[1].sizeThatFits(.unspecified)
        let stacked = Self.shouldStack(
            availableWidth: bounds.width,
            leadingWidth: leading.width,
            trailingWidth: trailing.width,
            spacing: spacing
        )

        if stacked {
            place(
                subviews[0],
                size: leading,
                x: logicalLeadingX(size: leading, in: bounds),
                y: bounds.minY
            )
            place(
                subviews[1],
                size: trailing,
                x: logicalTrailingX(size: trailing, in: bounds),
                y: bounds.minY + leading.height + spacing
            )
        } else {
            place(
                subviews[0],
                size: leading,
                x: logicalLeadingX(size: leading, in: bounds),
                y: bounds.midY - leading.height / 2
            )
            place(
                subviews[1],
                size: trailing,
                x: logicalTrailingX(size: trailing, in: bounds),
                y: bounds.midY - trailing.height / 2
            )
        }
    }

    private func logicalLeadingX(size: CGSize, in bounds: CGRect) -> CGFloat {
        layoutDirection == .leftToRight ? bounds.minX : bounds.maxX - size.width
    }

    private func logicalTrailingX(size: CGSize, in bounds: CGRect) -> CGFloat {
        layoutDirection == .leftToRight ? bounds.maxX - size.width : bounds.minX
    }

    private func place(_ subview: LayoutSubview, size: CGSize, x: CGFloat, y: CGFloat) {
        subview.place(
            at: CGPoint(x: x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
        )
    }
}

// MARK: - Purpose-built composer material

enum ComposerGeometry {
    static let maximumWidth: CGFloat = 860
    static let dockHorizontalInset: CGFloat = 8
    static let compactTaskShelfInset: CGFloat = 10
    static let regularTaskShelfInset: CGFloat = 18
    static let joinOverlap: CGFloat = -1
    static let compactFaceRadius: CGFloat = 16
    static let regularFaceRadius: CGFloat = 18
    static let compactFaceHorizontalPadding: CGFloat = 9
    static let regularFaceHorizontalPadding: CGFloat = 12
    static let compactFaceTopPadding: CGFloat = 12
    static let regularFaceTopPadding: CGFloat = 12
    static let compactFaceBottomPadding: CGFloat = 8
    static let regularFaceBottomPadding: CGFloat = 16
    static let compactContentGap: CGFloat = 7
    static let regularContentGap: CGFloat = 10
    static let compactEditorMinimumHeight: CGFloat = 42
    static let regularEditorMinimumHeight: CGFloat = 52
    static let compactEditorHorizontalInset: CGFloat = 4
    static let regularEditorHorizontalInset: CGFloat = 5
    static let editorGrowthReserve: CGFloat = 12
    static let actionGap: CGFloat = 5
    static let trailingActionGap: CGFloat = 6
    static let smallControlSize: CGFloat = 44
    static let compactTrailingControlSize: CGFloat = 48
    static let regularTrailingControlSize: CGFloat = 44
    static let recededOpacity = 0.07
    static let recededOffset: CGFloat = 3

    static let frameShadow = DesignDropShadowGeometry(
        radius: 24, y: 22, sourceInset: 0
    )
    static let faceShadow = DesignDropShadowGeometry(
        radius: 32, y: 18, sourceInset: 20
    )
    static let faceAccentShadow = DesignDropShadowGeometry(
        radius: 32, x: 4, y: 19, sourceInset: 22
    )
    static let controlShadow = DesignDropShadowGeometry(
        radius: 14, y: 9, sourceInset: 10
    )
    static let controlGlow = DesignDropShadowGeometry(
        radius: 18, x: 2, y: 10, sourceInset: 12
    )

    static func taskShelfInset(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular ? regularTaskShelfInset : compactTaskShelfInset
    }

    static func faceRadius(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularFaceRadius : compactFaceRadius
    }

    static func faceHorizontalPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceHorizontalPadding
            : compactFaceHorizontalPadding
    }

    static func faceTopPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceTopPadding
            : compactFaceTopPadding
    }

    static func faceBottomPadding(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularFaceBottomPadding
            : compactFaceBottomPadding
    }

    static func contentGap(horizontalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        horizontalSizeClass == .regular ? regularContentGap : compactContentGap
    }

    static func editorMinimumHeight(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularEditorMinimumHeight
            : compactEditorMinimumHeight
    }

    static func editorHorizontalInset(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularEditorHorizontalInset
            : compactEditorHorizontalInset
    }

    static func trailingControlSize(
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> CGFloat {
        horizontalSizeClass == .regular
            ? regularTrailingControlSize
            : compactTrailingControlSize
    }
}

/// Composer-owned contact edge and focus ring. These keep the reviewed local
/// geometry without routing the controls back through generic button styles.
struct ComposerMaterialContactEdge<S: InsettableShape>: View {
    let shape: S
    let color: Color
    let y: CGFloat

    var body: some View {
        DesignSpreadShadow(
            shape: shape,
            color: color,
            geometry: DesignDropShadowGeometry(radius: 0, y: y, sourceInset: 1)
        )
        .accessibilityHidden(true)
    }
}

struct ComposerMaterialFocusRing<S: InsettableShape>: View {
    let shape: S

    var body: some View {
        shape
            .inset(by: -3)
            .stroke(DuskColors.accent, lineWidth: DesignMetrics.focusRing)
            .accessibilityHidden(true)
    }
}

private struct ComposerFaceBackground: View {
    let cornerRadius: CGFloat
    let isFocused: Bool
    let isVoiceActive: Bool

    @Environment(\.colorSchemeContrast) private var contrast

    private var emphasized: Bool { isFocused || isVoiceActive }
    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    }

    var body: some View {
        ZStack {
            DesignSpreadShadow(
                shape: shape,
                color: DuskColors.bgSunk.opacity(0.82),
                geometry: ComposerGeometry.frameShadow
            )
            DesignSpreadShadow(
                shape: shape,
                color: Color.black.opacity(emphasized ? 0.97 : 0.9),
                geometry: ComposerGeometry.faceShadow
            )
            DesignSpreadShadow(
                shape: shape,
                color: DuskColors.accent.opacity(emphasized ? 0.48 : 0.2),
                geometry: ComposerGeometry.faceAccentShadow
            )

            designSlateFace(
                role: .secondary,
                muted: false,
                hovered: false,
                baseOverride: DuskColors.paper
            )
            .clipShape(shape)
            shape.fill(
                LinearGradient(
                    colors: [
                        DuskColors.paper.opacity(0.12),
                        Color.clear,
                        DuskColors.ink.opacity(0.025)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            shape.fill(
                RadialGradient(
                    colors: [DuskColors.accent.opacity(0.09), Color.clear],
                    center: .bottomTrailing,
                    startRadius: 0,
                    endRadius: 170
                )
            )
            shape.stroke(
                emphasized
                    ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.46)
                    : (contrast == .increased ? DuskColors.ink3 : DuskColors.line),
                lineWidth: DesignMetrics.hairline
            )
            ComposerMaterialContactEdge(shape: shape, color: DuskColors.bgSunk.opacity(0.95), y: 2)
            DesignTopEdgeLight(shape: shape, color: DuskColors.ink.opacity(0.16))
        }
        .accessibilityHidden(true)
    }
}

private enum ComposerControlTone {
    case quiet
    case toggleOn
    case send
    case stop
}

private struct ComposerControlButtonStyle: ButtonStyle {
    let tone: ComposerControlTone
    let size: CGFloat

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: tone == .stop ? 13 : 19, weight: .semibold))
            .foregroundStyle(foregroundColor)
            .frame(width: size, height: size)
            .background { controlFace(pressed: configuration.isPressed) }
            .overlay(alignment: .topTrailing) {
                if tone == .toggleOn, isEnabled {
                    Circle()
                        .fill(DuskColors.ink)
                        .frame(width: 6, height: 6)
                        .overlay {
                            Circle().stroke(DuskColors.accent, lineWidth: 2)
                        }
                        .padding(5)
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
        guard isEnabled else {
            return DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.45)
        }
        switch tone {
        case .quiet:
            return DuskColors.paper.overlaying(DuskColors.ink2, opacity: 0.09)
        case .toggleOn, .send:
            return DuskColors.accent
        case .stop:
            return DuskColors.paper.overlaying(DuskColors.stop, opacity: 0.5)
        }
    }

    private var foregroundColor: Color {
        guard isEnabled else { return DuskColors.ink4 }
        switch tone {
        case .quiet:
            return DuskColors.ink2
        case .toggleOn, .send:
            return DuskColors.bgSunk
        case .stop:
            return DuskColors.ink
        }
    }

    @ViewBuilder
    private func controlFace(pressed: Bool) -> some View {
        ZStack {
            if !pressed {
                DesignSpreadShadow(
                    shape: shape,
                    color: Color.black.opacity(isEnabled ? 0.72 : 0.42),
                    geometry: ComposerGeometry.controlShadow
                )
                if tone != .quiet, isEnabled {
                    DesignSpreadShadow(
                        shape: shape,
                        color: semanticGlow,
                        geometry: ComposerGeometry.controlGlow
                    )
                }
            }
            designSlateFace(
                role: tone == .stop
                    ? .destructive
                    : tone == .send || tone == .toggleOn ? .action : .secondary,
                muted: !isEnabled,
                hovered: false,
                baseOverride: pressed
                    ? baseColor.overlaying(DuskColors.bgSunk, opacity: 0.18)
                    : baseColor
            )
            .clipShape(shape)
            shape.stroke(
                contrast == .increased ? DuskColors.ink3 : DuskColors.lineSoft,
                lineWidth: DesignMetrics.hairline
            )
            ComposerMaterialContactEdge(shape: shape, color: DuskColors.bgSunk.opacity(0.92), y: pressed ? 1 : 2)
            if !pressed {
                DesignTopEdgeLight(shape: shape, color: DuskColors.ink.opacity(0.17))
            }
            if isFocused {
                ComposerMaterialFocusRing(shape: shape)
            }
        }
    }

    private var semanticGlow: Color {
        tone == .stop ? DuskColors.stop.opacity(0.58) : DuskColors.accent.opacity(0.62)
    }
}
