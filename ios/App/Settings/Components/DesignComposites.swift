import SwiftUI

struct DesignPageChrome<Content: View>: View {
    let title: String
    let accessibilityId: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) { content() }
                .padding(.horizontal, Space.lg)
                .padding(.vertical, Space.md)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(DuskColors.bg)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(DuskColors.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .accessibilityIdentifier(accessibilityId)
        .duskTheme()
    }
}

struct DesignPane<Content: View>: View {
    var title: String? = nil
    var detail: String? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if let title {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(title).font(Typo.ui(TypeScale.base, .semibold))
                    if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink3) }
                }
                DesignDivider()
            }
            content()
        }
        .padding(Space.lg)
        .designPlate()
    }
}

struct DesignSettingsRow<Accessory: View>: View {
    let title: String
    var detail: String? = nil
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
    }
}

struct DesignGroupHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(Typo.ui(TypeScale.base, .semibold))
            .foregroundStyle(DuskColors.ink2)
            .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget, alignment: .leading)
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
    var body: some View { DesignSecureField(title: title, text: $value, error: validationMessage) }
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

struct SearchFilterRow<Filters: View>: View {
    let prompt: String
    @Binding var query: String
    @ViewBuilder let filters: () -> Filters

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Image(systemName: "magnifyingglass").accessibilityHidden(true)
                TextField(prompt, text: $query)
                    .font(Typo.ui(TypeScale.base))
                    .textFieldStyle(.plain)
            }
            .padding(.horizontal, Space.md)
            .frame(minHeight: DesignMetrics.minimumTarget)
            .designWell()
            filters()
        }
        .accessibilityElement(children: .contain)
    }
}

struct AsyncNotice: View {
    let kind: DesignNoticeKind
    let title: String
    var detail: String? = nil
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: Space.md) {
            symbol
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(title).font(Typo.ui(TypeScale.base, .semibold))
                if let detail { Text(detail).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2) }
                if let retry { Button("Retry", action: retry).buttonStyle(DesignButtonStyle(role: .quiet)) }
            }
            Spacer()
        }
        .padding(Space.md)
        .designPlate()
        .accessibilityElement(children: retry == nil ? .combine : .contain)
    }

    @ViewBuilder private var symbol: some View {
        switch kind {
        case .loading: ProgressView().tint(DuskColors.accent)
        case .empty: Image(systemName: "tray")
        case .error: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(DuskColors.stop)
        case .success: Image(systemName: "checkmark.circle.fill").foregroundStyle(DuskColors.ok)
        case .warning: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(DuskColors.warn)
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

struct SaveApplyFeedback: View {
    let state: DesignControlState
    var successMessage: String? = nil

    @ViewBuilder var body: some View {
        switch state {
        case .normal:
            if let successMessage { AsyncNotice(kind: .success, title: successMessage) }
        case .loading:
            AsyncNotice(kind: .loading, title: "Applying changes")
        case .error(let message):
            AsyncNotice(kind: .error, title: "Couldn't apply changes", detail: message)
        case .disabled:
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
        }.padding(Space.lg)
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
            DesignPlatePreview()
            DesignSecureField(title: "Secret", text: $text)
            DesignMultilineEditor(title: "Notes", text: $text)
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
        }.padding(Space.md)
    }
    .frame(width: DesignMetrics.narrowPreviewWidth)
    .preferredColorScheme(.dark)
}

private struct DesignPlatePreview: View {
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
