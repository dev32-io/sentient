import CoreGraphics
import SwiftUI

struct DesignPageChrome<Content: View>: View {
    let title: String
    let accessibilityId: String
    let bottomPadding: CGFloat
    @ViewBuilder let content: () -> Content

    init(
        title: String,
        accessibilityId: String,
        bottomPadding: CGFloat = Space.md,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.accessibilityId = accessibilityId
        self.bottomPadding = bottomPadding
        self.content = content
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) { content() }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.md)
                .padding(.bottom, bottomPadding)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(DuskColors.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(DuskColors.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .accessibilityIdentifier(accessibilityId)
        .duskTheme()
    }
}

enum DesignCardHeaderStyle { case elevated, quiet }
enum DesignCardBodyStyle { case rows, padded }

/// The one card surface used by settings. Header and body styles preserve the
/// old pane/card spacing without maintaining two separate visual renderers.
struct DesignCard<Content: View>: View {
    let title: String?
    let detail: String?
    let headerStyle: DesignCardHeaderStyle
    let bodyStyle: DesignCardBodyStyle
    @ViewBuilder let content: () -> Content

    init(
        title: String? = nil,
        detail: String? = nil,
        headerStyle: DesignCardHeaderStyle = .elevated,
        bodyStyle: DesignCardBodyStyle = .rows,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.detail = detail
        self.headerStyle = headerStyle
        self.bodyStyle = bodyStyle
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil { header }
            bodyContent
        }
        .designPlate()
    }

    @ViewBuilder
    private var header: some View {
        if headerStyle == .elevated {
            headerContent
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.md)
                .background(
                    LinearGradient(
                        colors: [DuskColors.bgElev, DuskColors.bgElev.overlaying(DuskColors.paper, opacity: 0.60)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(alignment: .bottom) { DesignDivider() }
        } else {
            VStack(alignment: .leading, spacing: Space.xs) {
                headerContent
                DesignDivider()
            }
            .padding(.bottom, Space.md)
        }
    }

    private var headerContent: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title ?? "")
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .foregroundStyle(DuskColors.ink)
            if let detail {
                Text(detail)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }

    @ViewBuilder
    private var bodyContent: some View {
        switch bodyStyle {
        case .rows:
            VStack(alignment: .leading, spacing: 0, content: content)
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
        case .padded:
            VStack(alignment: .leading, spacing: Space.md, content: content)
                .padding(Space.lg)
        }
    }
}

/// Semantic pane retained for callers that need the quieter pane header. Its
/// surface and spacing are owned by `DesignCard`.
struct DesignPane<Content: View>: View {
    var title: String? = nil
    var detail: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        DesignCard(title: title, detail: detail, headerStyle: .quiet, bodyStyle: .padded) {
            content()
        }
    }
}

private struct DominantVisualCardButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused
    let hovered: Bool
    let quietHoverBorder: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let raised = hovered && isEnabled
        let shape = RoundedRectangle(cornerRadius: Radii.lg, style: .continuous)
        let face = raised
            ? DuskColors.paper.overlaying(
                DuskColors.bgSunk,
                opacity: DesignMaterialAdapter.mediaCardHoverSunkMix
            )
            : DuskColors.paper.overlaying(
                DuskColors.bgElev,
                opacity: DesignMaterialAdapter.mediaCardElevatedMix
            )
        configuration.label
            .background {
                shape.fill(
                    face.shadow(
                        .inner(
                            color: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightOpacity),
                            radius: 0.5,
                            y: 1
                        )
                    )
                )
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(
                    focused
                        ? DuskColors.accent
                        : hovered && !quietHoverBorder ? DuskColors.line : DuskColors.lineSoft,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(
                            pressed ? 0.88 : DesignMaterialAdapter.mediaCardRestBlack
                        ),
                        geometry: pressed
                            ? DesignMaterialShadowGeometry.slatePressed
                            : DesignMaterialShadowGeometry.plate
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.line.opacity(DesignMaterialAdapter.mediaCardContactOpacity),
                        geometry: DesignDropShadowGeometry(
                            radius: 0,
                            y: pressed ? 1 : 2,
                            sourceInset: 1
                        )
                    )
                }
            }
            .offset(y: pressed ? DesignMetrics.pressedDepth : raised ? -1 : 0)
            .opacity(isEnabled ? 1 : 0.58)
            // Touch-down is immediate; only pointer hover gets a transition.
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: raised)
    }
}

