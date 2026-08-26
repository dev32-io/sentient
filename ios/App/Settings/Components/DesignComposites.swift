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
                .background(DuskColors.bgElev)
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
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink)
            if let detail {
                Text(detail)
                    .font(Typo.ui(headerStyle == .elevated ? TypeScale.xs : TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
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

/// Compatibility card API. New callers should use `DesignCard` directly.
struct DesignSettingsRow<Accessory: View>: View {
    let title: String
    var detail: String? = nil
    var accessibilityId: String? = nil
    @ViewBuilder let accessory: () -> Accessory
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Space.sm))
            : AnyLayout(HStackLayout(alignment: .center, spacing: Space.lg))
        layout {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(TypeScale.base, .medium))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
            }
            Spacer(minLength: Space.sm)
            accessory()
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityIdentifier(accessibilityId ?? "")
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

struct DesignDisclosureButton<Label: View>: View {
    let isExpanded: Bool
    let accessibilityLabel: String
    let accessibilityId: String
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                label()
                Spacer(minLength: Space.sm)
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: DesignMetrics.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityIdentifier(accessibilityId)
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

struct DesignSearchField: View {
    let prompt: String
    @Binding var query: String
    var accessibilityId: String? = nil

    var body: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass").accessibilityHidden(true)
            TextField(prompt, text: $query)
                .font(Typo.ui(TypeScale.base))
                .textFieldStyle(.plain)
        }
        .padding(.horizontal, Space.md)
        .frame(minHeight: DesignMetrics.minimumTarget)
        .designWell()
        .accessibilityLabel(prompt)
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
