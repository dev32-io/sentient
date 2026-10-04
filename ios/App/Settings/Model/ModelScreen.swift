// ---------------------------------------------------------------------------
// ModelScreen — Soul-group "Model" category page. Provider segmented + a search
// field + a single-select model card list (each card shows id, context window,
// and Tools/Vision capability chips). SLOW save (PUT profile → apply-with-restart)
// surfaced by the applying banner.
//
// Price (a kotlinx JsonPrimitive on the wire) is intentionally not rendered in
// this pass — the JsonPrimitive `.content` SKIE bridge is unverified and price is
// not on the parity E2E path; id + context + caps carry the single-select intent.
//
// Discard restores drafts in place; Back separately confirms dirty navigation.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let providerLabels: [String: String] = [
    "ollama-cloud": "Ollama Cloud",
    "openrouter": "OpenRouter",
    "custom": "Custom",
]

struct ModelScreen: View {
    let onBack: () -> Void
    let auxiliaryOnly: Bool

    private var accessibilityPrefix: String { auxiliaryOnly ? "settings-auxiliary" : "settings-model" }

    @State private var vm: ModelViewModel
    @State private var showDiscard = false
    @State private var mutationTask: Task<Void, Never>?
    @State private var choosingRunner: ModelViewModel.AuxiliaryRunner?

    init(settings: SettingsComponent, auxiliaryOnly: Bool = false, onBack: @escaping () -> Void) {
        self.init(viewModel: ModelViewModel(settings: settings), auxiliaryOnly: auxiliaryOnly, onBack: onBack)
    }

    init(viewModel: ModelViewModel, auxiliaryOnly: Bool = false, onBack: @escaping () -> Void) {
        self.auxiliaryOnly = auxiliaryOnly
        self.onBack = onBack
        _vm = State(initialValue: viewModel)
    }

    private var providerSegments: [SegmentOption] {
        // The catalog need not contain the saved provider. Keep its raw value browsable.
        var providers = vm.providerOptions
        if !vm.draftProvider.isEmpty && !providers.contains(vm.draftProvider) {
            providers.append(vm.draftProvider)
        }
        return providers.map { SegmentOption(id: $0, label: providerLabels[$0] ?? $0) }
    }