/// A reusable identity/media action. The visual, copy, target, and material
/// surface stay together so login and future identity pickers cannot drift.
struct DesignDominantVisualCard<Visual: View>: View {
    let title: String
    var detail: String? = nil
    let accessibilityLabel: String
    let accessibilityId: String
    var quietHoverBorder = false
    let action: () -> Void
    @ViewBuilder let visual: () -> Visual
    @State private var hovered = false

    init(
        title: String,
        detail: String? = nil,
        accessibilityLabel: String,
        accessibilityId: String,
        quietHoverBorder: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder visual: @escaping () -> Visual
    ) {
        self.title = title
        self.detail = detail
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityId = accessibilityId
        self.quietHoverBorder = quietHoverBorder
        self.action = action
        self.visual = visual
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: DesignMetrics.dominantCardGap) {
                ZStack {
                    visual()
                        .accessibilityHidden(true)
                        .frame(width: DesignMetrics.dominantAvatarSize, height: DesignMetrics.dominantAvatarSize)
                }
                .frame(width: DesignMetrics.dominantVisualSize, height: DesignMetrics.dominantVisualSize)
                .designWell(cornerRadius: Radii.xl, showsBorder: false, showsInsetHighlights: false)

                VStack(spacing: DesignMetrics.dominantLabelGap) {
                    Text(title)
                        .font(Typo.display(TypeScale.lg, .medium))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .accessibilityHidden(true)
                    if let detail {
                        Text(detail)
                            .font(Typo.ui(TypeScale.sm))
                            .foregroundStyle(DuskColors.ink2)
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, DesignMetrics.dominantCardPaddingH)
            .padding(.vertical, DesignMetrics.dominantCardPaddingV)
            .frame(maxWidth: .infinity, minHeight: DesignMetrics.dominantCardMinimumHeight)
            .contentShape(Rectangle())
            .accessibilityElement(children: .ignore)
        }
        .buttonStyle(DominantVisualCardButtonStyle(hovered: hovered, quietHoverBorder: quietHoverBorder))
        .onHover { hovered = $0 }
        .accessibilityRepresentation {
            Text(accessibilityLabel)
        }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Enter PIN")
        .accessibilityIdentifier(accessibilityId)
    }
}

private struct PinShakeEffect: GeometryEffect {
    var amount: CGFloat = CGFloat(Space.sm)
    var animatableData: CGFloat

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(
            CGAffineTransform(translationX: sin(Double(animatableData) * .pi * 4) * amount, y: 0)
        )
    }
}

private enum DesignPinKeypadState {
    static let length = 4
    static let checkingCycle: TimeInterval = 0.9
    static let errorFeedbackDuration = Duration.milliseconds(Int((DesignV2.Motion.state * 1_000).rounded()))
}

/// Native PIN keypad composite with explicit progress, retry feedback, and
/// platform keyboard parity. Authentication remains owned by the screen model.
struct DesignPinKeypad: View {
    let entered: Int
    var isSubmitting = false
    var error: String? = nil
    var success: String? = nil
    var errorRevision = 0
    var statusAccessibilityId = "pin-status"
    let onDigit: (Character) -> Void
    let onDelete: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var errorReady = true

    private static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"]

    private var isChecking: Bool { isSubmitting && success == nil && error == nil }
    private var keyDisabled: Bool { isSubmitting || success != nil || (error != nil && !errorReady) }
    private var status: String {
        if let success { return success }
        if let error { return error }
        if isSubmitting { return "Checking PIN…" }
        if entered > 0 { return "\(entered) of \(DesignPinKeypadState.length) digits entered." }
        return "Enter your four-digit PIN."
    }

