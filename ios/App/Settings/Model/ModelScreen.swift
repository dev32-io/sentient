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
// The shared apply bar receives this screen's dirty/save actions; discard and
// dirty-back still use the existing native confirmation and navigation seam.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let providerLabels: [String: String] = [
    "ollama-cloud": "Ollama Cloud",
    "openrouter": "OpenRouter",
    "custom": "Custom",
]

struct ModelScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: ModelViewModel
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: ModelViewModel(settings: settings))
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
            title: "Model", screenId: "settings-model-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-model-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load models", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                selectedModel
                VStack(alignment: .leading, spacing: Space.md) {
                    browseControls
                    modelList
                }
            }
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-model-discard",
            applyAccessibilityId: "settings-model-save",
            onDiscard: attemptBack,
            onApply: { Task { await vm.save() } }
        )
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onBack() }
            Button("Keep editing", role: .cancel) {}
        }
    }

    private var applyState: DesignApplyState {
        switch vm.save {
        case .idle: .idle
        case .saving: .saving
        case .restarting: .restarting
        case .alreadyApplying: .alreadyApplying
        case .applied: .applied
        case .failed(let message): .failed(message)
        }
    }

    private var selectedModel: some View {
        let entry = vm.models.first { $0.id == vm.draftModelId && $0.provider == vm.draftProvider }
        return DesignCard(bodyStyle: .padded) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Label(vm.isDirty ? "Selected model · Unsaved" : "Selected model", systemImage: "checkmark.circle")
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

    private var browseControls: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Browse models")
                .designText(.label)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            if providerSegments.count > 1 {
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
            Text("\(vm.filtered.count) results · \(providerLabels[vm.browseProvider] ?? vm.browseProvider)")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var modelList: some View {
        let list = vm.filtered
        if list.isEmpty {
            Text("No models match. Try another model ID or provider.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, Space.lg)
        } else {
            VStack(spacing: Space.sm) {
                ForEach(list, id: \.id) { entry in
                    ModelCard(
                        entry: entry,
                        isSelected: entry.id == vm.draftModelId && entry.provider == vm.draftProvider,
                        onTap: { vm.select(entry) }
                    )
                }
            }
        }
    }

    private func attemptBack() {
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
