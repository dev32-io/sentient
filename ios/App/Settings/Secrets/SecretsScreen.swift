import SwiftUI
import MobileData

struct SecretsScreen: View {
    @State private var vm: SecretsViewModel

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: SecretsViewModel(admin: settings.admin, applyProfileChange: settings.applyProfileChange))
    }

    var body: some View {
        SecretsBody(
            status: vm.status,
            isError: vm.isError,
            isNotAdmin: vm.isNotAdmin,
            mutationError: vm.mutationError,
            editing: vm.editing,
            isSaving: vm.isSavingKey,
            apply: vm.apply,
            onRetryLoad: { Task { await vm.load() } },
            onSetActive: { provider in Task { await vm.setActive(provider) } },
            onStartEditKey: vm.startEditKey,
            onStartEditBaseUrl: vm.startEditBaseUrl,
            onCancelEdit: vm.cancelEdit,
            onSaveKey: { provider, value in Task { await vm.saveKey(provider, value: value) } },
            onSaveBaseUrl: { url in Task { await vm.saveBaseUrl(url) } },
            onApplyNow: { Task { await vm.applyNow() } },
            onDismissNotice: vm.dismissNotice
        )
        .task { await vm.load() }
    }
}

private struct SecretsBody: View {
    let status: SecretsStatus?
    let isError: Bool
    let isNotAdmin: Bool
    let mutationError: String?
    let editing: SecretsViewModel.EditTarget
    let isSaving: Bool
    let apply: SecretsViewModel.ApplyPhase
    let onRetryLoad: () -> Void
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
            if let mutationError {
                AsyncNotice(kind: .error, title: "Secret change failed", detail: mutationError)
            }
            content
        }
    }

    @ViewBuilder private var content: some View {
        if isNotAdmin {
            AsyncNotice(
                kind: .warning,
                title: "Admin access required",
                detail: "Your access may have changed. Secret controls are no longer available.",
                retry: onRetryLoad
            )
        } else if let status {
            providerSummary(status)
            DesignCard(
                title: "Provider keys",
                detail: "Key presence only — not a check that credentials work. Saved values are never displayed.",
                headerStyle: .quiet,
                bodyStyle: .rows
            ) {
                keyRow(.openrouter, label: "OpenRouter", status: status, hasKey: status.llm.openrouter.hasKey)
                DesignDivider()
                keyRow(.ollamaCloud, label: "Ollama Cloud", status: status, hasKey: status.llm.ollamaCloud.hasKey)
            }
            DesignCard(
                title: "Custom provider",
                detail: "The Custom key and base URL belong together. Save each value here, then select Custom to save your provider selection.",
                headerStyle: .quiet,
                bodyStyle: .rows
            ) {
                keyRow(.custom, label: "Custom", status: status, hasKey: status.llm.custom.hasKey)
                DesignDivider()
                SecretUrlRow(
                    hasValue: status.llm.custom.hasBaseUrl,
                    isEditing: editing == .customBaseUrl,
                    isSaving: isSaving,
                    onStartEdit: onStartEditBaseUrl,
                    onCancel: onCancelEdit,
                    onSave: onSaveBaseUrl
                )
            }
            if apply != .hidden {
                RestartNotice(phase: apply, onApply: onApplyNow, onDismiss: onDismissNotice)
            }
        } else if isError {
            AsyncNotice(kind: .error, title: "Couldn't load provider keys", detail: "Check your connection and try again.", retry: onRetryLoad)
        } else {
            AsyncNotice(kind: .loading, title: "Loading provider keys")
        }
    }

    private func providerSummary(_ status: SecretsStatus) -> some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Selected provider · \(providerLabel(status.llm.active))")
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Text("Provider selection is saved when selected; keys are saved with Save. Applying configuration does not test credentials or verify the running connection.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
        }
    }

    private func providerLabel(_ raw: String) -> String {
        switch SecretsViewModel.Provider(rawValue: raw) {
        case .openrouter: "OpenRouter"
        case .ollamaCloud: "Ollama Cloud"
        case .custom: "Custom"
        case nil: raw
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

private struct RestartNotice: View {
    let phase: SecretsViewModel.ApplyPhase
    let onApply: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            AsyncNotice(kind: noticeKind, title: title, detail: detail)
            if phase != .applying && phase != .applied {
                HStack(spacing: Space.sm) {
                    DesignActionButton(
                        title: phase.isFailed ? "Retry apply" : "Apply now",
                        accessibilityId: "settings-secrets-apply",
                        action: onApply
                    )
                    DesignTextButton(
                        title: "Dismiss",
                        accessibilityId: "settings-secrets-notice-dismiss",
                        action: onDismiss
                    )
                }
            }
        }
        .accessibilityIdentifier("settings-secrets-restart-notice")
    }

    private var noticeKind: DesignNoticeKind {
        switch phase {
        case .applying: .loading
        case .applied: .success
        case .alreadyApplying: .warning
        case .failed: .error
        case .notice, .hidden: .warning
        }
    }
    private var title: String {
        switch phase {
        case .applying: "Applying configuration…"
        case .applied: "Configuration applied"
        case .alreadyApplying: "Already applying"
        case .failed: "Couldn't apply configuration"
        case .notice, .hidden: "Apply saved configuration"
        }
    }
    private var detail: String? {
        switch phase {
        case .alreadyApplying: "Try again when the current apply finishes."
        case .failed(let message): message
        case .notice: "Your provider selection and key changes are saved. Applying configuration does not test credentials or verify the running connection; saved credentials remain hidden."
        default: nil
        }
    }
}

extension SecretsViewModel.ApplyPhase {
    var isFailed: Bool { if case .failed = self { return true }; return false }
}

private func secretPreviewStatus(active: String) -> SecretsStatus {
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

#Preview("Ready — large text") {
    NavigationStack {
        SecretsBody(
            status: secretPreviewStatus(active: "openrouter"), isError: false, isNotAdmin: false,
            mutationError: nil, editing: .none, isSaving: false, apply: .notice,
            onRetryLoad: {}, onSetActive: { _ in }, onStartEditKey: { _ in }, onStartEditBaseUrl: {},
            onCancelEdit: {}, onSaveKey: { _, _ in }, onSaveBaseUrl: { _ in }, onApplyNow: {}, onDismissNotice: {}
        )
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}

#Preview("Not admin") {
    NavigationStack {
        SecretsBody(
            status: nil, isError: false, isNotAdmin: true, mutationError: nil, editing: .none,
            isSaving: false, apply: .hidden, onRetryLoad: {}, onSetActive: { _ in },
            onStartEditKey: { _ in }, onStartEditBaseUrl: {}, onCancelEdit: {},
            onSaveKey: { _, _ in }, onSaveBaseUrl: { _ in }, onApplyNow: {}, onDismissNotice: {}
        )
    }
}
