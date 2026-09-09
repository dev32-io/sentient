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
        CenteredFlowLayout(spacing: Space.md, alignment: .leading) {
            contextLabel
            readActions
        }
        .padding(Space.md)
        .frame(minHeight: DesignMetrics.inlineEditorReadMinimumHeight)
    }

    private var contextLabel: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label)
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("settings-secret-\(idKey)")
            Text(hasKey ? "Key stored" : "No key stored")
                .designText(.caption)
                .foregroundStyle(DuskColors.ink2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
        .accessibilityValue(hasKey ? "Key stored; not validated" : "No key stored")
    }

    private var readActions: some View {
        CenteredFlowLayout(spacing: Space.sm, alignment: .trailing) {
            actionControls
        }
    }

    @ViewBuilder private var actionControls: some View {
        if isActive {
            Label("Selected", systemImage: "checkmark")
                .designText(.supporting)
                .foregroundStyle(DuskColors.accent)
                .accessibilityLabel("Selected provider, not runtime status")
        } else if let onSetActive {
            DesignTextButton(
                title: "Select",
                accessibilityId: "settings-secret-\(idKey)-active",
                action: onSetActive
            )
        }
        if !isEditing {
            DesignActionButton(
                title: hasKey ? "Replace key" : "Set key",
                role: .secondary,
                accessibilityId: "settings-secret-\(idKey)-update",
                fillsWidth: false,
                action: onStartEdit
            )
            .focused($editButtonFocused)
            .accessibilityFocused($editButtonAccessibilityFocused)
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
            Text("Write-only: the stored key cannot be viewed. Saving a replacement does not validate it.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
            CenteredFlowLayout(spacing: Space.sm, alignment: .trailing) {
                cancelButton(fillsWidth: false)
                saveButton(fillsWidth: false)
            }
        }
        .padding(DesignMetrics.inlineEditorFormPadding)
        .background {
            DesignCanvasWellKernel(
                shape: .roundedRectangle(cornerRadius: .zero),
                state: .rest,
                showsBorder: false
            )
        }
        .privacySensitive()
    }

    private func cancelButton(fillsWidth: Bool) -> some View {
        DesignActionButton(
            title: "Cancel",
            role: .quiet,
            accessibilityId: "settings-secret-\(idKey)-cancel",
            fillsWidth: fillsWidth,
            action: onCancel
        )
    }

    private func saveButton(fillsWidth: Bool) -> some View {
        DesignActionButton(
            title: "Save key",
            loadingTitle: "Saving…",
            state: canSave ? .normal : isSaving ? .loading : .disabled,
            accessibilityId: "settings-secret-\(idKey)-save",
            fillsWidth: fillsWidth,
            action: { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
        )
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
            Text("Base URL").designText(.label).foregroundStyle(DuskColors.ink2)
            if isEditing { editor } else { presence }
        }
        .padding(.vertical, Space.sm)
        .onChange(of: isEditing) { _, editing in if !editing { draft = "" } }
        .privacySensitive()
        .accessibilityIdentifier("settings-secret-custom-baseurl")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignMaskedField(
                title: "New base URL",
                prompt: "https://api.example.com/v1",
                text: $draft,
                accessibilityId: "settings-secret-custom-baseurl-input",
                keyboard: .URL
            )
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
                .designText(.caption)
                .foregroundStyle(DuskColors.ink2)
                .accessibilityLabel(hasValue ? "Base URL stored; not validated" : "No base URL stored")
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