    var body: some View {
        VStack(spacing: Space.md) {
            progress
            Text(status)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(statusColor)
                .frame(minHeight: 20)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier(
                    error != nil ? "login-error" : isSubmitting ? "login-submitting" : statusAccessibilityId
                )
                .accessibilityAddTraits(error == nil ? [] : .isStaticText)
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: DesignMetrics.pinKeyGap), count: 3),
                spacing: DesignMetrics.pinKeyGap
            ) {
                ForEach(Self.keys, id: \.self) { key in
                    keyView(key)
                }
            }
            .frame(width: DesignMetrics.pinKeypadWidth)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("PIN keypad")
        }
        .focusable()
        .onKeyPress(phases: .down) { keyPress in
            if let digit = keyPress.characters.first, keyPress.characters.count == 1, digit.isNumber {
                guard !keyDisabled else { return .handled }
                onDigit(digit)
                return .handled
            }
            if keyPress.key == .delete || keyPress.key == .deleteForward {
                guard !keyDisabled else { return .handled }
                onDelete()
                return .handled
            }
            return .ignored
        }
        .task(id: "\(errorRevision):\(error ?? "")") {
            guard error != nil else {
                errorReady = true
                return
            }
            errorReady = false
            do {
                try await Task.sleep(for: DesignPinKeypadState.errorFeedbackDuration)
                guard !Task.isCancelled else { return }
                errorReady = true
            } catch {
                // Cancellation is expected when the user starts a fresh attempt.
            }
        }
    }

    @ViewBuilder
    private var progress: some View {
        TimelineView(.animation(minimumInterval: 0.05, paused: !isChecking || reduceMotion)) { context in
            let cycle = context.date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: DesignPinKeypadState.checkingCycle)
            let phase = (sin(cycle / DesignPinKeypadState.checkingCycle * 2 * .pi) + 1) / 2
            HStack(spacing: Space.md) {
                ForEach(0..<DesignPinKeypadState.length, id: \.self) { index in
                    Circle()
                        .fill(dotColor(index: index))
                        .frame(width: DesignMetrics.pinDotSize, height: DesignMetrics.pinDotSize)
                        .overlay(Circle().stroke(dotBorder(index: index), lineWidth: DesignMetrics.hairline))
                        .shadow(color: dotGlow(index: index), radius: 5)
                        .scaleEffect(isChecking ? 0.94 + (0.12 * phase) : entered > index ? 1.06 : 1)
                        .opacity(isChecking ? 0.72 + (0.28 * phase) : 1)
                        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: entered)
                }
            }
            .modifier(PinShakeEffect(animatableData: reduceMotion ? 0 : CGFloat(errorRevision)))
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: errorRevision)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("PIN entry")
            .accessibilityValue(success != nil ? "PIN accepted" : "\(entered) of \(DesignPinKeypadState.length) digits entered")
        }
    }

    @ViewBuilder
    private func keyView(_ key: String) -> some View {
        if key.isEmpty {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .accessibilityHidden(true)
        } else if key == "delete" {
            DesignIconButton(
                systemName: "delete.left",
                label: "Delete last digit",
                role: .destructive,
                state: keyDisabled ? .disabled : .normal,
                accessibilityId: "pin-delete",
                minimumSize: DesignMetrics.pinKeySize,
                action: onDelete
            )
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
        } else {
            DesignActionButton(
                title: key,
                role: .secondary,
                state: keyDisabled ? .disabled : .normal,
                accessibilityId: "pin-key-\(key)",
                fillsWidth: true,
                minimumHeight: DesignMetrics.pinKeySize,
                action: { onDigit(Character(key)) }
            )
            .frame(maxWidth: .infinity)
            .aspectRatio(1, contentMode: .fit)
        }
    }

    private var statusColor: Color {
        if success != nil { return DuskColors.ok }
        if error != nil { return DuskColors.stop }
        return DuskColors.ink2
    }

    private func dotColor(index: Int) -> Color {
        if success != nil { return DuskColors.ok }
        if error != nil { return DuskColors.stop }
        return entered > index ? DuskColors.accent : DuskColors.bgElev
    }

    private func dotBorder(index: Int) -> Color {
        if success != nil { return DuskColors.ok }
        if error != nil { return DuskColors.stop.opacity(0.74) }
        return entered > index ? DuskColors.accent.opacity(0.62) : DuskColors.line
    }

    private func dotGlow(index: Int) -> Color {
        if success != nil { return .clear }
        if error != nil { return DuskColors.stop.opacity(0.8) }
        return entered > index ? DuskColors.accent : .clear
    }
}

private enum DesignSettingsRowMetrics {
    // DesignCard's rows body contributes 8pt above and below the row. Keep
    // the native content measure at 56pt so the card-hosted composite retains
    // the handoff's 70pt row rhythm without shrinking its 44pt controls.
    static let minimumHeight = DesignMetrics.minimumTarget + Space.md
}

