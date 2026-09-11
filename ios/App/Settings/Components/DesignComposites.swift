import CoreGraphics
import SwiftUI

private enum DesignPageHeaderMetrics {
    static let minimumHeight: CGFloat = 68
}

struct DesignPageHeader<Actions: View>: View {
    let title: String
    let subtitle: String?
    let showsBack: Bool
    let backAccessibilityId: String?
    let onBack: (() -> Void)?
    @ViewBuilder let actions: () -> Actions

    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        title: String,
        subtitle: String? = nil,
        showsBack: Bool = true,
        backAccessibilityId: String? = nil,
        onBack: (() -> Void)? = nil,
        @ViewBuilder actions: @escaping () -> Actions
    ) {
        self.title = title
        self.subtitle = subtitle
        self.showsBack = showsBack
        self.backAccessibilityId = backAccessibilityId
        self.onBack = onBack
        self.actions = actions
    }

    var body: some View {
        Group {
            if Actions.self == EmptyView.self {
                headingRow
            } else if dynamicTypeSize.isAccessibilitySize {
                stackedContent
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: Space.sm) {
                        // Test the complete intrinsic heading and controls,
                        // rather than accepting a row with compressed labels.
                        headingRow.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: Space.sm)
                        actionFlow.fixedSize(horizontal: true, vertical: false)
                    }
                    stackedContent
                }
            }
        }
        .padding(.horizontal, Space.sm)
        .padding(.vertical, Space.md)
        .frame(maxWidth: .infinity, minHeight: DesignPageHeaderMetrics.minimumHeight, alignment: .leading)
        .background(DuskColors.bgElev)
        .overlay(alignment: .bottom) { DesignDivider() }
        .accessibilityElement(children: .contain)
    }

    private var stackedContent: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            headingRow
            actionFlow
        }
    }

    private var actionFlow: some View {
        // Native layout preserves natural control widths, wraps separate
        // actions, and proposes the row width to an oversized localized label.
        CenteredFlowLayout(
            spacing: Space.sm,
            alignment: .trailing
        ) {
            actions()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headingRow: some View {
        HStack(alignment: dynamicTypeSize.isAccessibilitySize ? .top : .center, spacing: Space.sm) {
            if showsBack {
                backButton.fixedSize()
            }
            heading
        }
    }

    private var backButton: some View {
        DesignIconButton(
            systemName: "chevron.backward",
            label: "Back",
            accessibilityId: backAccessibilityId,
            action: performBack
        )
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(TypeScale.lg, .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            if let subtitle {
                Text(subtitle)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
            }
        }
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func performBack() {
        if let onBack {
            onBack()
        } else {
            dismiss()
        }
    }
}

extension DesignPageHeader where Actions == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        showsBack: Bool = true,
        backAccessibilityId: String? = nil,
        onBack: (() -> Void)? = nil
    ) {
        self.init(
            title: title,
            subtitle: subtitle,
            showsBack: showsBack,
            backAccessibilityId: backAccessibilityId,
            onBack: onBack
        ) {
            EmptyView()
        }
    }
}

struct DesignPageChrome<Content: View>: View {
    let title: String
    let accessibilityId: String
    let bottomPadding: CGFloat
    let showsBack: Bool
    let onBack: (() -> Void)?
    let allowsInteractiveBack: Bool
    let backAccessibilityId: String?
    @ViewBuilder let content: () -> Content

    init(
        title: String,
        accessibilityId: String,
        bottomPadding: CGFloat = Space.md,
        showsBack: Bool = true,
        onBack: (() -> Void)? = nil,
        allowsInteractiveBack: Bool = true,
        backAccessibilityId: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.accessibilityId = accessibilityId
        self.bottomPadding = bottomPadding
        self.showsBack = showsBack
        self.onBack = onBack
        self.allowsInteractiveBack = allowsInteractiveBack
        self.backAccessibilityId = backAccessibilityId
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            DesignPageHeader(
                title: title,
                showsBack: showsBack,
                backAccessibilityId: backAccessibilityId,
                onBack: onBack
            )
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) { content() }
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.md)
                    .padding(.bottom, bottomPadding)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .background(DuskColors.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(!showsBack || !allowsInteractiveBack)
        .nativeInteractiveBackNavigation(isEnabled: showsBack && allowsInteractiveBack)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityId)
        .duskTheme()
    }
}

enum DesignCardHeaderStyle { case elevated, quiet }
enum DesignCardBodyStyle { case rows, settingsGroup, padded }

private enum DesignSettingsGroupMetrics {
    // Source `.cmp-setting-row` minimum, including its responsive content air.
    static let rowHeight: CGFloat = 70
    static let selectWidth: CGFloat = 180
    static let rangeWidth: CGFloat = 210
}

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
                .overlay(alignment: .bottom) { DesignDivider() }
        } else {
            VStack(alignment: .leading, spacing: Space.md) {
                headerContent
                DesignDivider()
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md)
        }
    }

    private var headerContent: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title ?? "")
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
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
        case .settingsGroup:
            Group(subviews: content()) { subviews in
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(subviews) { subview in
                        subview
                            .frame(
                                maxWidth: .infinity,
                                minHeight: DesignSettingsGroupMetrics.rowHeight,
                                alignment: .leading
                            )
                        if subview.id != subviews.last?.id {
                            DesignDivider()
                        }
                    }
                }
                .padding(.horizontal, Space.lg)
            }
        case .padded:
            VStack(alignment: .leading, spacing: Space.md, content: content)
                .padding(Space.lg)
        }
    }
}

enum DesignSettingsEditorState: Equatable {
    case saved
    case unsaved

    var title: String {
        switch self {
        case .saved: "Saved"
        case .unsaved: "Unsaved"
        }
    }

    var tint: Color {
        switch self {
        case .saved: DuskColors.sage
        case .unsaved: DuskColors.accent
        }
    }
}

private enum DesignSettingsEditorMetrics {
    static let headerMinimumHeight: CGFloat = 70
    static let bodyGap: CGFloat = 14
    static let statusHorizontalPadding: CGFloat = 10
    static let statusVerticalPadding: CGFloat = 6
}

/// Full-measure settings editor shell. Draft, validation, focus, reset, and
/// persistence remain caller-owned; this view only composes their native views.
struct DesignSettingsEditor<Content: View, Actions: View>: View {
    let title: String
    let detail: String
    let state: DesignSettingsEditorState?
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        title: String,
        detail: String,
        state: DesignSettingsEditorState? = nil,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder actions: @escaping () -> Actions
    ) {
        self.title = title
        self.detail = detail
        self.state = state
        self.content = content
        self.actions = actions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            VStack(alignment: .leading, spacing: DesignSettingsEditorMetrics.bodyGap) {
                content()
            }
            .padding(Space.lg)
            if Actions.self != EmptyView.self { footer }
        }
        .designPlate()
    }

    @ViewBuilder
    private var header: some View {
        let copy = VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .foregroundStyle(DuskColors.ink)
            Text(detail)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Space.sm) {
                    copy
                    status
                }
            } else {
                HStack(alignment: .center, spacing: Space.md) {
                    copy
                    status
                }
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .frame(maxWidth: .infinity, minHeight: DesignSettingsEditorMetrics.headerMinimumHeight)
        .overlay(alignment: .bottom) { DesignDivider() }
    }

    @ViewBuilder
    private var status: some View {
        if let state {
            Text(state.title)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(state.tint)
                .padding(.horizontal, DesignSettingsEditorMetrics.statusHorizontalPadding)
                .padding(.vertical, DesignSettingsEditorMetrics.statusVerticalPadding)
                .background {
                    DesignCompositeRaisedCanvasBackground(
                        shape: .capsule,
                        role: .quiet,
                        state: state == .saved ? .disabled : .rest
                    )
                }
                .fixedSize()
                .accessibilityLabel(state.title)
        }
    }

    private var footer: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Space.sm) { actions() }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: Space.sm) {
                    Spacer(minLength: 0)
                    actions()
                }
            }
        }
        .padding(.horizontal, Space.lg)
        .padding(.vertical, Space.md)
        .background(DuskColors.paper.overlaying(DuskColors.bgSunk, opacity: 0.25))
        .overlay(alignment: .top) { DesignDivider() }
    }
}

