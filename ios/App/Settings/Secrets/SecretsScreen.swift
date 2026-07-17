// ---------------------------------------------------------------------------
// SecretsScreen — Admin "Secrets" category page. Per-provider masked key rows
// (OpenRouter, Ollama Cloud, Custom + base URL): presence status, Update key,
// Set active. After any successful change, an inline "Restart assistant to pick
// up the new key" notice offers Apply now (bare apply → worker restart). Keys are
// never echoed or logged.
//
// Owns the @Observable SecretsViewModel via @State; SecretsBody is stateless
// (previewable with a fake SecretsStatus).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct SecretsScreen: View {
    @State private var vm: SecretsViewModel
    private let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: SecretsViewModel(
            admin: settings.admin,
            applyProfileChange: settings.applyProfileChange
        ))
    }

    var body: some View {
        SecretsBody(
            status: vm.status,
            isError: vm.isError,
            editing: vm.editing,
            isSaving: vm.isSavingKey,
            apply: vm.apply,
            onSetActive: { provider in Task { await vm.setActive(provider) } },
            onStartEditKey: { provider in vm.startEditKey(provider) },
            onStartEditBaseUrl: { vm.startEditBaseUrl() },
            onCancelEdit: { vm.cancelEdit() },
            onSaveKey: { provider, value in Task { await vm.saveKey(provider, value: value) } },
            onSaveBaseUrl: { url in Task { await vm.saveBaseUrl(url) } },
            onApplyNow: { Task { await vm.applyNow() } },
            onDismissNotice: { vm.dismissNotice() }
        )
        .task { await vm.load() }
    }
}

/// Stateless Secrets body: provider key card + restart-notice banner.
private struct SecretsBody: View {
    let status: SecretsStatus?
    let isError: Bool
    let editing: SecretsViewModel.EditTarget
    let isSaving: Bool
    let apply: SecretsViewModel.ApplyPhase
    let onSetActive: (SecretsViewModel.Provider) -> Void
    let onStartEditKey: (SecretsViewModel.Provider) -> Void
    let onStartEditBaseUrl: () -> Void
    let onCancelEdit: () -> Void
    let onSaveKey: (SecretsViewModel.Provider, String) -> Void
    let onSaveBaseUrl: (String) -> Void
    let onApplyNow: () -> Void
    let onDismissNotice: () -> Void