/// Compatibility card API. New callers should use `DesignCard` directly.
struct DesignSettingsRow<Accessory: View>: View {
    let title: String
    var detail: String? = nil
    var accessibilityId: String? = nil
    @ViewBuilder let accessory: () -> Accessory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        rowContent
            .frame(maxWidth: .infinity, minHeight: DesignSettingsRowMetrics.minimumHeight, alignment: .leading)
            // Keep the label and its native control in one accessibility
            // container without collapsing the accessory's semantics.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    @ViewBuilder
    private var rowContent: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Space.sm) {
                labelContent
                HStack {
                    Spacer(minLength: 0)
                    accessory()
                }
            }
        } else {
            HStack(alignment: .center, spacing: Space.lg) {
                labelContent
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Match the source grid's flexible label column while the
                    // trailing accessory keeps its intrinsic control width.
                    .layoutPriority(1)
                accessory()
            }
        }
    }

    @ViewBuilder
    private var labelContent: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
            if let detail {
                Text(detail)
                    .font(Typo.ui(TypeScale.sm))
                    .lineSpacing(TypeScale.sm * CGFloat(DesignV2.Typography.lineNormal - 1))
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }
}

struct DesignGroupHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Canonical settings category row. `CategoryRow` is a compatibility delegate.
struct DesignCategoryRow: View {
    let icon: SettingsIcon
    let title: String
    let accessibilityId: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Space.md) {
                Image(systemName: icon.symbolName)
                    .font(.system(size: TypeScale.base, weight: .medium))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(width: DesignMetrics.categoryIconSlot, alignment: .center)
                    .accessibilityHidden(true)
                Text(title)
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.system(size: TypeScale.xs, weight: .semibold))
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .padding(.vertical, Space.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityIdentifier(accessibilityId)
    }
}

struct DesignStatusBadge: View {
    let title: String
    var tint: Color = DuskColors.accent
    var accessibilityId: String? = nil

    var body: some View {
        Text(title)
            .font(Typo.ui(TypeScale.sm, .semibold))
            .foregroundStyle(DuskColors.bg)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .background(tint, in: Capsule())
            .accessibilityLabel(title)
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

private enum DesignDisclosureMetrics {
    // The reviewed summary row is taller than the platform minimum target;
    // its content remains flexible when Dynamic Type needs more room.
    static let rowHeight: CGFloat = 68
    static let chevronSize: CGFloat = 17
    static let chevronFontSize: CGFloat = 14
    static let chevronGlowRadius: CGFloat = 5
    static let insertionOffset: CGFloat = -5
    static let removalOffset: CGFloat = -4
    static let expandedDetailBottomPadding = Space.sm
    static let expandedBottomMargin = Space.sm
}

private struct DesignDisclosureButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isFocused) private var focused
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled && !reduceMotion
        configuration.label
            .overlay {
                RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                    .stroke(
                        focused ? DuskColors.accent : .clear,
                        lineWidth: contrast == .increased ? DesignMetrics.focusRing : DesignMetrics.focusBorder
                    )
                    .padding(DesignMetrics.focusBorderInset)
            }
            // Disclosure headers are native buttons. Pressing closes the air
            // gap immediately; the expansion itself remains state-driven.
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
    }
}

private struct DesignDisclosureBodyTransition: ViewModifier {
    let y: CGFloat
    let opacity: Double

    func body(content: Content) -> some View {
        content
            .opacity(opacity)
            .offset(y: y)
    }
}

enum DesignDisclosureMotion {
    static func animation(isExpanded: Bool, reduceMotion: Bool) -> Animation? {
        DesignV2.Motion.animation(
            duration: isExpanded ? DesignV2.Motion.state : DesignV2.Motion.feedback,
            reduceMotion: reduceMotion
        )
    }
}

struct DesignDisclosureButton<Label: View>: View {
    let isExpanded: Bool
    let accessibilityLabel: String
    let accessibilityId: String
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var hovered = false

    private var chevronRotation: Angle {
        guard isExpanded else { return .zero }
        return .degrees(layoutDirection == .leftToRight ? 90 : -90)
    }

