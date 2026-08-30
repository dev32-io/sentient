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

private let contextPerK = 1000

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
        vm.providerOptions.map { SegmentOption(id: $0, label: providerLabels[$0] ?? $0) }
    }

    var body: some View {
        SettingsPageScaffold(title: "Model", screenId: "settings-model-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load models", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                browseControls
                modelList
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
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that shares the apply bar's discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-model-back", action: attemptBack)
                }
            }
        }
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

    @ViewBuilder
    private var browseControls: some View {
        if providerSegments.count > 1 {
            DesignSegmentedPicker(
                title: "Model provider",
                options: providerSegments.map { (value: $0.id, label: $0.label) },
                selection: Binding(get: { vm.browseProvider }, set: { vm.browseProvider = $0 }),
                accessibilityId: "settings-model-provider"
            )
        }
        DesignSearchField(
            prompt: "Search models…",
            query: Binding(get: { vm.query }, set: { vm.query = $0 }),
            accessibilityId: "settings-model-search"
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    }

    @ViewBuilder
    private var modelList: some View {
        let list = vm.filtered
        if list.isEmpty {
            Text("No models match.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink3)
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
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(1)
                    Spacer(minLength: Space.sm)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(DuskColors.accent)
                            .accessibilityHidden(true)
                    }
                }
                ViewThatFits(in: .horizontal) {
                    capabilitySummary
                    VStack(alignment: .leading, spacing: Space.xs) { capabilityItems }
                }
            }
        }
    }

    private var capabilitySummary: some View {
        HStack(spacing: Space.sm) { capabilityItems }
    }

    @ViewBuilder
    private var capabilityItems: some View {
        Text("\(entry.contextLength / Int32(contextPerK))k context")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
        if entry.supportsTools { capabilityLabel("Tools", systemImage: "wrench.and.screwdriver") }
        if entry.supportsVision { capabilityLabel("Vision", systemImage: "eye") }
    }

    private func capabilityLabel(_ label: String, systemImage: String) -> some View {
        Label(label, systemImage: systemImage)
            .designText(.supporting)
            .fontWeight(.medium)
            .foregroundStyle(DuskColors.ink2)
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
            Text("No models match.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink3)
        }
    }
    .preferredColorScheme(.dark)
}
