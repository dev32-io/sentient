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
// Save chrome + discard-on-dirty-back are shared SoulPageChrome pieces; nav
// wiring lives in UserSessionHost. This file fills the body + owns its VM only.
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
                SoulInlineError(message: message)
            case .ready:
                saveBanner
                browseControls
                modelList
            }
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-model-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-model-save") {
                        Task { await vm.save() }
                    }
                }
            }
        }
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onBack() }
            Button("Keep editing", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var saveBanner: some View {
        switch vm.save {
        case .idle: EmptyView()
        case .saving: SoulApplyingBanner(text: "Saving…")
        case .restarting: SoulApplyingBanner(text: "Applying — assistant restarting…")
        case .alreadyApplying: SoulNoticeBanner(text: soulAlreadyApplyingText)
        case .failed(let message): SoulInlineError(message: message)
        }
    }

    @ViewBuilder
    private var browseControls: some View {
        if providerSegments.count > 1 {
            RowSegmented(
                options: providerSegments,
                selectedId: vm.browseProvider,
                accessibilityId: "settings-model-provider",
                onSelect: { vm.browseProvider = $0 }
            )
        }
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass").foregroundStyle(DuskColors.ink3)
            TextField("Search models…", text: Binding(get: { vm.query }, set: { vm.query = $0 }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("settings-model-search")
        }
        .padding(Space.sm)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
    }

    @ViewBuilder
    private var modelList: some View {
        let list = vm.filtered
        if list.isEmpty {
            Text("No models match.")
                .font(Typo.ui(TypeScale.sm))
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
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack {
                    Text(entry.id)
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(DuskColors.ink)
                        .lineLimit(1)
                    Spacer(minLength: Space.sm)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(DuskColors.accent)
                    }
                }
                HStack(spacing: Space.sm) {
                    Text("\(entry.contextLength / Int32(contextPerK))k context")
                        .font(Typo.ui(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink3)
                    if entry.supportsTools { capChip("Tools") }
                    if entry.supportsVision { capChip("Vision") }
                }
            }
            .padding(Space.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(
                RoundedRectangle(cornerRadius: Radii.md)
                    .stroke(isSelected ? DuskColors.accent : DuskColors.lineSoft, lineWidth: isSelected ? 2 : 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-model-card-\(entry.id)")
    }

    private func capChip(_ label: String) -> some View {
        Text(label)
            .font(Typo.ui(TypeScale.xs, .medium))
            .foregroundStyle(DuskColors.ink2)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
    }
}

// Preview the browse controls only — a ModelCard needs a wire ModelEntry (whose
// price is a kotlinx JsonPrimitive that is awkward to build from Swift), so the
// list is exercised live rather than in-preview.
#Preview("browse") {
    NavigationStack {
        SettingsPageScaffold(title: "Model", screenId: "settings-model-screen") {
            RowSegmented(
                options: [
                    SegmentOption(id: "ollama-cloud", label: "Ollama Cloud"),
                    SegmentOption(id: "openrouter", label: "OpenRouter"),
                ],
                selectedId: "openrouter",
                accessibilityId: "settings-model-provider",
                onSelect: { _ in }
            )
            Text("No models match.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
        }
    }
    .preferredColorScheme(.dark)
}