    private var chevronHighlighted: Bool { isExpanded || hovered }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                label()
                Spacer(minLength: Space.sm)
                Image(systemName: "chevron.forward")
                    .font(.system(size: DesignDisclosureMetrics.chevronFontSize, weight: .medium))
                    .frame(width: DesignDisclosureMetrics.chevronSize, height: DesignDisclosureMetrics.chevronSize)
                    .foregroundStyle(chevronHighlighted ? DuskColors.accent : DuskColors.ink3)
                    .rotationEffect(chevronRotation)
                    .shadow(
                        color: chevronHighlighted
                            ? DuskColors.accent.opacity(isExpanded ? 0.55 : 0.48)
                            : .clear,
                        radius: DesignDisclosureMetrics.chevronGlowRadius
                    )
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: DesignDisclosureMetrics.rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(DesignDisclosureButtonStyle())
        .onHover { hovered = $0 }
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.feedback, reduceMotion: reduceMotion),
            value: hovered
        )
        .animation(
            DesignDisclosureMotion.animation(isExpanded: isExpanded, reduceMotion: reduceMotion),
            value: isExpanded
        )
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityIdentifier(accessibilityId)
    }
}

/// Stateful disclosure layout with a caller-owned Bool/action pair. The
/// trigger remains a native Button so existing Set-backed screen state and
/// independent sibling controls continue to own their mutations.
struct DesignDisclosureGroup<Header: View, Content: View>: View {
    let isExpanded: Bool
    @ViewBuilder let header: () -> Header
    @ViewBuilder let content: () -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        isExpanded: Bool,
        @ViewBuilder header: @escaping () -> Header,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.isExpanded = isExpanded
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header()
            if isExpanded {
                content()
                    .transition(
                        .asymmetric(
                            insertion: .modifier(
                                active: DesignDisclosureBodyTransition(
                                    y: DesignDisclosureMetrics.insertionOffset,
                                    opacity: 0
                                ),
                                identity: DesignDisclosureBodyTransition(y: 0, opacity: 1)
                            ),
                            removal: .modifier(
                                active: DesignDisclosureBodyTransition(
                                    y: DesignDisclosureMetrics.removalOffset,
                                    opacity: 0
                                ),
                                identity: DesignDisclosureBodyTransition(y: 0, opacity: 1)
                            )
                        )
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, isExpanded ? Space.sm : 0)
        .padding(.bottom, isExpanded ? DesignDisclosureMetrics.expandedDetailBottomPadding : 0)
        // The open details well is a background surface, not an interactive
        // layer, so the native header keeps the only disclosure target.
        .background {
            Color.clear
                .designWell(cornerRadius: Radii.md, showsBorder: false)
                .opacity(isExpanded ? 1 : 0)
        }
        .padding(.top, isExpanded ? Space.xs : 0)
        .padding(.bottom, isExpanded ? DesignDisclosureMetrics.expandedBottomMargin : 0)
        .animation(
            DesignDisclosureMotion.animation(isExpanded: isExpanded, reduceMotion: reduceMotion),
            value: isExpanded
        )
        .transaction { transaction in
            if reduceMotion {
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }
}

struct DesignMenuButton<MenuContent: View, Label: View>: View {
    let accessibilityLabel: String
    let accessibilityId: String?
    @ViewBuilder let menu: () -> MenuContent
    @ViewBuilder let label: () -> Label

    init(
        accessibilityLabel: String,
        accessibilityId: String? = nil,
        @ViewBuilder menu: @escaping () -> MenuContent,
        @ViewBuilder label: @escaping () -> Label
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityId = accessibilityId
        self.menu = menu
        self.label = label
    }

    var body: some View {
        Menu(content: menu, label: label)
            .accessibilityLabel(accessibilityLabel)
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct DesignDismissibleNotice: View {
    let kind: DesignNoticeKind
    let title: String
    var detail: String? = nil
    let accessibilityId: String
    let onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            AsyncNotice(kind: kind, title: title, detail: detail)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss \(title)")
        .accessibilityIdentifier(accessibilityId)
    }
}

struct DesignSelectableCard<Content: View>: View {
    let isSelected: Bool
    let accessibilityLabel: String
    let accessibilityId: String
    let action: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        Button(action: action) {
            content()
                .padding(Space.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .designPlate()
                .overlay {
                    RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
                        .stroke(isSelected ? DuskColors.accent : .clear, lineWidth: DesignMetrics.hairline)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityId)
    }
}

struct ValidatedField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    let validate: (String) -> String?

    var body: some View {
        DesignField(title: title, prompt: prompt, text: $text, error: validate(text))
    }
}

struct SecretValueField: View {
    let title: String
    @Binding var value: String
    var validationMessage: String? = nil

    var body: some View {
        DesignSecureField(title: title, text: $value, error: validationMessage)
    }
}

struct IdentityFieldGroup: View {
    @Binding var displayName: String
    @Binding var pin: String

    var body: some View {
        DesignPane(title: "Identity") {
            DesignField(title: "Display name", text: $displayName)
            DesignSecureField(title: "PIN", text: $pin)
                .keyboardType(.numberPad)
        }
    }
}

private enum DesignSearchFieldMetrics {
    static let labelGap: CGFloat = 7
    static let labelLineHeight = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal)
    // The browser's 40px minimum grows to its inherited line box plus vertical
    // padding. SwiftUI's centered hairline supplies the second CSS border edge.
    static let visualHeight = TypeScale.base * CGFloat(DesignV2.Typography.lineNormal)
        + 18
        + DesignMetrics.hairline
    static let focusCastRadius: CGFloat = 18
    static let focusCastSourceInset: CGFloat = 14
}

struct DesignSearchField: View {
    let title: String
    let prompt: String
    @Binding var query: String
    var accessibilityId: String? = nil
    var onClear: (() -> Void)? = nil
    var textFont: Font = Typo.ui(TypeScale.base)
    var leadingPadding: CGFloat = Space.md
    var trailingPadding: CGFloat = Space.md
    var focused: FocusState<Bool>.Binding? = nil
    @FocusState private var internalFocused: Bool

    init(
        prompt: String,
        query: Binding<String>,
        accessibilityId: String? = nil,
        onClear: (() -> Void)? = nil,
        textFont: Font = Typo.ui(TypeScale.base),
        leadingPadding: CGFloat = Space.md,
        trailingPadding: CGFloat = Space.md,
        title: String = "Search",
        focused: FocusState<Bool>.Binding? = nil
    ) {
        self.title = title
        self.prompt = prompt
        _query = query
        self.accessibilityId = accessibilityId
        self.onClear = onClear
        self.textFont = textFont
        self.leadingPadding = leadingPadding
        self.trailingPadding = trailingPadding
        self.focused = focused
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSearchFieldMetrics.labelGap) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                .foregroundStyle(DuskColors.ink)
                .frame(minHeight: DesignSearchFieldMetrics.labelLineHeight)
            fieldSurface
        }
    }