    var body: some View {
        SettingsPageScaffold(title: "Secrets", screenId: "settings-secrets-screen") {
            if apply != .hidden { RestartNotice(phase: apply, onApply: onApplyNow, onDismiss: onDismissNotice) }
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        if let status {
            SettingsCard(title: "Provider keys", sub: "Encrypted at rest. Shared by the household gateway.") {
                keyRow(.openrouter, label: "OpenRouter", status: status, hasKey: status.llm.openrouter.hasKey)
                Divider().overlay(DuskColors.lineSoft)
                keyRow(.ollamaCloud, label: "Ollama Cloud", status: status, hasKey: status.llm.ollamaCloud.hasKey)
                Divider().overlay(DuskColors.lineSoft)
                keyRow(.custom, label: "Custom", status: status, hasKey: status.llm.custom.hasKey)
                SecretUrlRow(
                    hasValue: status.llm.custom.hasBaseUrl,
                    isEditing: editing == .customBaseUrl,
                    isSaving: isSaving,
                    onStartEdit: onStartEditBaseUrl,
                    onCancel: onCancelEdit,
                    onSave: onSaveBaseUrl
                )
            }
        } else if isError {
            Text("Couldn't load provider keys.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
                .padding(.vertical, Space.md)
        } else {
            ProgressView().controlSize(.small).padding(.vertical, Space.md)
        }
    }

    private func keyRow(
        _ provider: SecretsViewModel.Provider,
        label: String,
        status: SecretsStatus,
        hasKey: Bool
    ) -> some View {
        let active = status.llm.active == provider.rawValue
        return SecretKeyRow(
            label: label,
            idKey: provider.rawValue,
            hasKey: hasKey,
            isActive: active,
            isEditing: editing == .key(provider),
            isSaving: isSaving,
            onSetActive: active ? nil : { onSetActive(provider) },
            onStartEdit: { onStartEditKey(provider) },
            onCancel: onCancelEdit,
            onSave: { onSaveKey(provider, $0) }
        )
    }
}

/// The restart-notice banner: raised after a key change; Apply now restarts the worker.
private struct RestartNotice: View {
    let phase: SecretsViewModel.ApplyPhase
    let onApply: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            content
            Spacer(minLength: Space.sm)
            trailing
        }
        .padding(Space.md)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
        .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft, lineWidth: 1))
        .accessibilityIdentifier("settings-secrets-restart-notice")
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .applying:
            Label("Applying — assistant restarting…", systemImage: "arrow.triangle.2.circlepath")
                .font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink2)
        case .applied:
            Label("Assistant restarted", systemImage: "checkmark")
                .font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ok)
        case .alreadyApplying:
            Text("Already applying — try again shortly.")
                .font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.amber)
        case .failed(let message):
            Text(message).font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.stop)
        case .notice, .hidden:
            Text("Restart the assistant to pick up the new key.")
                .font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink2)
        }
    }

    @ViewBuilder
    private var trailing: some View {
        switch phase {
        case .applying:
            ProgressView().controlSize(.small)
        case .applied:
            EmptyView()
        case .notice, .alreadyApplying, .failed, .hidden:
            HStack(spacing: Space.sm) {
                Button(phase.isFailed ? "Retry" : "Apply now", action: onApply)
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.accent)
                    .accessibilityIdentifier("settings-secrets-apply")
                Button(action: onDismiss) { Image(systemName: "xmark").font(.system(size: TypeScale.xs)) }
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityIdentifier("settings-secrets-notice-dismiss")
            }
        }
    }
}

private extension SecretsViewModel.ApplyPhase {
    var isFailed: Bool { if case .failed = self { return true }; return false }
}

// ── Previews — Secrets states (no VM) ────────────────────────────────────────

private func sampleStatus(active: String) -> SecretsStatus {
    SecretsStatus(
        llm: LlmSecretsStatus(
            active: active,
            ollamaCloud: LlmProviderStatus(hasKey: true, hasBaseUrl: false),
            openrouter: LlmProviderStatus(hasKey: true, hasBaseUrl: false),
            custom: LlmProviderStatus(hasKey: false, hasBaseUrl: false)
        ),
        homeAssistant: HomeAssistantStatus(
            url: nil,
            observeToken: TokenPresence(hasToken: false),
            mcpServerToken: TokenPresence(hasToken: false)
        ),
        musicAssistant: MusicAssistantStatus(url: nil, hasToken: false)
    )
}

#Preview("ready") {
    NavigationStack {
        SecretsBody(
            status: sampleStatus(active: "openrouter"), isError: false, editing: .none,
            isSaving: false, apply: .hidden,
            onSetActive: { _ in }, onStartEditKey: { _ in }, onStartEditBaseUrl: {},
            onCancelEdit: {}, onSaveKey: { _, _ in }, onSaveBaseUrl: { _ in },
            onApplyNow: {}, onDismissNotice: {}
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("restart-notice") {
    NavigationStack {
        SecretsBody(
            status: sampleStatus(active: "ollama-cloud"), isError: false, editing: .none,
            isSaving: false, apply: .notice,
            onSetActive: { _ in }, onStartEditKey: { _ in }, onStartEditBaseUrl: {},
            onCancelEdit: {}, onSaveKey: { _, _ in }, onSaveBaseUrl: { _ in },
            onApplyNow: {}, onDismissNotice: {}
        )
    }
    .preferredColorScheme(.dark)
}
