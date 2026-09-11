import MobileData
import SwiftUI

private struct ComposerReduceMotionOverrideKey: EnvironmentKey {
    static let defaultValue: Bool? = nil
}

extension EnvironmentValues {
    var composerReduceMotionOverride: Bool? {
        get { self[ComposerReduceMotionOverrideKey.self] }
        set { self[ComposerReduceMotionOverrideKey.self] = newValue }
    }
}

@propertyWrapper
struct ComposerReduceMotion: DynamicProperty {
    @Environment(\.accessibilityReduceMotion) private var systemValue
    @Environment(\.composerReduceMotionOverride) private var override

    var wrappedValue: Bool { override ?? systemValue }
}

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
    private let initiallyExpandedTaskId: String?

    @State private var draft: String
    @State private var localHoldPresentationActive = false
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
        initiallyExpandedTaskId: String? = nil,
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
        self.initiallyExpandedTaskId = initiallyExpandedTaskId
        _draft = State(initialValue: initialDraft)
    }

    private var voicePresentation: ComposerVoicePresentationState {
        ComposerVoicePresentationState(
            talkMode: talkMode,
            localHoldActive: localHoldPresentationActive
        )
    }
    private var isHolding: Bool { voicePresentation.isHolding }
    private var draftPresent: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: tasks.isEmpty ? 0 : ComposerGeometry.joinOverlap) {
            if !tasks.isEmpty {
                ComposerTaskStrip(
                    items: tasks,
                    initiallyExpandedTaskId: initiallyExpandedTaskId
                )
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
                onHoldPresentationChanged: { localHoldPresentationActive = $0 },
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

    @ComposerReduceMotion private var reduceMotion
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

/// The child reports physical Hold presentation synchronously so the composer
/// recedes siblings in the same layout pass. Shared `TalkMode` remains the
/// semantic authority and keeps Hold active once its asynchronous update lands.
struct ComposerVoicePresentationState: Equatable {
    let talkMode: TalkMode
    let localHoldActive: Bool

    var isHolding: Bool { localHoldActive || talkMode == .hold }
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
    let onHoldPresentationChanged: (Bool) -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    @ComposerReduceMotion private var reduceMotion
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
                        ComposerGlyphView(.attachment)
                            .frame(width: 19, height: 19)
                    }
                    .buttonStyle(ComposerControlButtonStyle(tone: .quiet, size: ComposerGeometry.smallControlSize))
                    .disabled(true)
                    .accessibilityLabel("Attachments are not available")
                    .accessibilityIdentifier("chat-attach")

                    Button(action: onTtsToggle) {
                        ComposerGlyphView(ttsEnabled ? .spokenResponsesOn : .spokenResponsesOff)
                            .frame(width: 19, height: 19)
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

            ComposerTrailingActionLayout(
                spacing: ComposerGeometry.trailingActionGap,
                layoutDirection: layoutDirection
            ) {
                if canInterrupt && !held {
                    Button(action: onInterrupt) {
                        ComposerGlyphView(.stopResponse)
                            .frame(width: 19, height: 19)
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
                        ComposerGlyphView(.send)
                            .frame(width: 19, height: 19)
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
                        onHoldPresentationChanged: onHoldPresentationChanged,
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

/// Wraps trailing controls into logical trailing-aligned rows without
/// shrinking any target. This covers the widest supported combination: Stop,
/// text Send, and persistent Auto at Accessibility Dynamic Type.
struct ComposerTrailingActionLayout: Layout {
    let spacing: CGFloat
    let layoutDirection: LayoutDirection

    static func rows(
        availableWidth: CGFloat,
        itemWidths: [CGFloat],
        spacing: CGFloat
    ) -> [[Int]] {
        guard !itemWidths.isEmpty else { return [] }
        let limit = max(0, availableWidth)
        var result: [[Int]] = []
        var row: [Int] = []
        var rowWidth: CGFloat = 0

        for (index, width) in itemWidths.enumerated() {
            let nextWidth = rowWidth + (row.isEmpty ? 0 : spacing) + width
            if !row.isEmpty, nextWidth > limit {
                result.append(row)
                row = [index]
                rowWidth = width
            } else {
                row.append(index)
                rowWidth = nextWidth
            }
        }
        if !row.isEmpty { result.append(row) }
        return result
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let availableWidth = proposal.width ?? .greatestFiniteMagnitude
        let rows = Self.rows(
            availableWidth: availableWidth,
            itemWidths: sizes.map(\.width),
            spacing: spacing
        )
        let rowSizes = rows.map { rowSize($0, sizes: sizes) }
        return CGSize(
            width: rowSizes.map(\.width).max() ?? 0,
            height: rowSizes.map(\.height).reduce(0, +)
                + CGFloat(max(0, rowSizes.count - 1)) * spacing
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let rows = Self.rows(
            availableWidth: bounds.width,
            itemWidths: sizes.map(\.width),
            spacing: spacing
        )
        var y = bounds.minY

        for row in rows {
            let rowSize = rowSize(row, sizes: sizes)
            if layoutDirection == .leftToRight {
                var x = bounds.maxX - rowSize.width
                for index in row {
                    place(
                        subviews[index],
                        size: sizes[index],
                        x: x,
                        y: y + (rowSize.height - sizes[index].height) / 2
                    )
                    x += sizes[index].width + spacing
                }
            } else {
                var x = bounds.minX + rowSize.width
                for index in row {
                    x -= sizes[index].width
                    place(
                        subviews[index],
                        size: sizes[index],
                        x: x,
                        y: y + (rowSize.height - sizes[index].height) / 2
                    )
                    x -= spacing
                }
            }
            y += rowSize.height + spacing
        }
    }

    private func rowSize(_ row: [Int], sizes: [CGSize]) -> CGSize {
        CGSize(
            width: row.map { sizes[$0].width }.reduce(0, +)
                + CGFloat(max(0, row.count - 1)) * spacing,
            height: row.map { sizes[$0].height }.max() ?? 0
        )
    }

    private func place(_ subview: LayoutSubview, size: CGSize, x: CGFloat, y: CGFloat) {
        subview.place(
            at: CGPoint(x: x, y: y),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: size.width, height: size.height)
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
        let naturalTrailing = subviews[1].sizeThatFits(.unspecified)
        let naturalWidth = leading.width + (leading.width > 0 ? spacing : 0) + naturalTrailing.width
        let width = proposal.width ?? naturalWidth
        let stacked = Self.shouldStack(
            availableWidth: width,
            leadingWidth: leading.width,
            trailingWidth: naturalTrailing.width,
            spacing: spacing
        )
        let trailingLimit = stacked
            ? width
            : max(0, width - leading.width - (leading.width > 0 ? spacing : 0))
        let trailing = subviews[1].sizeThatFits(
            ProposedViewSize(width: trailingLimit, height: nil)
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
        let naturalTrailing = subviews[1].sizeThatFits(.unspecified)
        let stacked = Self.shouldStack(
            availableWidth: bounds.width,
            leadingWidth: leading.width,
            trailingWidth: naturalTrailing.width,
            spacing: spacing
        )
        let trailingLimit = stacked
            ? bounds.width
            : max(0, bounds.width - leading.width - (leading.width > 0 ? spacing : 0))
        let trailing = subviews[1].sizeThatFits(
            ProposedViewSize(width: trailingLimit, height: nil)
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
        radius: 32, x: 4, y: 19, sourceInset: 25
    )
    static let controlShadow = DesignDropShadowGeometry(
        radius: 14, y: 9, sourceInset: 10
    )
    static let controlGlow = DesignDropShadowGeometry(
        radius: 18, y: 12, sourceInset: 12
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

private struct ComposerFaceBackground: View {
    let cornerRadius: CGFloat
    let isFocused: Bool
    let isVoiceActive: Bool

    @Environment(\.colorSchemeContrast) private var contrast

    private var emphasized: Bool { isFocused || isVoiceActive }

    var body: some View {
        GeometryReader { proxy in
            let overflow = max(
                ComposerCanvasDrawing.overflow(for: [
                    ComposerGeometry.faceShadow,
                    ComposerGeometry.faceAccentShadow,
                ]),
                DesignCanvasEffects.overflow(
                    blur: ComposerGeometry.frameShadow.radius * 2,
                    y: ComposerGeometry.frameShadow.y
                )
            )
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let facePath = ComposerCanvasDrawing.roundedPath(
                in: faceRect,
                cornerRadius: cornerRadius
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.82),
                    geometry: ComposerGeometry.frameShadow,
                    // CSS filter drop-shadow authors sigma directly; the
                    // shared box-shadow helper accepts CSS blur instead.
                    blur: ComposerGeometry.frameShadow.radius * 2
                )
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: Color.black.opacity(0.97),
                    geometry: ComposerGeometry.faceShadow
                )
                ComposerCanvasDrawing.drawShadow(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.accent.opacity(emphasized ? 0.64 : 0.48),
                    geometry: DesignDropShadowGeometry(
                        radius: ComposerGeometry.faceAccentShadow.radius,
                        x: ComposerGeometry.faceAccentShadow.x,
                        y: ComposerGeometry.faceAccentShadow.y,
                        sourceInset: emphasized ? 20 : ComposerGeometry.faceAccentShadow.sourceInset
                    )
                )
                ComposerCanvasDrawing.drawContact(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.95),
                    y: 2
                )

                ComposerCanvasDrawing.fillLinear(
                    facePath,
                    in: &context,
                    rect: faceRect,
                    cssDegrees: 118,
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.ink4, opacity: 0.06), location: 0),
                        .init(color: DuskColors.paper, location: 0.48),
                        .init(color: DuskColors.paper.overlaying(DuskColors.accentSoft, opacity: 0.04), location: 1),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(
                        x: faceRect.minX + faceRect.width * 0.84,
                        y: faceRect.minY + faceRect.height * 0.08
                    ),
                    radii: CGSize(
                        width: max(faceRect.width, faceRect.height) * 0.34,
                        height: max(faceRect.width, faceRect.height) * 0.34
                    ),
                    stops: [
                        .init(color: DuskColors.accent.opacity(0.05), location: 0),
                        .init(color: DuskColors.accent.opacity(0), location: 1),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.52),
                    radii: CGSize(width: faceRect.width * 0.72, height: faceRect.height * 1.15),
                    stops: [
                        .init(color: DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.26), location: 0),
                        .init(color: DuskColors.paper.opacity(0), location: 0.70),
                    ]
                )
                ComposerCanvasDrawing.fillLinear(
                    facePath,
                    in: &context,
                    rect: faceRect,
                    cssDegrees: 108,
                    stops: [
                        .init(color: DuskColors.ink.opacity(0), location: 0.40),
                        .init(color: DuskColors.ink.opacity(0.015), location: 0.49),
                        .init(color: DuskColors.ink.opacity(0), location: 0.58),
                    ]
                )
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(
                        x: faceRect.minX + faceRect.width * 0.82,
                        y: faceRect.minY + faceRect.height * 1.12
                    ),
                    radii: CGSize(width: faceRect.width * 0.44, height: faceRect.height * 0.56),
                    stops: [
                        .init(color: DuskColors.accent.opacity(0.05), location: 0),
                        .init(color: DuskColors.accent.opacity(0), location: 0.72),
                    ]
                )

                context.stroke(
                    ComposerCanvasDrawing.roundedPath(
                        in: faceRect,
                        cornerRadius: cornerRadius,
                        inset: DesignMetrics.hairline / 2
                    ),
                    with: .color(
                        emphasized
                            ? DuskColors.line.overlaying(DuskColors.accent, opacity: 0.46)
                            : (contrast == .increased ? DuskColors.ink3 : DuskColors.line)
                    ),
                    lineWidth: DesignMetrics.hairline
                )
                ComposerCanvasDrawing.drawTopLight(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.ink.opacity(0.16)
                )
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

private enum ComposerCanvasDrawing {
    static func overflow(for geometries: [DesignDropShadowGeometry]) -> CGFloat {
        geometries.map {
            $0.sourceInset + $0.radius + max(abs($0.x), abs($0.y))
        }.max() ?? 0
    }

    static func roundedPath(
        in rect: CGRect,
        cornerRadius: CGFloat,
        inset: CGFloat = 0
    ) -> Path {
        guard rect.width - 2 * inset > 0, rect.height - 2 * inset > 0 else {
            return Path()
        }
        return RoundedRectangle(
            cornerRadius: max(0, cornerRadius - inset),
            style: .continuous
        )
        .path(in: rect.insetBy(dx: inset, dy: inset))
    }

    static func drawShadow(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color,
        geometry: DesignDropShadowGeometry,
        blur: CGFloat? = nil
    ) {
        let source = roundedPath(
            in: faceRect,
            cornerRadius: cornerRadius,
            inset: geometry.sourceInset
        )
        DesignCanvasEffects.outerShadow(
            in: &context,
            sourcePath: source,
            color: color,
            blur: blur ?? geometry.radius,
            x: geometry.x,
            y: geometry.y
        )
    }

    static func drawContact(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color,
        y: CGFloat
    ) {
        let geometry = DesignDropShadowGeometry(radius: 0, y: y, sourceInset: 1)
        drawShadow(
            in: &context,
            faceRect: faceRect,
            cornerRadius: cornerRadius,
            color: color,
            geometry: geometry
        )
    }

    static func fillLinear(
        _ path: Path,
        in context: inout GraphicsContext,
        rect: CGRect,
        cssDegrees: CGFloat,
        stops: [Gradient.Stop]
    ) {
        let radians = cssDegrees * .pi / 180
        let direction = CGVector(dx: sin(radians), dy: -cos(radians))
        let extent = (abs(direction.dx) * rect.width + abs(direction.dy) * rect.height) / 2
        context.fill(path, with: .linearGradient(
            Gradient(stops: stops),
            startPoint: CGPoint(
                x: rect.midX - direction.dx * extent,
                y: rect.midY - direction.dy * extent
            ),
            endPoint: CGPoint(
                x: rect.midX + direction.dx * extent,
                y: rect.midY + direction.dy * extent
            )
        ))
    }

    static func fillEllipticalRadial(
        _ clipPath: Path,
        in context: inout GraphicsContext,
        center: CGPoint,
        radii: CGSize,
        stops: [Gradient.Stop]
    ) {
        guard radii.width > 0, radii.height > 0 else { return }
        var radial = context
        radial.clip(to: clipPath)
        radial.translateBy(x: center.x, y: center.y)
        radial.scaleBy(x: radii.width, y: radii.height)
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

    static func drawTopLight(
        in context: inout GraphicsContext,
        faceRect: CGRect,
        cornerRadius: CGFloat,
        color: Color
    ) {
        let inner = roundedPath(
            in: faceRect,
            cornerRadius: cornerRadius,
            inset: DesignMetrics.hairline
        )
        var translated = Path()
        translated.addPath(
            inner,
            transform: CGAffineTransform(translationX: 0, y: DesignMetrics.hairline)
        )
        var difference = inner
        difference.addPath(translated)

        var highlight = context
        highlight.clip(to: inner)
        highlight.fill(difference, with: .color(color), style: FillStyle(eoFill: true))
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
    @ComposerReduceMotion private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
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

    private func controlFace(pressed: Bool) -> some View {
        ComposerControlCanvas(
            tone: tone,
            baseColor: pressed
                ? baseColor.overlaying(DuskColors.bgSunk, opacity: 0.18)
                : baseColor,
            isEnabled: isEnabled,
            isPressed: pressed,
            isFocused: isFocused,
            increasedContrast: contrast == .increased
        )
    }
}

private struct ComposerControlCanvas: View {
    let tone: ComposerControlTone
    let baseColor: Color
    let isEnabled: Bool
    let isPressed: Bool
    let isFocused: Bool
    let increasedContrast: Bool

    private let cornerRadius: CGFloat = 10

    var body: some View {
        GeometryReader { proxy in
            let overflow = ComposerCanvasDrawing.overflow(for: [
                ComposerGeometry.controlShadow,
                ComposerGeometry.controlGlow,
                DesignMaterialShadowGeometry.slatePressed,
            ])
            let faceRect = CGRect(
                x: overflow,
                y: overflow,
                width: proxy.size.width,
                height: proxy.size.height
            )
            let facePath = ComposerCanvasDrawing.roundedPath(
                in: faceRect,
                cornerRadius: cornerRadius
            )

            Canvas(opaque: false, colorMode: .nonLinear, rendersAsynchronously: false) { context, _ in
                if isPressed {
                    ComposerCanvasDrawing.drawShadow(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: Color.black.opacity(0.88),
                        geometry: DesignMaterialShadowGeometry.slatePressed
                    )
                } else {
                    ComposerCanvasDrawing.drawShadow(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: Color.black.opacity(isEnabled ? 0.72 : 0.42),
                        geometry: ComposerGeometry.controlShadow
                    )
                    if tone != .quiet, isEnabled {
                        ComposerCanvasDrawing.drawShadow(
                            in: &context,
                            faceRect: faceRect,
                            cornerRadius: cornerRadius,
                            color: tone == .stop
                                ? DuskColors.stop.opacity(0.62)
                                : DuskColors.accent.opacity(0.66),
                            geometry: ComposerGeometry.controlGlow
                        )
                    }
                }
                ComposerCanvasDrawing.drawContact(
                    in: &context,
                    faceRect: faceRect,
                    cornerRadius: cornerRadius,
                    color: DuskColors.bgSunk.opacity(0.92),
                    y: isPressed ? 1 : 2
                )

                context.fill(facePath, with: .color(baseColor))
                ComposerCanvasDrawing.fillEllipticalRadial(
                    facePath,
                    in: &context,
                    center: CGPoint(x: faceRect.midX, y: faceRect.minY + faceRect.height * 0.52),
                    radii: CGSize(width: faceRect.width * 0.82, height: faceRect.height * 1.05),
                    stops: [
                        .init(
                            color: baseColor.overlaying(
                                DuskColors.bgSunk,
                                opacity: isEnabled ? 0.22 : 0.16
                            ),
                            location: 0
                        ),
                        .init(
                            color: baseColor.overlaying(DuskColors.bgSunk, opacity: 0.10),
                            location: 0.50
                        ),
                        .init(color: baseColor, location: 1),
                    ]
                )
                context.stroke(
                    ComposerCanvasDrawing.roundedPath(
                        in: faceRect,
                        cornerRadius: cornerRadius,
                        inset: DesignMetrics.hairline / 2
                    ),
                    with: .color(increasedContrast ? DuskColors.ink3 : DuskColors.lineSoft),
                    lineWidth: DesignMetrics.hairline
                )

                if isPressed {
                    DesignCanvasEffects.insetShadow(
                        in: &context,
                        facePath: facePath,
                        sourcePath: facePath,
                        color: DuskColors.bgSunk.opacity(0.42),
                        blur: 3,
                        y: 2
                    )
                } else {
                    ComposerCanvasDrawing.drawTopLight(
                        in: &context,
                        faceRect: faceRect,
                        cornerRadius: cornerRadius,
                        color: DuskColors.ink.opacity(0.17)
                    )
                }

                if isFocused {
                    context.stroke(
                        ComposerCanvasDrawing.roundedPath(
                            in: faceRect,
                            cornerRadius: cornerRadius,
                            inset: -3
                        ),
                        with: .color(DuskColors.accent),
                        lineWidth: DesignMetrics.focusRing
                    )
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