extension DesignSettingsEditor where Actions == EmptyView {
    init(
        title: String,
        detail: String,
        state: DesignSettingsEditorState? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, detail: detail, state: state, content: content) {
            EmptyView()
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

enum DesignResultsListItemTone {
    case terra, sage
}

struct DesignResultsListItem: Identifiable {
    let id: String
    let leading: String
    let title: String
    let detail: String
    var tone: DesignResultsListItemTone = .terra
    let action: () -> Void
}

/// A bounded summary and incremental result collection whose rows are plain
/// native actions. Selectable rows and rows with nested actions use their own
/// product components rather than adding selection state to this contract.
struct DesignResultsList: View {
    let countLabel: String
    let summary: String
    let clearLabel: String
    let items: [DesignResultsListItem]
    let pageLabel: String
    let previousLabel: String
    let loadMoreLabel: String
    let loadingLabel: String
    var previousDisabled = false
    var loadingMore = false
    let onClear: () -> Void
    let onPrevious: () -> Void
    let onLoadMore: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var compact: Bool { horizontalSizeClass == .compact }
    private var actionVisualHeight: CGFloat {
        compact ? DesignMetrics.minimumTarget : DesignMetrics.actionButtonVisualHeight
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            DesignDivider()
            rows
            DesignDivider()
            pagination
        }
        .designPlate()
    }

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.md) {
                summaryView
                Spacer(minLength: 0)
                clearButton
            }
            VStack(alignment: .leading, spacing: Space.sm) {
                summaryView
                clearButton
            }
        }
        .padding(.horizontal, 14)
        // The compact source key grows from 40pt to 44pt inside a bordered
        // 69pt header; the half-point keeps that native 2x border box integral.
        .padding(.vertical, compact ? 12.5 : 11)
        .frame(minHeight: 66, alignment: .leading)
    }

    private var summaryView: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(countLabel)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .bold))
                .foregroundStyle(DuskColors.ink)
            Text(summary)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
        }
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private var clearButton: some View {
        DesignActionButton(
            title: clearLabel,
            role: .quiet,
            fillsWidth: false,
            action: onClear,
            visualHeight: actionVisualHeight
        )
    }

    private var rows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                resultRow(item)
                    .overlay(alignment: .bottom) {
                        if index < items.count - 1 { DesignDivider() }
                    }
                    .transition(
                        reduceMotion
                            ? .identity
                            : .offset(y: Space.sm).combined(with: .opacity)
                    )
            }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: items.map(\.id)
        )
        .accessibilityElement(children: .contain)
    }

    private func resultRow(_ item: DesignResultsListItem) -> some View {
        Button(action: item.action) {
            HStack(spacing: 11) {
                resultIcon(item)
                    .frame(width: 42)
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.title)
                        .font(Typo.ui(DesignMetrics.controlLabelSize, .bold))
                        .foregroundStyle(DuskColors.ink)
                    Text(item.detail)
                        .font(Typo.ui(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink2)
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.forward")
                    .font(Typo.ui(TypeScale.base, .medium))
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            .padding(9)
            .frame(maxWidth: .infinity, minHeight: 66, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(item.title)
        .accessibilityValue(item.detail)
    }

    private func resultIcon(_ item: DesignResultsListItem) -> some View {
        Text(item.leading)
            .font(Typo.display(TypeScale.lg))
            .foregroundStyle(item.tone == .sage ? DuskColors.sage : DuskColors.accent)
            .frame(width: 38, height: 38)
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                DesignCompositeRaisedCanvasBackground(
                    shape: .continuousRoundedRectangle(cornerRadius: Radii.sm),
                    role: .quiet,
                    state: .disabled
                )
            }
            .accessibilityHidden(true)
    }

    private var pagination: some View {
        ViewThatFits(in: .horizontal) {
            paginationRow
            VStack(spacing: Space.sm) {
                Text(pageLabel)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                HStack(spacing: Space.sm) {
                    previousButton
                    loadMoreButton
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 64, alignment: .trailing)
    }

    private var paginationRow: some View {
        HStack(spacing: 10) {
            Spacer(minLength: 0)
            previousButton
            Text(pageLabel)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
                .fixedSize()
            loadMoreButton
        }
    }

    private var previousButton: some View {
        DesignActionButton(
            title: previousLabel,
            role: .quiet,
            state: previousDisabled ? .disabled : .normal,
            fillsWidth: false,
            action: onPrevious,
            visualHeight: actionVisualHeight
        )
    }

    private var loadMoreButton: some View {
        DesignActionButton(
            title: loadingMore ? loadingLabel : loadMoreLabel,
            role: .secondary,
            state: loadingMore ? .disabled : .normal,
            fillsWidth: false,
            action: onLoadMore,
            visualHeight: actionVisualHeight
        )
    }
}

private struct DominantVisualCardButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var focused
    let hovered: Bool
    let quietHoverBorder: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let raised = hovered && isEnabled && !pressed
        let shape = RoundedRectangle(cornerRadius: Radii.lg, style: .continuous)

        configuration.label
            .clipShape(shape)
            .background {
                DesignCanvasSurfaceKernel(
                    shape: .continuousRoundedRectangle(cornerRadius: Radii.lg),
                    tier: raised ? .float : .plate,
                    increasedContrast: contrast == .increased
                )
            }
            .overlay {
                shape.strokeBorder(
                    focused
                        ? DuskColors.accent
                        : contrast == .increased
                            ? DuskColors.ink3
                            : hovered && !quietHoverBorder ? DuskColors.line : .clear,
                    lineWidth: DesignMetrics.hairline
                )
            }
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .opacity(isEnabled ? 1 : 0.58)
            // Touch-down is immediate; only pointer hover gets a transition.
            .animation(
                DesignV2.Motion.animation(
                    duration: DesignV2.Motion.state,
                    reduceMotion: reduceMotion
                ),
                value: raised
            )
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
                .clipShape(RoundedRectangle(cornerRadius: Radii.xl, style: .continuous))
                .background {
                    DesignCompositeWellCanvasBackground(
                        shape: .continuousRoundedRectangle(cornerRadius: Radii.xl),
                        isEnabled: true,
                        isFocused: false,
                        profile: .standard
                    )
                }

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

/// PIN input can be semantically disabled while authentication is in flight,
/// but its material remains at rest as in the reviewed completion sequence.
private struct DesignPinKeyButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isFocused) private var focused
    @Environment(\.colorSchemeContrast) private var contrast

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && isEnabled
        let cornerRadius = Radii.md
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .circular)
        let state = DesignCanvasControlState(isPressed: pressed, isFocused: focused)

        configuration.label
            .font(.custom(DesignTypographyAdapter.uiMediumFace, size: TypeScale.lg, relativeTo: .headline))
            .foregroundStyle(DuskColors.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(shape)
            .background {
                DesignCanvasKernel(
                    shape: .roundedRectangle(cornerRadius: cornerRadius),
                    role: .secondary,
                    state: state,
                    increasedContrast: contrast == .increased,
                    reduceMotion: reduceMotion,
                    baseColor: DuskColors.paper
                )
                .animation(
                    DesignCanvasKernel.transitionAnimation(for: .focus, reduceMotion: reduceMotion),
                    value: state.isFocused
                )
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .offset(y: pressed ? DesignMetrics.pressedDepth : 0)
            .animation(
                reduceMotion ? nil : .timingCurve(0.25, 0.1, 0.25, 1, duration: 0.09),
                value: pressed
            )
            .contentShape(shape)
    }
}

private struct DesignPinKey<Label: View>: View {
    let accessibilityLabel: String
    let accessibilityId: String
    let disabled: Bool
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button(action: action) {
            label()
                .accessibilityHidden(true)
        }
        .buttonStyle(DesignPinKeyButtonStyle())
        .disabled(disabled)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityIdentifier(accessibilityId)
        .aspectRatio(1, contentMode: .fit)
    }
}