    @ViewBuilder
    private var fieldSurface: some View {
        HStack(spacing: Space.sm) {
            focusableInput
            if let onClear, !query.isEmpty {
                DesignCompactIconButton(
                    systemName: "xmark.circle.fill",
                    label: "Clear search",
                    accessibilityId: accessibilityId.map { "\($0)-clear" },
                    action: onClear
                )
                .foregroundStyle(DuskColors.ink3)
            }
        }
        .padding(.leading, leadingPadding)
        .padding(.trailing, trailingPadding)
        .frame(minHeight: DesignSearchFieldMetrics.visualHeight)
        .designWell(focused: false)
        .background { focusBackground }
        .overlay { focusOverlay }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var focusBackground: some View {
        if isFocused {
            let shape = RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
            ZStack {
                shape.stroke(
                    DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusRingOpacity),
                    lineWidth: DesignMetrics.focusRing * 2
                )
                DesignSpreadShadow(
                    shape: shape,
                    color: DuskColors.accent.opacity(DesignMaterialAdapter.wellFocusCastOpacity),
                    geometry: DesignDropShadowGeometry(
                        radius: DesignSearchFieldMetrics.focusCastRadius,
                        y: DesignMaterialAdapter.wellFocusCastY,
                        sourceInset: DesignSearchFieldMetrics.focusCastSourceInset
                    )
                )
            }
        }
    }

    @ViewBuilder
    private var focusOverlay: some View {
        if isFocused {
            RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                .stroke(
                    DuskColors.accent.overlaying(
                        DuskColors.line,
                        opacity: DesignMaterialAdapter.wellFocusMix
                    ),
                    lineWidth: DesignMetrics.hairline
                )
            RoundedRectangle(
                cornerRadius: Radii.sm + DesignMetrics.focusRing,
                style: .continuous
            )
            .stroke(DuskColors.accent, lineWidth: DesignMetrics.focusBorder)
            .padding(DesignMetrics.focusBorderInset - DesignMetrics.hairline)
        }
    }

