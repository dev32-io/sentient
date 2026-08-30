import SwiftUI

func secretPresenceText(isConfigured: Bool) -> String {
    isConfigured ? "Configured" : "Not configured"
}

struct SecretKeyRow: View {
    let label: String
    let idKey: String
    let hasKey: Bool
    let isActive: Bool
    let isEditing: Bool
    let isSaving: Bool
    let onSetActive: (() -> Void)?
    let onStartEdit: () -> Void
    let onCancel: () -> Void
    let onSave: (String) -> Void

    @State private var draft = ""
    @FocusState private var editButtonFocused: Bool
    @AccessibilityFocusState private var editButtonAccessibilityFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            readContext
            if isEditing {
                DesignDivider()
                editor
                    .transition(editorTransition)
            }
        }
        .background(DuskColors.bgElev)
        .clipShape(RoundedRectangle(cornerRadius: Radii.md, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radii.md, style: .continuous)
                .stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
        }
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: isEditing
        )
        .onChange(of: isEditing) { _, editing in
            guard !editing else { return }
            draft = ""
            Task { @MainActor in
                editButtonFocused = true
                editButtonAccessibilityFocused = true
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var readContext: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: Space.md) {
                contextLabel
                Spacer(minLength: Space.sm)
                readActions
            }
            VStack(alignment: .leading, spacing: Space.sm) {
                contextLabel
                readActions
            }
        }
        .padding(Space.md)
        .frame(minHeight: DesignMetrics.inlineEditorReadMinimumHeight)
    }

    private var contextLabel: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label)
                .designText(.body)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("settings-secret-\(idKey)")
            Text(secretPresenceText(isConfigured: hasKey))
                .designText(.supporting)
                .foregroundStyle(hasKey ? DuskColors.ink2 : DuskColors.ink4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(hasKey ? "Key configured" : "Key not configured")
    }

    private var readActions: some View {
        HStack(spacing: Space.sm) {
            if isActive {
                Label("Active", systemImage: "checkmark")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.accent)
                    .accessibilityLabel("Active provider")
            } else if let onSetActive {
                DesignTextButton(
                    title: "Set active",
                    accessibilityId: "settings-secret-\(idKey)-active",
                    action: onSetActive
                )
            }
            if !isEditing {
                DesignActionButton(
                    title: hasKey ? "Edit" : "Set key",
                    role: .secondary,
                    accessibilityId: "settings-secret-\(idKey)-update",
                    fillsWidth: false,
                    action: onStartEdit
                )
                .focused($editButtonFocused)
                .accessibilityFocused($editButtonAccessibilityFocused)
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            DesignMaskedField(
                title: "New access key",
                prompt: "Paste new key",
                text: $draft,
                accessibilityId: "settings-secret-\(idKey)-input",
                autoFocus: true
            )
            Text("Secret values are never written to logs or decorative diagnostics.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
            HStack(spacing: Space.sm) {
                Spacer(minLength: 0)
                DesignActionButton(
                    title: "Cancel",
                    role: .quiet,
                    accessibilityId: "settings-secret-\(idKey)-cancel",
                    fillsWidth: false,
                    action: onCancel
                )
                DesignActionButton(
                    title: "Save key",
                    loadingTitle: "Saving…",
                    state: canSave ? .normal : isSaving ? .loading : .disabled,
                    accessibilityId: "settings-secret-\(idKey)-save",
                    fillsWidth: false,
                    action: { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                )
            }
        }
        .padding(DesignMetrics.inlineEditorFormPadding)
        .background {
            DesignWellFace(
                shape: Rectangle(),
                focused: false,
                showsInsetHighlights: true
            )
        }
        .privacySensitive()
    }

    private var editorTransition: AnyTransition {
        reduceMotion ? .identity : .opacity.combined(with: .move(edge: .top))
    }

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }
}

struct SecretUrlRow: View {
    let hasValue: Bool
    let isEditing: Bool
    let isSaving: Bool
    let onStartEdit: () -> Void
    let onCancel: () -> Void
    let onSave: (String) -> Void

    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Base URL").designText(.body).foregroundStyle(DuskColors.ink2)
            if isEditing { editor } else { presence }
        }
        .padding(.vertical, Space.sm)
        .onChange(of: isEditing) { _, editing in if !editing { draft = "" } }
        .accessibilityIdentifier("settings-secret-custom-baseurl")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignField(
                title: "New base URL",
                prompt: "https://api.example.com/v1",
                text: $draft,
                accessibilityId: "settings-secret-custom-baseurl-input"
            )
            .keyboardType(.URL)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            HStack(spacing: Space.sm) {
                DesignActionButton(
                    title: "Save",
                    state: canSave ? .normal : isSaving ? .loading : .disabled,
                    accessibilityId: "settings-secret-custom-baseurl-save",
                    action: { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                )
                DesignTextButton(title: "Cancel", action: onCancel)
            }
        }
    }

    private var presence: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(secretPresenceText(isConfigured: hasValue))
                .designText(.supporting)
                .foregroundStyle(hasValue ? DuskColors.ink2 : DuskColors.ink4)
                .accessibilityLabel(hasValue ? "Base URL configured" : "Base URL not configured")
            DesignTextButton(
                title: "Update base URL",
                accessibilityId: "settings-secret-custom-baseurl-update",
                action: onStartEdit
            )
        }
    }

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }
}

#Preview("Presence and edit — large text") {
    ScrollView {
        VStack(spacing: Space.md) {
            SecretKeyRow(
                label: "OpenRouter", idKey: "openrouter", hasKey: true, isActive: true,
                isEditing: false, isSaving: false, onSetActive: nil,
                onStartEdit: {}, onCancel: {}, onSave: { _ in }
            )
            SecretKeyRow(
                label: "Custom", idKey: "custom", hasKey: false, isActive: false,
                isEditing: true, isSaving: false, onSetActive: {},
                onStartEdit: {}, onCancel: {}, onSave: { _ in }
            )
        }
        .padding(Space.lg)
    }
    .environment(\.dynamicTypeSize, .accessibility3)
    .background(DuskColors.bg)
}