private enum DesignPinKeypadState {
    static let length = 4
    static let checkingCycle: TimeInterval = 0.9
    // Source `.cmp-pin` spacing; the surrounding card owns its 18pt padding.
    static let sectionGap: CGFloat = 14
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
    /// Explicit only for previews/capture; production follows the system value.
    var reducedMotionOverride: Bool? = nil
    var statusAccessibilityId = "pin-status"
    let onDigit: (Character) -> Void
    let onDelete: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var errorReady = true
    @State private var checkingStartedAt: Date?

    private static let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"]

    private var isChecking: Bool { isSubmitting && success == nil && error == nil }
    private var keyDisabled: Bool { isSubmitting || success != nil || (error != nil && !errorReady) }
    private var shouldReduceMotion: Bool { reducedMotionOverride ?? reduceMotion }
    private var status: String {
        if let success { return success }
        if let error { return error }
        if isSubmitting { return "Checking Pin…" }
        if entered > 0 { return "\(entered) of \(DesignPinKeypadState.length) digits entered." }
        return "Enter your \(DesignPinKeypadState.length)-digit Pin."
    }

    var body: some View {
        VStack(spacing: DesignPinKeypadState.sectionGap) {
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
        .onAppear {
            if isChecking { checkingStartedAt = Date() }
        }
        .onChange(of: isChecking) { _, checking in
            checkingStartedAt = checking ? Date() : nil
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
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !isChecking || shouldReduceMotion)) { context in
            let elapsed = checkingStartedAt.map { max(0, context.date.timeIntervalSince($0)) } ?? 0
            let cycleProgress = elapsed
                .truncatingRemainder(dividingBy: DesignPinKeypadState.checkingCycle)
                / DesignPinKeypadState.checkingCycle
            // Cosine interpolation matches the source ease-in-out endpoints:
            // rest at 0/900ms and maximum contraction at 450ms.
            let phase = (1 - cos(cycleProgress * 2 * .pi)) / 2
            HStack(spacing: Space.md) {
                ForEach(0..<DesignPinKeypadState.length, id: \.self) { index in
                    dot(index: index, phase: phase)
                }
            }
            .modifier(PinShakeEffect(animatableData: shouldReduceMotion ? 0 : CGFloat(errorRevision)))
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: shouldReduceMotion), value: errorRevision)
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
            DesignPinKey(
                accessibilityLabel: "Delete last digit",
                accessibilityId: "pin-delete",
                disabled: keyDisabled,
                action: onDelete
            ) {
                Image(systemName: "delete.left")
            }
        } else {
            DesignPinKey(
                accessibilityLabel: key,
                accessibilityId: "pin-key-\(key)",
                disabled: keyDisabled,
                action: { onDigit(Character(key)) }
            ) {
                Text(key)
            }
        }
    }

    private var statusColor: Color {
        if error != nil { return DuskColors.stop }
        return DuskColors.ink2
    }

    @ViewBuilder
    private func dot(index: Int, phase: Double) -> some View {
        let scale = isChecking && !shouldReduceMotion
            ? 1 - (0.28 * phase)
            : entered > index ? 1.06 : 1
        let opacity = isChecking && !shouldReduceMotion ? 1 - (0.35 * phase) : 1
        dotFace(index: index)
            .frame(width: DesignMetrics.pinDotSize, height: DesignMetrics.pinDotSize)
            .overlay(Circle().strokeBorder(dotBorder(index: index), lineWidth: DesignMetrics.hairline))
            .background {
                Canvas { context, size in
                    var context = context
                    let face = CGRect(x: 15, y: 15, width: size.width - 30, height: size.height - 30)
                    DesignCanvasEffects.outerShadow(
                        in: &context,
                        sourcePath: Circle().path(in: face.insetBy(dx: 3, dy: 3)),
                        color: error != nil ? DuskColors.stop.opacity(0.8) : DuskColors.accent,
                        blur: 10
                    )
                }
                .padding(-15)
                .opacity(success == nil && (entered > index || error != nil) ? 1 : 0)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .scaleEffect(scale)
            .opacity(opacity)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: shouldReduceMotion), value: entered)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: shouldReduceMotion), value: success != nil)
    }

    @ViewBuilder
    private func dotFace(index: Int) -> some View {
        if success != nil {
            Circle().fill(DuskColors.ok)
        } else if error != nil {
            Circle().fill(DuskColors.stop)
        } else if entered > index {
            Circle().fill(DuskColors.accent)
        } else {
            Color.clear
                .background {
                    DesignCompositeWellCanvasBackground(
                        shape: .circle,
                        isEnabled: true,
                        isFocused: false,
                        profile: .standard
                    )
                }
        }
    }

    private func dotBorder(index: Int) -> Color {
        if success != nil { return DuskColors.ok }
        if error != nil { return DuskColors.stop.opacity(0.74) }
        return entered > index ? DuskColors.accent.opacity(0.62) : DuskColors.line
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
            stackedContent
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: Space.lg) {
                    labelContent.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    accessory().fixedSize(horizontal: true, vertical: false)
                }
                stackedContent
            }
        }
    }

    private var stackedContent: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            labelContent
            accessory()
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    @ViewBuilder
    private var labelContent: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .designText(.label)
                .fontWeight(.medium)
                .foregroundStyle(DuskColors.ink)
            if let detail {
                Text(detail)
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }
}

struct DesignSettingsSelectRow<Value: Hashable>: View {
    let title: String
    var detail: String? = nil
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil

    var body: some View {
        DesignSettingsRow(title: title, detail: detail) {
            Menu {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    Button {
                        selection = option.value
                    } label: {
                        if option.value == selection {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
            } label: {
                DesignMenuTriggerLabel(
                    currentLabel: currentLabel,
                    isEnabled: true,
                    width: .flexible(minimum: 0)
                )
            }
            .frame(maxWidth: DesignSettingsGroupMetrics.selectWidth)
            .accessibilityLabel(title)
            .accessibilityValue(currentLabel)
            .accessibilityHint(detail ?? "")
            .accessibilityIdentifier(accessibilityId ?? "")
        }
    }

    private var currentLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Select…"
    }

}

struct DesignSettingsSliderRow: View {
    let title: String
    var detail: String? = nil
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1
    let format: (Double) -> String
    var accessibilityId: String? = nil

    var body: some View {
        DesignSettingsRow(title: title, detail: detail) {
            HStack(spacing: Space.md) {
                DesignSliderControlBody(
                    value: $value,
                    range: range,
                    step: step,
                    accessibilityLabel: title,
                    accessibilityValue: format(value),
                    accessibilityHint: detail ?? "",
                    accessibilityId: accessibilityId ?? ""
                )
                Text(format(value))
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(minWidth: DesignMetrics.sliderOutputWidth, alignment: .trailing)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: DesignSettingsGroupMetrics.rangeWidth)
            .frame(minHeight: DesignMetrics.minimumTarget)
        }
    }
}

struct DesignGroupHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .designText(.caption)
            .fontWeight(.semibold)
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
                    .designText(.label)
                    .fontWeight(.medium)
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.system(size: TypeScale.xs, weight: .semibold))
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, Space.xs)
            .frame(minHeight: DesignMetrics.minimumTarget)
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
            DesignCompositeWellCanvasBackground(
                shape: .continuousRoundedRectangle(cornerRadius: Radii.md),
                isEnabled: true,
                isFocused: false,
                profile: .standard
            )
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

