// ---------------------------------------------------------------------------
// AdvancedScreen — Soul-group "Advanced" category page. Reasoning select
// (none…xhigh), Compression slider (0–1 / 0.05), Max-tokens slider
// (128–8192 / 128), and the extra-system-prompt mono editor. SLOW save
// (PUT profile → apply-with-restart) — the applying banner shows while the
// assistant restarts.
//
// Discard restores drafts in place; Back separately confirms dirty navigation.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let reasoningLabels: [String: String] = [
    "none": "None", "minimal": "Minimal", "low": "Low",
    "medium": "Medium", "high": "High", "xhigh": "Extra high",
]

private let compressionRange: ClosedRange<Double> = 0...1
private let compressionStep = 0.05
private let maxTokensRange: ClosedRange<Double> = 128...8192
private let maxTokensStep: Double = 128

struct AdvancedScreen: View {
    let onBack: () -> Void

    @State private var vm: AdvancedViewModel
    @State private var showDiscard = false
    @State private var mutationTask: Task<Void, Never>?

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.init(viewModel: AdvancedViewModel(settings: settings), onBack: onBack)
    }

    init(viewModel: AdvancedViewModel, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: viewModel)
    }

    private var reasoningOptions: [SelectOption] {
        var values = ProfileEnums.shared.reasoningEfforts
        if !values.contains(vm.reasoningEffort) { values.append(vm.reasoningEffort) }
        return values.map { SelectOption(id: $0, label: reasoningLabels[$0] ?? $0) }
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Advanced", screenId: "settings-advanced-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty && !vm.isApplying,
            backAccessibilityId: "settings-advanced-back"
        ) {
            if vm.hasPendingApply && vm.phase == .ready && !vm.isDirty {
                AsyncNotice(kind: .warning, title: "Profile saved; application unresolved",
                            detail: "Retry applies the saved profile without saving it again.") {
                    runMutation { await vm.retryApply() }
                }
            }
            switch vm.phase {
            case .loading:
                SoulLoadingRow(title: "Loading advanced settings")
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load advanced settings", detail: message) {
                    runMutation { await vm.load() }
                }
            case .ready:
                tuningSections
                promptCard
            }
        }
        .disabled(vm.isApplying)
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-advanced-discard",
            applyAccessibilityId: "settings-advanced-save",
            onDiscard: vm.discard,
            onApply: { runMutation { await vm.save() } }
        )
        .task { await vm.load() }
        .onDisappear { mutationTask?.cancel() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                guard !vm.isApplying else { return }
                vm.discard()
                onBack()
            }
            Button("Keep editing", role: .cancel) {}
        }
    }

    private var applyState: DesignApplyState { vm.save }

    private var tuningSections: some View {
        DesignCard(title: "Context", bodyStyle: .settingsGroup) {
            DesignSettingsSelectRow(
                title: "Reasoning",
                detail: "Higher effort can improve difficult answers, but may take longer and cost more.",
                options: reasoningOptions.map { (value: $0.id, label: $0.label) },
                selection: Binding(get: { vm.reasoningEffort }, set: { vm.reasoningEffort = $0 }),
                accessibilityId: "settings-advanced-reasoning"
            )
            DesignSettingsSliderRow(
                title: "Compression threshold",
                detail: "Summarize context when usage reaches this fraction of the model's window.",
                value: Binding(get: { vm.threshold }, set: { vm.threshold = $0 }),
                range: compressionRange, step: compressionStep,
                format: { String(format: "%.2f", $0) },
                accessibilityId: "settings-advanced-compression"
            )
            DesignSettingsSliderRow(
                title: "Max tokens",
                detail: "Saved with your profile. Chat response limits are managed separately by the gateway.",
                value: Binding(get: { vm.maxTokens }, set: { vm.maxTokens = $0 }),
                range: maxTokensRange, step: maxTokensStep,
                format: { "\(Int32($0.rounded()).formatted()) tokens" },
                accessibilityId: "settings-advanced-max-tokens"
            )
        }
    }

    private var promptCard: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Optional instructions")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .accessibilityAddTraits(.isHeader)
            DesignSettingsEditor(
                title: "Additional instructions",
                detail: "Included with each request. Use sparingly because this reduces available context."
            ) {
                DesignMultilineEditor(
                    text: Binding(get: { vm.extraSystemPrompt }, set: { vm.extraSystemPrompt = $0 }),
                    placeholder: "Optional extra instructions…",
                    accessibilityId: "settings-advanced-extra-prompt"
                )
            }
        }
        .padding(.top, Space.sm)
    }

    private func runMutation(_ operation: @escaping @MainActor () async -> Void) {
        guard mutationTask == nil else { return }
        mutationTask = Task {
            await operation()
            mutationTask = nil
        }
    }

    private func attemptBack() {
        guard !vm.isApplying else { return }
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}
