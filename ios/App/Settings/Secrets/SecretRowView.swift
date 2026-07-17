// ---------------------------------------------------------------------------
// SecretRowView — one provider's key row + the Custom base-URL sub-row,
// transcribed from the webui secret-row.tsx. Presence-only: a status dot +
// masked placeholder (never the key), an active badge / "Set active" link, and
// an Update → secure field → Save/Cancel flow. The draft is local @State and
// never leaves the row; the parent owns which row is editing (one at a time).
//
// Stateless w.r.t. business state: takes booleans + closures. `onSave` hands the
// entered value up; the VM PUTs it and refetches.
// ---------------------------------------------------------------------------
import SwiftUI

private let maskedPlaceholder = "••••••••••••"

/// A provider key row (OpenRouter / Ollama Cloud / Custom key).
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
            header
            if isEditing { editor } else { maskedLine }
        }
        .padding(.vertical, Space.sm)
        .onChange(of: isEditing) { _, editing in if !editing { draft = "" } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-secret-\(idKey)")
    }

    private var header: some View {
        HStack(spacing: Space.sm) {
            Circle().fill(hasKey ? DuskColors.ok : DuskColors.ink4).frame(width: 8, height: 8)
            Text(label).font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink)
            if isActive {
                Text("active")
                    .font(Typo.ui(TypeScale.xs, .semibold))
                    .foregroundStyle(DuskColors.accent)
            } else if let onSetActive {
                Button("Set active", action: onSetActive)
                    .font(Typo.ui(TypeScale.xs, .semibold))
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityIdentifier("settings-secret-\(idKey)-active")
            }
            Spacer(minLength: Space.sm)
            if !isEditing {
                Button("Update", action: onStartEdit)
                    .font(Typo.ui(TypeScale.xs, .semibold))
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityIdentifier("settings-secret-\(idKey)-update")
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            SecureField("Paste new key…", text: $draft)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                .accessibilityIdentifier("settings-secret-\(idKey)-input")
            HStack(spacing: Space.md) {
                Button("Save") { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(canSave ? DuskColors.accent : DuskColors.ink4)
                    .disabled(!canSave)
                    .accessibilityIdentifier("settings-secret-\(idKey)-save")
                Button("Cancel", action: onCancel)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
            }
        }
    }

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    private var maskedLine: some View {
        Text(hasKey ? maskedPlaceholder : "Not configured")
            .font(Typo.mono(TypeScale.sm))
            .foregroundStyle(hasKey ? DuskColors.ink2 : DuskColors.ink4)
    }
}

/// The Custom provider's Base URL sub-row (plain URL, presence-only masked).
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
            HStack(spacing: Space.sm) {
                Text("Base URL").font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink2)
                Spacer(minLength: Space.sm)
                if !isEditing {
                    Button("Update", action: onStartEdit)
                        .font(Typo.ui(TypeScale.xs, .semibold))
                        .foregroundStyle(DuskColors.ink2)
                        .accessibilityIdentifier("settings-secret-custom-baseurl-update")
                }
            }
            if isEditing { editor } else { maskedLine }
        }
        .padding(.vertical, Space.sm)
        .onChange(of: isEditing) { _, editing in if !editing { draft = "" } }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            TextField("https://api.example.com/v1", text: $draft)
                .font(Typo.mono(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                .accessibilityIdentifier("settings-secret-custom-baseurl-input")
            HStack(spacing: Space.md) {
                Button("Save") { onSave(draft.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(canSave ? DuskColors.accent : DuskColors.ink4)
                    .disabled(!canSave)
                    .accessibilityIdentifier("settings-secret-custom-baseurl-save")
                Button("Cancel", action: onCancel)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
            }
        }
    }

    private var canSave: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    private var maskedLine: some View {
        Text(hasValue ? maskedPlaceholder : "Not set")
            .font(Typo.mono(TypeScale.sm))
            .foregroundStyle(hasValue ? DuskColors.ink2 : DuskColors.ink4)
    }
}

#Preview("rows") {
    ScrollView {
        VStack(spacing: 0) {
            SecretKeyRow(
                label: "OpenRouter", idKey: "openrouter", hasKey: true, isActive: true,
                isEditing: false, isSaving: false, onSetActive: nil,
                onStartEdit: {}, onCancel: {}, onSave: { _ in }
            )
            SecretKeyRow(
                label: "Ollama Cloud", idKey: "ollama-cloud", hasKey: false, isActive: false,
                isEditing: true, isSaving: false, onSetActive: {},
                onStartEdit: {}, onCancel: {}, onSave: { _ in }
            )
            SecretUrlRow(hasValue: false, isEditing: false, isSaving: false, onStartEdit: {}, onCancel: {}, onSave: { _ in })
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