    @ViewBuilder
    private var focusableInput: some View {
        if let focused {
            input.focused(focused)
        } else {
            input.focused($internalFocused)
        }
    }

    private var input: some View {
        TextField(
            "",
            text: $query,
            prompt: Text(prompt).foregroundStyle(DuskColors.ink3)
        )
        .font(textFont)
        .foregroundStyle(DuskColors.ink)
        .textFieldStyle(.plain)
        .submitLabel(.search)
        .accessibilityLabel(title)
        .accessibilityValue(query.isEmpty ? "Empty" : query)
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct SearchFilterRow<Filters: View>: View {
    let prompt: String
    @Binding var query: String
    var accessibilityId: String? = nil
    @ViewBuilder let filters: () -> Filters

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignSearchField(prompt: prompt, query: $query)
            filters()
        }
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

struct AsyncNotice: View {
    let kind: DesignNoticeKind
    let title: String
    var detail: String? = nil
    var retry: (() -> Void)? = nil
    var accessibilityId: String? = nil

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            symbol
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(TypeScale.base, .semibold))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2) }
                if let retry {
                    DesignActionButton(title: "Retry", role: .quiet, accessibilityId: nil, action: retry)
                }
            }
            Spacer()
        }
        .padding(Space.md)
        .designPlate()
        .accessibilityElement(children: retry == nil ? .combine : .contain)
        .accessibilityLabel(title)
        .accessibilityValue(detail ?? kind.accessibilityValue)
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    @ViewBuilder
    private var symbol: some View {
        switch kind {
        case .loading: ProgressView().tint(DuskColors.accent).accessibilityHidden(true)
        case .empty: Image(systemName: "tray").accessibilityHidden(true)
        case .error: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(DuskColors.stop).accessibilityHidden(true)
        case .success: Image(systemName: "checkmark.circle.fill").foregroundStyle(DuskColors.ok).accessibilityHidden(true)
        case .warning: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(DuskColors.warn).accessibilityHidden(true)
        }
    }
}

private extension DesignNoticeKind {
    var accessibilityValue: String {
        switch self {
        case .loading: "Loading"
        case .empty: "Empty"
        case .error: "Error"
        case .success: "Success"
        case .warning: "Warning"
        }
    }
}

struct DesignToolbarButton: View {
    let title: String
    var isEnabled = true
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(isEnabled ? DuskColors.accent : DuskColors.ink4)
            .disabled(!isEnabled)
            .accessibilityIdentifier(accessibilityId)
            .accessibilityValue(isEnabled ? "Ready" : "Disabled")
    }
}

struct DesignToolbarIconButton: View {
    let systemName: String
    let label: String
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink2)
        }
        .accessibilityLabel(label)
        .accessibilityIdentifier(accessibilityId)
    }
}

struct DesignTextButton: View {
    let title: String
    var role: DesignButtonRole = .quiet
    var state: DesignControlState = .normal
    var accessibilityId: String? = nil
    let action: () -> Void

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            Text(title)
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(tint)
                .frame(minHeight: DesignMetrics.minimumTarget)
        }
        .buttonStyle(.plain)
        .disabled(!state.isInteractive)
        .accessibilityLabel(title)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityAddTraits(state.isSelected ? .isSelected : [])
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var tint: Color {
        switch role {
        case .action: DuskColors.accent
        case .secondary: DuskColors.ink
        case .destructive: DuskColors.stop
        case .quiet: DuskColors.ink2
        }
    }
}

struct DesignActionFooter<Leading: View>: View {
    @ViewBuilder let leading: () -> Leading
    let actionTitle: String
    var state: DesignControlState = .normal
    let action: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            leading()
            Spacer()
            DesignActionButton(title: actionTitle, state: state, action: action)
        }
        .padding(.vertical, Space.sm)
    }
}

enum DesignApplyState: Equatable {
    case idle
    case saving
    case restarting
    case alreadyApplying
    case applied
    case failed(String)
}

struct DesignApplyFeedback: View {
    let state: DesignApplyState
    var successMessage: String? = nil