    var body: some View {
        SettingsPageScaffold(
            title: auxiliaryOnly ? "Auxiliary runners" : "Model", screenId: "\(accessibilityPrefix)-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty && !vm.isApplying,
            backAccessibilityId: "\(accessibilityPrefix)-back"
        ) {
            if vm.hasPendingApply && vm.phase == .ready && !vm.isDirty {
                AsyncNotice(kind: .warning, title: "Profile saved; application unresolved",
                            detail: "Retry applies the saved profile without saving it again.") {
                    runMutation { await vm.retryApply() }
                }
            }
            switch vm.phase {
            case .loading:
                SoulLoadingRow(title: auxiliaryOnly ? "Loading auxiliary runners" : "Loading models")
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load models", detail: message) {
                    runMutation { await vm.load() }
                }
            case .ready:
                if auxiliaryOnly {
                    auxiliaryRunners
                } else {
                    selectedModel
                    modelBrowser(for: nil)
                }
            }
        }
        .disabled(vm.isApplying)
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "\(accessibilityPrefix)-discard",
            applyAccessibilityId: "\(accessibilityPrefix)-save",
            onDiscard: vm.discard,
            onApply: { runMutation { await vm.save() } }
        )
        .task { await vm.load() }
        .onDisappear { mutationTask?.cancel() }
        .sheet(isPresented: Binding(get: { choosingRunner != nil }, set: { if !$0 { choosingRunner = nil } })) {
            if let runner = choosingRunner {
                NavigationStack {
                    ScrollView { modelBrowser(for: runner).padding(Space.lg) }
                        .background(DuskColors.bg)
                        .navigationTitle("Choose \(runner.title) model")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { choosingRunner = nil }
                            }
                        }
                        .duskTheme()
                }
            }
        }
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

    private var selectedModel: some View {
        let entry = vm.models.first { $0.id == vm.draftModelId && $0.provider == vm.draftProvider }
        return DesignCard(bodyStyle: .padded) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Label(vm.isMainModelDirty ? "Selected model · Unsaved" : "Selected model", systemImage: "checkmark.circle")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityAddTraits(.isHeader)
                Text(providerLabels[vm.draftProvider] ?? vm.draftProvider)
                    .designText(.label)
                    .foregroundStyle(DuskColors.ink2)
                Text(vm.draftModelId)
                    .designText(.large)
                    .fontWeight(.medium)
                    .foregroundStyle(DuskColors.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let entry {
                    ModelMetadata(entry: entry)
                } else {
                    Text("Not listed in the current catalog. Your selection is preserved.")
                        .designText(.supporting)
                        .foregroundStyle(DuskColors.ink2)
                }
            }
        }
    }

    private var auxiliaryRunners: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            VStack(alignment: .leading, spacing: .zero) {
                Text("Auxiliary runners")
                    .designText(.label)
                    .fontWeight(.semibold)
                    .foregroundStyle(DuskColors.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Optional models for background work. Choices use your chat model's configured provider.")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(ModelViewModel.AuxiliaryRunner.allCases, id: \.self) { runner in
                auxiliaryRow(runner)
            }
        }
    }

    private func auxiliaryRow(_ runner: ModelViewModel.AuxiliaryRunner) -> some View {
        let selection = vm.auxiliarySelection(for: runner)
        return DesignCard(bodyStyle: .settingsGroup) {
            DesignSettingsRow(title: runner.title, detail: selection?.id ?? runner.defaultLabel) {
                CenteredFlowLayout(spacing: Space.sm, alignment: .trailing) {
                    DesignActionButton(
                        title: "Choose", role: .quiet,
                        state: vm.isApplying ? .disabled : .normal,
                        accessibilityId: "settings-model-auxiliary-\(runner.accessibilityKey)",
                        fillsWidth: false
                    ) {
                        guard !vm.isApplying else { return }
                        vm.browseProvider = vm.draftProvider
                        vm.query = ""
                        choosingRunner = runner
                    }
                    DesignActionButton(
                        title: "Reset", role: .quiet,
                        state: selection != nil && !vm.isApplying ? .normal : .disabled,
                        accessibilityId: "settings-model-auxiliary-\(runner.accessibilityKey)-reset",
                        fillsWidth: false,
                        action: { vm.selectAuxiliary(nil, for: runner) }
                    )
                }
            }
        }
    }

    private func modelBrowser(for runner: ModelViewModel.AuxiliaryRunner?) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            browseControls
            modelList(for: runner)
        }
    }

    private var browseControls: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Browse models")
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            if choosingRunner == nil && providerSegments.count > 1 {
                DesignSegmentedPicker(
                    title: "Model provider",
                    options: providerSegments.map { (value: $0.id, label: $0.label) },
                    selection: Binding(get: { vm.browseProvider }, set: { vm.browseProvider = $0 }),
                    accessibilityId: "settings-model-provider"
                )
            }
            DesignSearchField(
                prompt: "Search model IDs…",
                query: Binding(get: { vm.query }, set: { vm.query = $0 }),
                accessibilityId: "settings-model-search"
            )
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            Text("\(browseModels(for: choosingRunner).count) results · \(providerLabels[vm.browseProvider] ?? vm.browseProvider)")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func modelList(for runner: ModelViewModel.AuxiliaryRunner?) -> some View {
        let list = browseModels(for: runner)
        if list.isEmpty {
            Text("No models match. Try another model ID or provider.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, Space.lg)
        } else {
            LazyVStack(spacing: Space.sm) {
                ForEach(list, id: \.id) { entry in
                    ModelCard(
                        entry: entry,
                        isSelected: runner.map { vm.auxiliarySelection(for: $0) == AuxiliaryModelSelection(provider: entry.provider, id: entry.id) }
                            ?? (entry.id == vm.draftModelId && entry.provider == vm.draftProvider),
                        onTap: {
                            guard !vm.isApplying else { return }
                            if let runner {
                                vm.selectAuxiliary(entry, for: runner)
                                choosingRunner = nil
                            } else {
                                vm.select(entry)
                            }
                        }
                    )
                }
            }
        }
    }

    private func browseModels(for runner: ModelViewModel.AuxiliaryRunner?) -> [ModelEntry] {
        guard let runner else { return vm.filtered }
        return vm.auxiliaryOptions(for: runner).filter {
            vm.query.isEmpty || $0.id.localizedCaseInsensitiveContains(vm.query)
        }
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

/// One selectable model card: id + context window + capability chips.
private struct ModelCard: View {
    let entry: ModelEntry
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        DesignSelectableCard(
            isSelected: isSelected,
            accessibilityLabel: "Model \(entry.id)",
            accessibilityId: "settings-model-card-\(entry.id)",
            action: onTap
        ) {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text(entry.id)
                        .designText(.label)
                        .fontWeight(.medium)
                        .foregroundStyle(DuskColors.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                    Spacer(minLength: Space.sm)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(DuskColors.accent)
                            .accessibilityHidden(true)
                    }
                }
                ModelMetadata(entry: entry)
            }
        }
    }
}

/// Catalog values only: zero is the SDK default and Ollama's unlisted context value.
private struct ModelMetadata: View {
    let entry: ModelEntry

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.md) { items }
            VStack(alignment: .leading, spacing: Space.xs) { items }
        }
        .designText(.supporting)
        .foregroundStyle(DuskColors.ink2)
    }

    @ViewBuilder
    private var items: some View {
        if entry.contextLength > 0 {
            Text("\(Int(entry.contextLength).formatted()) tokens context")
        } else {
            Text("Context unavailable")
        }
        if entry.supportsTools { Label("Tools", systemImage: "wrench.and.screwdriver") }
        if entry.supportsVision { Label("Vision", systemImage: "eye") }
    }
}

// Preview the browse controls only — a ModelCard needs a wire ModelEntry (whose
// price is a kotlinx JsonPrimitive that is awkward to build from Swift), so the
// list is exercised live rather than in-preview.
#Preview("browse") {
    NavigationStack {
        SettingsPageScaffold(title: "Model", screenId: "settings-model-screen") {
            DesignSegmentedPicker(
                title: "Model provider",
                options: [(value: "ollama-cloud", label: "Ollama Cloud"), (value: "openrouter", label: "OpenRouter")],
                selection: .constant("openrouter"),
                accessibilityId: "settings-model-provider"
            )
            Text("No models match. Try another model ID or provider.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
        }
    }
    .preferredColorScheme(.dark)
}