/// Background-only raised material for decorative composite marks. Native
/// buttons continue to own interaction state; status and identity marks remain
/// accessibility-hidden and carry no actions of their own.
private struct DesignCompositeRaisedCanvasBackground: View {
    let shape: DesignCanvasShape
    let role: DesignButtonRole
    let state: DesignCanvasControlState

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        DesignCanvasKernel(
            shape: shape,
            role: role,
            state: state,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
        .animation(
            DesignCanvasKernel.transitionAnimation(
                for: .material,
                reduceMotion: reduceMotion
            ),
            value: state
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Stable projection from native composite state into the decorative well.
/// The renderer receives only interaction booleans and the reviewed semantic
/// profile; text, validation messages, and accessibility content remain owned
/// by the native composite.
struct DesignCompositeWellCanvasProjection: Equatable {
    let state: DesignCanvasWellState
    let increasedContrast: Bool
    let reduceMotion: Bool

    static func make(
        isEnabled: Bool,
        isFocused: Bool,
        profile: DesignCanvasWellProfile,
        increasedContrast: Bool,
        reduceMotion: Bool
    ) -> DesignCompositeWellCanvasProjection {
        DesignCompositeWellCanvasProjection(
            state: DesignCanvasWellState(
                isFocused: isFocused,
                isDisabled: !isEnabled,
                profile: profile
            ),
            increasedContrast: increasedContrast,
            reduceMotion: reduceMotion
        )
    }
}

/// Background-only adapter shared by the Wave 2B composite receivers. Native
/// TextField/TextEditor/Button views remain outside this renderer and retain
/// responder, selection, keyboard, hit-testing, and accessibility ownership.
private struct DesignCompositeWellCanvasBackground: View {
    var shape: DesignCanvasShape = .roundedRectangle(cornerRadius: Radii.sm)
    let isEnabled: Bool
    let isFocused: Bool
    let profile: DesignCanvasWellProfile

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var projection: DesignCompositeWellCanvasProjection {
        DesignCompositeWellCanvasProjection.make(
            isEnabled: isEnabled,
            isFocused: isFocused,
            profile: profile,
            increasedContrast: contrast == .increased,
            reduceMotion: reduceMotion
        )
    }

    var body: some View {
        DesignCanvasWellKernel(
            shape: shape,
            state: projection.state,
            increasedContrast: projection.increasedContrast,
            reduceMotion: projection.reduceMotion
        )
        .animation(
            DesignCanvasWellKernel.transitionAnimation(
                for: .focus,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isFocused
        )
        .animation(
            DesignCanvasWellKernel.transitionAnimation(
                for: .material,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.profile
        )
        .animation(
            DesignCanvasWellKernel.transitionAnimation(
                for: .material,
                reduceMotion: projection.reduceMotion
            ),
            value: projection.state.isDisabled
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}


enum ValidatedFieldStatus: Equatable {
    case valid(String)
    case error(String)

    var message: String {
        switch self {
        case .valid(let message), .error(let message): message
        }
    }

    var isError: Bool {
        switch self {
        case .valid: false
        case .error: true
        }
    }
}

struct ValidatedFieldCounter: Equatable {
    let current: Int
    let max: Int
    var unit: String = "characters"

    var displayText: String { "\(current) of \(max) \(unit)" }
}

private enum ValidatedFieldMetrics {
    static let labelGap: CGFloat = 7
    static let labelLineHeight = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal)
    static let visualHeight = TypeScale.base * CGFloat(DesignV2.Typography.lineNormal) + 18 + DesignMetrics.hairline
    static let editorVerticalInset: CGFloat = 3
}

/// A caller-owned validation composite over native text inputs. Validation is
/// deliberately supplied as state or the compatibility `validate` closure;
/// this view does not choose when validation runs.
struct ValidatedField: View {
    let title: String
    var prompt: String = ""
    @Binding var text: String
    var placeholder: String? = nil
    var validate: ((String) -> String?)? = nil
    var error: String? = nil
    var status: ValidatedFieldStatus? = nil
    var counter: ValidatedFieldCounter? = nil
    var multiline = false
    var maxLength: Int? = nil
    var accessibilityId: String? = nil
    var isEnabled = true
    var focused: FocusState<Bool>.Binding? = nil
    var autocapitalization: TextInputAutocapitalization? = nil
    var autocorrectionDisabled = false
    var submitLabel: SubmitLabel? = nil
    var onSubmit: (() -> Void)? = nil
    var onChange: ((String) -> Void)? = nil
    @FocusState private var internalFocused: Bool

    init(
        title: String,
        prompt: String = "",
        text: Binding<String>,
        placeholder: String? = nil,
        validate: ((String) -> String?)? = nil,
        error: String? = nil,
        status: ValidatedFieldStatus? = nil,
        counter: ValidatedFieldCounter? = nil,
        multiline: Bool = false,
        maxLength: Int? = nil,
        accessibilityId: String? = nil,
        isEnabled: Bool = true,
        focused: FocusState<Bool>.Binding? = nil,
        autocapitalization: TextInputAutocapitalization? = nil,
        autocorrectionDisabled: Bool = false,
        submitLabel: SubmitLabel? = nil,
        onSubmit: (() -> Void)? = nil,
        onChange: ((String) -> Void)? = nil
    ) {
        self.title = title
        self.prompt = prompt
        self.placeholder = placeholder
        _text = text
        self.validate = validate
        self.error = error
        self.status = status
        self.counter = counter
        self.multiline = multiline
        self.maxLength = maxLength
        self.accessibilityId = accessibilityId
        self.isEnabled = isEnabled
        self.focused = focused
        self.autocapitalization = autocapitalization
        self.autocorrectionDisabled = autocorrectionDisabled
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
        self.onChange = onChange
    }

    private var resolvedError: String? {
        if let error { return error }
        if let validationError = validate?(text) { return validationError }
        if case .error(let message) = status { return message }
        return nil
    }

    private var resolvedStatus: ValidatedFieldStatus? {
        if let resolvedError { return .error(resolvedError) }
        if case .valid = status { return status }
        return nil
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    private var canvasProfile: DesignCanvasWellProfile {
        resolvedError == nil ? .standard : .validatedError
    }

    private var fieldAccessibilityValue: String {
        if !isEnabled { return "Disabled" }
        if let resolvedError { return "Error: \(resolvedError)" }
        return text.isEmpty ? "Empty" : text
    }

    private var fieldAccessibilityHint: String {
        if !isEnabled { return "Disabled" }
        if let resolvedError { return "Error: \(resolvedError)" }
        return ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ValidatedFieldMetrics.labelGap) {
            if multiline {
                multilineField
            } else {
                singleLineField
            }
            if let resolvedStatus {
                ValidatedFieldStatusView(
                    status: resolvedStatus,
                    accessibilityId: accessibilityId.map { "\($0)-\(resolvedStatus.isError ? "error" : "status")" }
                )
            }
            if let counter {
                Text(counter.displayText)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(counter.displayText)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier(accessibilityId.map { "\($0)-count" } ?? "")
            }
        }
        .onChange(of: isFocused) { _, focused in
            if focused, !isEnabled { setFocus(false) }
        }
    }

    private var label: some View {
        Text(title)
            .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
            .foregroundStyle(DuskColors.ink)
            .frame(minHeight: ValidatedFieldMetrics.labelLineHeight, alignment: .leading)
    }

    private var singleLineField: some View {
        VStack(alignment: .leading, spacing: ValidatedFieldMetrics.labelGap) {
            label
            focusableSingleLine
        }
    }

    @ViewBuilder
    private var focusableSingleLine: some View {
        if let focused {
            singleLineInput.focused(focused)
        } else {
            singleLineInput.focused($internalFocused)
        }
    }

    private var singleLineInput: some View {
        TextField(prompt, text: cappedBinding)
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .textFieldStyle(.plain)
            .padding(.horizontal, Space.md + DesignMetrics.hairline)
            .frame(minHeight: ValidatedFieldMetrics.visualHeight)
            .lineLimit(1)
            // Keep native glyphs inside the authored face while the later
            // background remains free to draw its transparent focus overflow.
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                DesignCompositeWellCanvasBackground(
                    isEnabled: isEnabled,
                    isFocused: isFocused,
                    profile: canvasProfile
                )
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
            .disabled(!isEnabled)
            .submitLabel(submitLabel ?? .return)
            .onSubmit { onSubmit?() }
            .onChange(of: text) { _, value in onChange?(value) }
            .textInputAutocapitalization(autocapitalization ?? .sentences)
            .autocorrectionDisabled(autocorrectionDisabled)
            .accessibilityLabel(title)
            .accessibilityValue(fieldAccessibilityValue)
            .accessibilityHint(fieldAccessibilityHint)
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var multilineField: some View {
        VStack(alignment: .leading, spacing: ValidatedFieldMetrics.labelGap) {
            label
            ZStack(alignment: .topLeading) {
                if text.isEmpty, let placeholder = placeholder ?? (prompt.isEmpty ? nil : prompt) {
                    Text(placeholder)
                        .font(Typo.ui(TypeScale.base))
                        .foregroundStyle(DuskColors.ink3)
                        .padding(.horizontal, DesignMetrics.editorPlaceholderInsetH)
                        .padding(.vertical, DesignMetrics.editorPlaceholderInsetV)
                        .allowsHitTesting(false)
                }
                focusableMultiline
            }
            .frame(height: DesignMetrics.multilineEditorMinHeight)
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                DesignCompositeWellCanvasBackground(
                    isEnabled: isEnabled,
                    isFocused: isFocused,
                    profile: canvasProfile
                )
            }
        }
    }

    @ViewBuilder
    private var focusableMultiline: some View {
        if let focused {
            multilineInput.focused(focused)
        } else {
            multilineInput.focused($internalFocused)
        }
    }

    private var multilineInput: some View {
        TextEditor(text: cappedBinding)
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, DesignMetrics.editorInset)
            .padding(.vertical, ValidatedFieldMetrics.editorVerticalInset)
            .disabled(!isEnabled)
            .onChange(of: text) { _, value in onChange?(value) }
            .accessibilityLabel(title)
            .accessibilityValue(fieldAccessibilityValue)
            .accessibilityHint(fieldAccessibilityHint)
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    private func setFocus(_ value: Bool) {
        if let focused {
            focused.wrappedValue = value
        } else {
            internalFocused = value
        }
    }

    private var cappedBinding: Binding<String> {
        Binding(
            get: { text },
            set: { newValue in
                guard isEnabled else { return }
                text = Self.cappedText(newValue, maxLength: maxLength)
            }
        )
    }

    static func cappedText(_ text: String, maxLength: Int?) -> String {
        guard let maxLength, text.count > maxLength else { return text }
        return String(text.prefix(maxLength))
    }
}

private struct ValidatedFieldStatusView: View {
    let status: ValidatedFieldStatus
    let accessibilityId: String?

    var body: some View {
        Label {
            Text(status.message)
        } icon: {
            Image(systemName: status.isError ? "exclamationmark.triangle" : "checkmark")
                .accessibilityHidden(true)
        }
        .font(Typo.ui(TypeScale.sm))
        .foregroundStyle(
            status.isError
                ? DuskColors.stop.overlaying(DuskColors.ink, opacity: 0.30)
                : DuskColors.sage
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.isError ? "Error: \(status.message)" : status.message)
        .accessibilityIdentifier(accessibilityId ?? "")
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
    // padding. Keep this 42.25pt painted face distinct from its 44pt semantic
    // target, including when the real 44pt clear Button is present.
    static let visualHeight = TypeScale.base * CGFloat(DesignV2.Typography.lineNormal)
        + 18
        + DesignMetrics.hairline
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
    var showsTitle = true
    var showsSearchIcon = false
    var focused: FocusState<Bool>.Binding? = nil
    @Environment(\.isEnabled) private var isEnabled
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
        showsTitle: Bool = true,
        showsSearchIcon: Bool = false,
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
        self.showsTitle = showsTitle
        self.showsSearchIcon = showsSearchIcon
        self.focused = focused
    }

    private var isFocused: Bool {
        focused?.wrappedValue ?? internalFocused
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSearchFieldMetrics.labelGap) {
            if showsTitle {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(minHeight: DesignSearchFieldMetrics.labelLineHeight)
            }
            fieldSurface
        }
        .onChange(of: isEnabled) { _, enabled in
            if !enabled { setFocus(false) }
        }
    }

    private var fieldSurface: some View {
        HStack(spacing: Space.sm) {
            if showsSearchIcon {
                Image(systemName: "magnifyingglass")
                    .font(Typo.ui(TypeScale.lg, .regular))
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            focusableInput
        }
        // Reserve the same HStack spacing and clear target width without
        // allowing that 44pt target to determine the receiver's face height.
        .padding(.trailing, showsClearButton ? DesignMetrics.minimumTarget + Space.sm : 0)
        .padding(.leading, leadingPadding)
        .padding(.trailing, trailingPadding)
        .frame(minHeight: DesignSearchFieldMetrics.visualHeight)
        .background {
            DesignCompositeWellCanvasBackground(
                isEnabled: isEnabled,
                isFocused: isFocused,
                profile: .standard
            )
        }
        .overlay(alignment: .trailing) {
            if let onClear, showsClearButton {
                clearButton(action: onClear)
                    .padding(.trailing, trailingPadding)
            }
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .contentShape(Rectangle())
    }

    private var showsClearButton: Bool {
        onClear != nil && !query.isEmpty
    }

    @ViewBuilder
    private func clearButton(action: @escaping () -> Void) -> some View {
        DesignCompactIconButton(
            systemName: "xmark.circle.fill",
            label: "Clear search",
            accessibilityId: accessibilityId.map { "\($0)-clear" },
            action: action
        )
        .foregroundStyle(DuskColors.ink3)
    }

    @ViewBuilder
    private var focusableInput: some View {
        if let focused {
            input.focused(focused)
        } else {
            input.focused($internalFocused)
        }
    }

    private func setFocus(_ value: Bool) {
        if let focused {
            focused.wrappedValue = value
        } else {
            internalFocused = value
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
        .frame(maxWidth: .infinity)
        .submitLabel(.search)
        .accessibilityLabel(title)
        .accessibilityValue(query.isEmpty ? "Empty" : query)
        .accessibilityIdentifier(accessibilityId ?? "")
    }
}

private enum DesignFilterBarMetrics {
    static let minimumSearchWidth: CGFloat = 220
    static let menuWidth: CGFloat = 170
}

struct DesignFilterMenu<Value: Hashable>: View {
    let title: String
    let options: [(value: Value, label: String)]
    @Binding var selection: Value
    var accessibilityId: String? = nil

    var body: some View {
        Menu {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button {
                    selection = option.value
                } label: {
                    if option.value == selection {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            DesignMenuTriggerLabel(
                currentLabel: currentLabel,
                isEnabled: true,
                width: .flexible(minimum: DesignFilterBarMetrics.menuWidth)
            )
        }
        .accessibilityLabel(title)
        .accessibilityValue(currentLabel)
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var currentLabel: String {
        options.first(where: { $0.value == selection })?.label ?? "Not selected"
    }

}

struct SearchFilterRow<PrimaryFilter: View, Filters: View>: View {
    let prompt: String
    @Binding var query: String
    var accessibilityId: String? = nil
    @ViewBuilder let primaryFilter: () -> PrimaryFilter
    @ViewBuilder let filters: () -> Filters

    init(
        prompt: String,
        query: Binding<String>,
        accessibilityId: String? = nil,
        @ViewBuilder primaryFilter: @escaping () -> PrimaryFilter,
        @ViewBuilder filters: @escaping () -> Filters
    ) {
        self.prompt = prompt
        _query = query
        self.accessibilityId = accessibilityId
        self.primaryFilter = primaryFilter
        self.filters = filters
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.md) {
                    searchField
                    primaryFilter()
                        .frame(width: DesignFilterBarMetrics.menuWidth)
                }
                VStack(alignment: .leading, spacing: Space.md) {
                    searchField
                    primaryFilter()
                        .frame(maxWidth: .infinity)
                }
            }
            if Filters.self != EmptyView.self {
                CenteredFlowLayout(spacing: Space.sm, alignment: .leading) {
                    filters()
                }
                .padding(2)
                .accessibilityLabel("Filters")
            }
        }
        .padding(Space.lg - 2)
        .designPlate()
        .accessibilityIdentifier(accessibilityId ?? "")
    }

    private var searchField: some View {
        DesignSearchField(
            prompt: prompt,
            query: $query,
            onClear: query.isEmpty ? nil : { query = "" },
            showsTitle: false,
            showsSearchIcon: true
        )
        // Preserve the source grid's minimum search measure. ViewThatFits then
        // recomposes the native controls vertically when search and menu cannot
        // both retain useful content width.
        .frame(minWidth: DesignFilterBarMetrics.minimumSearchWidth, maxWidth: .infinity)
    }
}

extension SearchFilterRow where PrimaryFilter == EmptyView {
    init(
        prompt: String,
        query: Binding<String>,
        accessibilityId: String? = nil,
        @ViewBuilder filters: @escaping () -> Filters
    ) {
        self.init(
            prompt: prompt,
            query: query,
            accessibilityId: accessibilityId,
            primaryFilter: { EmptyView() },
            filters: filters
        )
    }
}

private enum AsyncNoticeMetrics {
    // Loading and empty use the approved centered async-state anatomy rather
    // than the horizontal notice grid.
    static let stateGap: CGFloat = 7
    static let statePadding = Space.lg + DesignMetrics.hairline
    static let loadingSpinnerSize: CGFloat = 26
    static let loadingSpinnerLineWidth: CGFloat = 2
    static let loadingArcFraction: CGFloat = 0.25
    static let loadingAnimationDuration = 0.9
    static let emptyMarkSize: CGFloat = 34
}

/// Decorative recessed mark for a genuine empty collection. The caller-owned
/// title, detail, and action remain the accessible source of meaning.
private struct AsyncEmptyMark: View {
    var body: some View {
        Text("＋")
            .font(Typo.ui(TypeScale.base))
            .foregroundStyle(DuskColors.ink3)
            .frame(width: AsyncNoticeMetrics.emptyMarkSize, height: AsyncNoticeMetrics.emptyMarkSize)
            .background {
                DesignCompositeWellCanvasBackground(
                    shape: .circle,
                    isEnabled: true,
                    isFocused: false,
                    profile: .standard
                )
            }
            .accessibilityHidden(true)
    }
}

/// Decorative loading cue for the common async-state composite. Status meaning
/// remains owned by `AsyncNotice`; the ring is hidden from VoiceOver.
private struct AsyncLoadingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var rotation: Double = 0

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(DuskColors.line, lineWidth: AsyncNoticeMetrics.loadingSpinnerLineWidth)
            Circle()
                .trim(from: 0, to: AsyncNoticeMetrics.loadingArcFraction)
                .stroke(
                    DuskColors.accent,
                    style: StrokeStyle(
                        lineWidth: AsyncNoticeMetrics.loadingSpinnerLineWidth,
                        lineCap: .butt
                    )
                )
                .padding(AsyncNoticeMetrics.loadingSpinnerLineWidth / 2)
                .rotationEffect(.degrees(-135 + rotation))
        }
        .frame(
            width: AsyncNoticeMetrics.loadingSpinnerSize,
            height: AsyncNoticeMetrics.loadingSpinnerSize
        )
        .onAppear { startAnimation() }
        .onChange(of: reduceMotion) { _, reduced in
            rotation = reduced ? 0 : 360
        }
        .animation(
            reduceMotion
                ? nil
                : .linear(duration: AsyncNoticeMetrics.loadingAnimationDuration)
                    .repeatForever(autoreverses: false),
            value: rotation
        )
        .accessibilityHidden(true)
    }

    private func startAnimation() {
        guard !reduceMotion else { return }
        rotation = 360
    }
}

private enum DesignNoticeMetrics {
    // These values are the reviewed notice's CSS box model translated to
    // points. The 78pt notice sits inside a 1pt plate edge on each side.
    static let surfaceMinHeight: CGFloat = 80
    // The native plate keeps its 1pt edge inside the shape, so the content
    // insets include that edge while preserving the source's inner padding.
    static let horizontalPadding: CGFloat = 15
    static let verticalPadding: CGFloat = 14
    static let contentGap: CGFloat = 13
    static let compactActionGap: CGFloat = 13
    static let iconSize: CGFloat = 38
    static let noticeAuraCenter: CGFloat = 58
    static let noticeAuraRadius: CGFloat = 150
    // The source title inherits 1.55 line height at 14px; its detail sets a
    // slightly tighter 1.45 line height at the supporting 12.5px size.
    static let titleLineHeight = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal)
    static let titleLineSpacing = DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal - 1)
    static let detailLineHeight = TypeScale.sm * 1.45
    // CoreText supplies part of the line advance for a custom font; this
    // native spacing reaches the reviewed 1.45 supporting line box without
    // exaggerating the gap when detail wraps.
    static let detailLineSpacing = TypeScale.sm * 0.13
    static let detailTitleGap: CGFloat = 3
}

private struct DesignNoticeRecipe {
    let color: Color
    let aura: Double
    let leading: Double
    let tail: Double
}

/// Native equivalent of the reviewed responsive notice grid. A custom Layout
/// keeps the action in the trailing column when its intrinsic content fits and
/// recomposes it below the message when it does not, without browser widths or
/// presentation-only wrappers.
private struct DesignNoticeLayout: Layout {
    @Environment(\.layoutDirection) private var layoutDirection

    private struct Measurement {
        let compact: Bool
        let width: CGFloat
        let height: CGFloat
        let iconSize: CGSize
        let bodySize: CGSize
        let actionSize: CGSize
        let bodyWidth: CGFloat

        var size: CGSize { CGSize(width: width, height: height) }
    }

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        measure(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let measurement = measure(
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height),
            subviews: subviews
        )
        guard subviews.count >= 2 else { return }

        let isRightToLeft = layoutDirection == .rightToLeft
        let iconX = isRightToLeft
            ? bounds.maxX - measurement.iconSize.width / 2
            : bounds.minX + measurement.iconSize.width / 2
        let bodyX = isRightToLeft
            ? bounds.maxX - measurement.iconSize.width - DesignNoticeMetrics.contentGap - measurement.bodyWidth
            : bounds.minX + measurement.iconSize.width + DesignNoticeMetrics.contentGap
        if measurement.compact {
            let firstRowHeight = max(measurement.iconSize.height, measurement.bodySize.height)
            subviews[0].place(
                at: CGPoint(
                    x: iconX,
                    y: bounds.minY + (firstRowHeight / 2)
                ),
                anchor: .center,
                proposal: ProposedViewSize(
                    width: measurement.iconSize.width,
                    height: measurement.iconSize.height
                )
            )
            subviews[1].place(
                at: CGPoint(x: bodyX, y: bounds.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(
                    width: measurement.bodyWidth,
                    height: measurement.bodySize.height
                )
            )
            if subviews.count > 2 {
                let actionX = isRightToLeft
                    ? bodyX + measurement.bodyWidth - measurement.actionSize.width
                    : bodyX
                subviews[2].place(
                    at: CGPoint(
                        x: actionX,
                        y: bounds.minY + firstRowHeight + DesignNoticeMetrics.compactActionGap
                    ),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(
                        width: measurement.actionSize.width,
                        height: measurement.actionSize.height
                    )
                )
            }
            return
        }

        let centerY = bounds.minY + measurement.height / 2
        subviews[0].place(
            at: CGPoint(x: iconX, y: centerY),
            anchor: .center,
            proposal: ProposedViewSize(
                width: measurement.iconSize.width,
                height: measurement.iconSize.height
            )
        )
        subviews[1].place(
            at: CGPoint(x: bodyX, y: bounds.minY + (measurement.height - measurement.bodySize.height) / 2),
            anchor: .topLeading,
            proposal: ProposedViewSize(
                width: measurement.bodyWidth,
                height: measurement.bodySize.height
            )
        )
        if subviews.count > 2 {
            let actionX = isRightToLeft ? bounds.minX : bounds.maxX - measurement.actionSize.width
            subviews[2].place(
                at: CGPoint(
                    x: actionX,
                    y: bounds.minY + (measurement.height - measurement.actionSize.height) / 2
                ),
                anchor: .topLeading,
                proposal: ProposedViewSize(
                    width: measurement.actionSize.width,
                    height: measurement.actionSize.height
                )
            )
        }
    }

    private func measure(proposal: ProposedViewSize, subviews: Subviews) -> Measurement {
        guard subviews.count >= 2 else {
            return Measurement(
                compact: false,
                width: 0,
                height: 0,
                iconSize: .zero,
                bodySize: .zero,
                actionSize: .zero,
                bodyWidth: 0
            )
        }

        let iconSize = subviews[0].sizeThatFits(.unspecified)
        let body = subviews[1]
        let actionSize = subviews.count > 2 ? subviews[2].sizeThatFits(.unspecified) : .zero
        let bodyIdealSize = body.sizeThatFits(.unspecified)
        let availableWidth = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let hasAction = subviews.count > 2
        let wideIdealWidth = iconSize.width
            + DesignNoticeMetrics.contentGap
            + bodyIdealSize.width
            + (hasAction ? DesignNoticeMetrics.contentGap + actionSize.width : 0)
        let compact = hasAction && availableWidth.map { wideIdealWidth > $0 } == true
        let width = availableWidth ?? wideIdealWidth

        if compact {
            let bodyWidth = max(0, width - iconSize.width - DesignNoticeMetrics.contentGap)
            let bodySize = body.sizeThatFits(ProposedViewSize(width: bodyWidth, height: nil))
            let firstRowHeight = max(iconSize.height, bodySize.height)
            return Measurement(
                compact: true,
                width: width,
                height: firstRowHeight + DesignNoticeMetrics.compactActionGap + actionSize.height,
                iconSize: iconSize,
                bodySize: bodySize,
                actionSize: actionSize,
                bodyWidth: bodyWidth
            )
        }

        let bodyWidth = max(
            0,
            width - iconSize.width - DesignNoticeMetrics.contentGap
                - (hasAction ? DesignNoticeMetrics.contentGap + actionSize.width : 0)
        )
        let bodySize = body.sizeThatFits(ProposedViewSize(width: bodyWidth, height: nil))
        return Measurement(
            compact: false,
            width: width,
            height: max(iconSize.height, max(bodySize.height, actionSize.height)),
            iconSize: iconSize,
            bodySize: bodySize,
            actionSize: actionSize,
            bodyWidth: bodyWidth
        )
    }
}

private struct DesignNoticeIcon: View {
    let kind: DesignNoticeKind
    let recipe: DesignNoticeRecipe

    var body: some View {
        glyph
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(recipe.color.overlaying(DuskColors.ink, opacity: 0.12))
            .frame(width: DesignNoticeMetrics.iconSize, height: DesignNoticeMetrics.iconSize)
            .clipShape(RoundedRectangle(cornerRadius: Radii.sm, style: .continuous))
            .background {
                DesignCompositeRaisedCanvasBackground(
                    shape: .continuousRoundedRectangle(cornerRadius: Radii.sm),
                    role: kind == .error ? .destructive : .quiet,
                    state: kind == .error ? .rest : .disabled
                )
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var glyph: some View {
        switch kind {
        case .loading:
            ProgressView().tint(recipe.color).controlSize(.small)
        case .empty:
            Image(systemName: "tray")
        case .info:
            Image(systemName: "info.circle")
        case .error, .warning:
            Image(systemName: "exclamationmark.triangle")
        case .success:
            Image(systemName: "checkmark.circle")
        }
    }
}

struct AsyncNotice: View {
    let kind: DesignNoticeKind
    let title: String
    var detail: String? = nil
    var retry: (() -> Void)? = nil
    var accessibilityId: String? = nil
    // Existing retry callers keep the same label; contextual owners may name
    // an additive action without taking ownership away from their closure.
    var actionTitle = "Retry"
    @Environment(\.layoutDirection) private var layoutDirection

    private var recipe: DesignNoticeRecipe {
        switch kind {
        case .info:
            DesignNoticeRecipe(color: DuskColors.sage, aura: 0.12, leading: 0.10, tail: 0.03)
        case .warning:
            DesignNoticeRecipe(color: DuskColors.amber, aura: 0.24, leading: 0.22, tail: 0.08)
        case .error:
            DesignNoticeRecipe(color: DuskColors.stop, aura: 0.21, leading: 0.19, tail: 0.07)
        case .loading:
            DesignNoticeRecipe(color: DuskColors.accent, aura: 0.08, leading: 0.06, tail: 0.02)
        case .empty:
            DesignNoticeRecipe(color: DuskColors.ink3, aura: 0, leading: 0, tail: 0)
        case .success:
            DesignNoticeRecipe(color: DuskColors.sage, aura: 0.10, leading: 0.08, tail: 0.02)
        }
    }

    private var actionRole: DesignButtonRole {
        kind == .error ? .secondary : .quiet
    }

    var body: some View {
        content
            .designPlate()
            .accessibilityElement(children: retry == nil ? .combine : .contain)
            .accessibilityLabel(title)
            .accessibilityValue(detail ?? kind.accessibilityValue)
            .accessibilityAddTraits(kind == .empty ? .isHeader : [])
            .accessibilityIdentifier(accessibilityId ?? "")
    }

    @ViewBuilder
    private var content: some View {
        switch kind {
        case .loading:
            loadingContent.padding(AsyncNoticeMetrics.statePadding)
        case .empty:
            emptyContent.padding(AsyncNoticeMetrics.statePadding)
        case .info, .error, .success, .warning:
            noticeContent
        }
    }

    private var loadingContent: some View {
        VStack(spacing: AsyncNoticeMetrics.stateGap) {
            AsyncLoadingIndicator()
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .foregroundStyle(DuskColors.ink)
                .frame(
                    minHeight: DesignMetrics.controlLabelSize * CGFloat(DesignV2.Typography.lineNormal),
                    alignment: .center
                )
            if let detail {
                Text(detail)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(minHeight: TypeScale.sm * 1.45, alignment: .center)
            }
            if let retry {
                DesignActionButton(
                    title: actionTitle,
                    role: .quiet,
                    accessibilityId: nil,
                    action: retry
                )
            }
        }
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
    }

    private var emptyContent: some View {
        VStack(spacing: AsyncNoticeMetrics.stateGap) {
            AsyncEmptyMark()
            Text(title)
                .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                .foregroundStyle(DuskColors.ink)
                .frame(minHeight: DesignNoticeMetrics.titleLineHeight, alignment: .center)
            if let detail {
                Text(detail)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
                    .frame(minHeight: DesignNoticeMetrics.detailLineHeight, alignment: .center)
            }
            if let retry {
                DesignActionButton(
                    title: actionTitle,
                    role: .quiet,
                    accessibilityId: nil,
                    fillsWidth: false,
                    action: retry
                )
            }
        }
        .frame(maxWidth: .infinity)
        .multilineTextAlignment(.center)
    }

    private var noticeContent: some View {
        DesignNoticeLayout {
            DesignNoticeIcon(kind: kind, recipe: recipe)
            VStack(alignment: .leading, spacing: DesignNoticeMetrics.detailTitleGap) {
                Text(title)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                    .lineSpacing(DesignNoticeMetrics.titleLineSpacing)
                    .foregroundStyle(DuskColors.ink)
                    .frame(minHeight: DesignNoticeMetrics.titleLineHeight, alignment: .leading)
                if let detail {
                    Text(detail)
                        .font(Typo.ui(TypeScale.sm))
                        .lineSpacing(DesignNoticeMetrics.detailLineSpacing)
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minHeight: DesignNoticeMetrics.detailLineHeight, alignment: .leading)
                }
            }
            if let retry {
                DesignActionButton(
                    title: actionTitle,
                    role: actionRole,
                    accessibilityId: nil,
                    action: retry
                )
            }
        }
        .padding(.horizontal, DesignNoticeMetrics.horizontalPadding)
        .padding(.vertical, DesignNoticeMetrics.verticalPadding)
        .frame(maxWidth: .infinity, minHeight: DesignNoticeMetrics.surfaceMinHeight, alignment: .leading)
        .background {
            GeometryReader { proxy in
                ZStack {
                    LinearGradient(
                        stops: [
                            .init(
                                color: DuskColors.bgElev.overlaying(recipe.color, opacity: recipe.leading),
                                location: 0
                            ),
                            .init(
                                color: DuskColors.bgElev.overlaying(recipe.color, opacity: recipe.tail),
                                location: 0.58
                            ),
                            .init(color: DuskColors.bgElev, location: 1)
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    RadialGradient(
                        colors: [recipe.color.opacity(recipe.aura), .clear],
                        center: UnitPoint(
                            x: layoutDirection == .rightToLeft
                                ? 1 - min(DesignNoticeMetrics.noticeAuraCenter, max(proxy.size.width, 1)) / max(proxy.size.width, 1)
                                : min(DesignNoticeMetrics.noticeAuraCenter, max(proxy.size.width, 1)) / max(proxy.size.width, 1),
                            y: 0.5
                        ),
                        startRadius: 0,
                        endRadius: DesignNoticeMetrics.noticeAuraRadius
                    )
                }
            }
        }
    }
}

private extension DesignNoticeKind {
    var accessibilityValue: String {
        switch self {
        case .loading: "Loading"
        case .empty: "Empty"
        case .info: "Information"
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

private enum DesignApplyBarPhase: Equatable {
    case dirty
    case applying
    case done
}

private enum DesignApplyBarMetrics {
    // The source's 72px border-box retains a 74pt native plate face once the
    // shared inset edge and flexible Dynamic Type line boxes are represented.
    static let minimumHeight: CGFloat = 74
    static let horizontalPadding: CGFloat = 14
    static let markerSize: CGFloat = 7
    static let markerTextGap: CGFloat = 10
    static let markerGlowRadius: CGFloat = 4
    static let markerPulseDuration: TimeInterval = 0.45
}

/// Native action surface for the existing settings draft/apply lifecycle. The
/// screen remains the sole owner of dirty state, persistence, discard, and all
/// terminal outcomes; this view only derives presentation and emits actions.
struct DesignApplyBar: View {
    let isDirty: Bool
    let state: DesignApplyState
    var dirtyTitle = "Unsaved changes"
    var dirtyDetail = "Review before applying to the household."
    var discardAccessibilityId: String? = nil
    var applyAccessibilityId: String? = nil
    let onDiscard: () -> Void
    let onApply: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var markerPulse = false

    private var phase: DesignApplyBarPhase? {
        switch state {
        case .saving, .restarting:
            return .applying
        case .applied:
            return isDirty ? .dirty : .done
        case .idle, .alreadyApplying, .failed:
            return isDirty ? .dirty : nil
        }
    }

    var body: some View {
        VStack(spacing: Space.sm) {
            switch state {
            case .alreadyApplying, .failed:
                DesignApplyFeedback(state: state)
            case .idle, .saving, .restarting, .applied:
                EmptyView()
            }
            if let phase {
                bar(phase)
            }
        }
    }

    private func bar(_ phase: DesignApplyBarPhase) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.lg) {
                status(phase)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions(phase, fillsWidth: false)
            }
            VStack(alignment: .leading, spacing: Space.md) {
                status(phase)
                actions(phase, fillsWidth: true)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, DesignApplyBarMetrics.horizontalPadding)
        .padding(.vertical, Space.md)
        .frame(maxWidth: .infinity, minHeight: DesignApplyBarMetrics.minimumHeight)
        .background(phaseTint(phase))
        .designPlate()
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: phase
        )
        .task(id: "\(phase)-\(reduceMotion)") {
            markerPulse = false
            guard phase == .applying, !reduceMotion else { return }
            await Task.yield()
            markerPulse = true
        }
    }

    private func status(_ phase: DesignApplyBarPhase) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DesignApplyBarMetrics.markerTextGap) {
            Circle()
                .fill(phase == .done ? DuskColors.ok : DuskColors.accent)
                .frame(width: DesignApplyBarMetrics.markerSize, height: DesignApplyBarMetrics.markerSize)
                .shadow(
                    color: phase == .done ? .clear : DuskColors.accent,
                    radius: DesignApplyBarMetrics.markerGlowRadius
                )
                .scaleEffect(phase == .applying && markerPulse ? 0.72 : phase == .done ? 1.08 : 1)
                .opacity(phase == .applying && markerPulse ? 0.65 : 1)
                .animation(
                    reduceMotion || phase != .applying
                        ? nil
                        : .easeInOut(duration: DesignApplyBarMetrics.markerPulseDuration).repeatForever(),
                    value: markerPulse
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(phase == .done ? "Changes applied" : dirtyTitle)
                    .font(Typo.ui(DesignMetrics.controlLabelSize, .semibold))
                    .foregroundStyle(DuskColors.ink)
                Text(phase == .done ? "The household preference is up to date." : dirtyDetail)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func actions(_ phase: DesignApplyBarPhase, fillsWidth: Bool) -> some View {
        HStack(spacing: Space.sm) {
            DesignActionButton(
                title: "Discard",
                role: .quiet,
                state: isDirty ? .normal : .disabled,
                accessibilityId: discardAccessibilityId,
                fillsWidth: fillsWidth,
                action: onDiscard
            )
            DesignActionButton(
                title: phase == .applying ? "Applying…" : phase == .done ? "Applied" : "Apply changes",
                state: phase == .dirty ? .normal : .disabled,
                accessibilityId: applyAccessibilityId,
                fillsWidth: fillsWidth,
                action: onApply
            )
        }
    }

    private func phaseTint(_ phase: DesignApplyBarPhase) -> Color {
        switch phase {
        case .dirty: .clear
        case .applying: DuskColors.accent50.opacity(0.24)
        case .done: DuskColors.ok.opacity(0.07)
        }
    }
}

private struct DesignApplyBarDockModifier: ViewModifier {
    let isDirty: Bool
    let state: DesignApplyState
    let discardAccessibilityId: String
    let applyAccessibilityId: String
    let onDiscard: () -> Void
    let onApply: () -> Void

    private var isPresented: Bool {
        if isDirty { return true }
        switch state {
        case .idle: return false
        case .saving, .restarting, .alreadyApplying, .applied, .failed: return true
        }
    }

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if isPresented {
                DesignApplyBar(
                    isDirty: isDirty,
                    state: state,
                    discardAccessibilityId: discardAccessibilityId,
                    applyAccessibilityId: applyAccessibilityId,
                    onDiscard: onDiscard,
                    onApply: onApply
                )
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bg)
            }
        }
    }
}

extension View {
    /// Keeps the existing settings apply owner reachable above the keyboard and
    /// home indicator without introducing a second draft or persistence owner.
    func designApplyBarDock(
        isDirty: Bool,
        state: DesignApplyState,
        discardAccessibilityId: String,
        applyAccessibilityId: String,
        onDiscard: @escaping () -> Void,
        onApply: @escaping () -> Void
    ) -> some View {
        modifier(
            DesignApplyBarDockModifier(
                isDirty: isDirty,
                state: state,
                discardAccessibilityId: discardAccessibilityId,
                applyAccessibilityId: applyAccessibilityId,
                onDiscard: onDiscard,
                onApply: onApply
            )
        )
    }
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
            AsyncNotice(kind: .loading, title: "Applying configuration…", accessibilityId: "settings-applying")
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