    @ViewBuilder
    var body: some View {
        switch state {
        case .idle:
            EmptyView()
        case .saving:
            AsyncNotice(kind: .loading, title: "Saving…", accessibilityId: "settings-applying")
        case .restarting:
            AsyncNotice(kind: .loading, title: "Applying — assistant restarting…", accessibilityId: "settings-applying")
        case .alreadyApplying:
            AsyncNotice(
                kind: .warning,
                title: "Another change is applying",
                detail: "Try again in a moment.",
                accessibilityId: "settings-notice"
            )
        case .applied:
            AsyncNotice(kind: .success, title: successMessage ?? "Changes applied")
        case .failed(let message):
            AsyncNotice(kind: .error, title: message, accessibilityId: "settings-error")
        }
    }
}

/// Backward-compatible small feedback API. Full apply phases use
/// `DesignApplyFeedback` so the notice rendering remains in one place.
struct SaveApplyFeedback: View {
    let state: DesignControlState
    var successMessage: String? = nil

    @ViewBuilder
    var body: some View {
        switch state {
        case .normal:
            if let successMessage { AsyncNotice(kind: .success, title: successMessage) }
        case .loading:
            AsyncNotice(kind: .loading, title: "Applying changes")
        case .error(let message):
            AsyncNotice(kind: .error, title: "Couldn't apply changes", detail: message)
        case .selected, .on, .disabled:
            EmptyView()
        }
    }
}

#Preview("Foundation states") {
    @Previewable @State var text = ""
    @Previewable @State var enabled = true
    ScrollView {
        VStack(spacing: Space.lg) {
            DesignField(title: "Name", prompt: "Name", text: $text)
            DesignField(title: "Name", text: $text, error: "Required")
            DesignToggleRow(title: "Enabled", isOn: $enabled)
            DesignActionButton(title: "Save", action: {})
            DesignActionButton(title: "Delete", role: .destructive, action: {})
            DesignActionButton(title: "Save", state: .loading, action: {})
            AsyncNotice(kind: .empty, title: "Nothing here")
            ElevatedUserAvatar(name: "Ada Lovelace", selected: true)
        }
        .padding(Space.lg)
    }
    .frame(width: DesignMetrics.narrowPreviewWidth)
    .environment(\.dynamicTypeSize, .accessibility3)
    .transaction { $0.disablesAnimations = true }
    .preferredColorScheme(.dark)
}

#Preview("All primitive states — increased contrast simulator") {
    @Previewable @State var text = "Secret"
    @Previewable @State var toggle = false
    @Previewable @State var segment = "one"
    @Previewable @State var slider = 0.4
    ScrollView {
        VStack(spacing: Space.md) {
            DesignCardPreview()
            DesignSecureField(title: "Secret", text: $text)
            DesignMultilineEditor(title: "Notes", text: $text, error: "Required")
            DesignToggleRow(title: "Toggle", isOn: $toggle)
            DesignSegmentedPicker(title: "Mode", options: [("one", "One"), ("two", "Two")], selection: $segment)
            DesignSelect(title: "Select", options: [("one", "One"), ("two", "Two")], selection: $segment)
            DesignSlider(title: "Amount", value: $slider, range: 0...1)
            DesignChip(title: "Selected chip", selected: true, action: {})
            DesignCheckbox(title: "Checkbox", isOn: $toggle)
            DesignProgress(title: "Loading")
            DesignDivider()
            HStack {
                DesignIconButton(systemName: "plus", label: "Add", action: {})
                DesignActionButton(title: "Disabled", state: .disabled, action: {})
                DesignActionButton(title: "Error", state: .error("Failed"), action: {})
            }
        }
        .padding(Space.md)
    }
    .frame(width: DesignMetrics.narrowPreviewWidth)
    .preferredColorScheme(.dark)
}

private struct DesignCardPreview: View {
    var body: some View {
        HStack {
            Text("Plate").font(Typo.ui(TypeScale.base))
            Spacer()
            Text("Well").font(Typo.ui(TypeScale.base)).padding(Space.sm).designWell(focused: true)
        }
        .padding(Space.md)
        .designPlate(elevated: true)
    }
}

#Preview("iPad foundation") {
    DesignPane(title: "Settings", detail: "Common controls") {
        AsyncNotice(kind: .loading, title: "Loading")
    }
    .padding(Space.xl)
    .frame(width: DesignMetrics.padPreviewWidth)
    .preferredColorScheme(.dark)
}
