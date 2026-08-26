import SwiftUI

let secretPresenceMask = "••••••••••••"

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

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Image(systemName: hasKey ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(hasKey ? DuskColors.ok : DuskColors.ink4)
                    .accessibilityHidden(true)
                Text(label).designText(.body).foregroundStyle(DuskColors.ink)
                Spacer(minLength: Space.sm)
                if isActive {
                    Label("Active", systemImage: "checkmark")
                        .designText(.supporting)
                        .foregroundStyle(DuskColors.accent)
                }
            }
            if isEditing { editor } else { presence }
        }
        .padding(.vertical, Space.sm)
        .onChange(of: isEditing) { _, editing in if !editing { draft = "" } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-secret-\(idKey)")
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignMaskedField(
                title: "New key",
                prompt: "Paste new key",
                text: $draft,
                accessibilityId: "settings-secret-\(idKey)-input",
                autoFocus: true
            )
            HStack(spacing: Space.sm) {
                DesignActionButton(
                    title: "Save",
                    state: canSave ? .normal : isSaving ? .loading : .disabled,
                    accessibilityId: "settings-secret-\(idKey)-save",
                    action: { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                )
                Button("Cancel", action: onCancel)
                    .buttonStyle(DesignButtonStyle(role: .quiet))
            }
        }
    }

    private var presence: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(hasKey ? secretPresenceMask : "Not configured")
                .designText(.telemetry)
                .foregroundStyle(hasKey ? DuskColors.ink2 : DuskColors.ink4)
                .accessibilityLabel(hasKey ? "Key configured" : "Key not configured")
            HStack(spacing: Space.sm) {
                if let onSetActive, !isActive {
                    Button("Set active", action: onSetActive)
                        .buttonStyle(DesignButtonStyle(role: .quiet))
                        .accessibilityIdentifier("settings-secret-\(idKey)-active")
                }
                Button("Update key", action: onStartEdit)
                    .buttonStyle(DesignButtonStyle(role: .quiet))
                    .accessibilityIdentifier("settings-secret-\(idKey)-update")
            }
        }
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
                Button("Cancel", action: onCancel)
                    .buttonStyle(DesignButtonStyle(role: .quiet))
            }
        }
    }

    private var presence: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(hasValue ? secretPresenceMask : "Not set")
                .designText(.telemetry)
                .foregroundStyle(hasValue ? DuskColors.ink2 : DuskColors.ink4)
                .accessibilityLabel(hasValue ? "Base URL configured" : "Base URL not configured")
            Button("Update base URL", action: onStartEdit)
                .buttonStyle(DesignButtonStyle(role: .quiet))
                .accessibilityIdentifier("settings-secret-custom-baseurl-update")
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
