// ---------------------------------------------------------------------------
// MemoryScreen — Soul-group "Memory" category page. A MEMORY.md / USER.md slot
// segmented switch (each slot fetched lazily on first view), an edit / preview
// toggle, and a char-capped mono editor with a live counter. SLOW save (PUT
// memory → apply-with-restart) puts every dirty slot.
//
// Save chrome + discard-on-dirty-back are shared SoulPageChrome pieces; nav
// wiring lives in UserSessionHost. This file fills the body + owns its VM only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let slotOptions: [SegmentOption] = [
    SegmentOption(id: "memory", label: "Shared notes"),
    SegmentOption(id: "user", label: "About you"),
]

private let viewOptions: [SegmentOption] = [
    SegmentOption(id: "edit", label: "Edit"),
    SegmentOption(id: "preview", label: "Preview"),
]

private let slotExplain: [MemoryViewModel.Slot: String] = [
    .memory: "Notes the assistant can maintain over time. Edit them to seed or correct a fact.",
    .user: "Preferences and expectations the assistant has learned about you. Edit them to seed or correct a detail.",
]

struct MemoryScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: MemoryViewModel
    @State private var slot: MemoryViewModel.Slot = .memory
    @State private var viewMode = "edit"
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: MemoryViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Memory", screenId: "settings-memory-screen") {
            saveBanner
            RowSegmented(
                options: slotOptions,
                selectedId: slot.rawValue,
                accessibilityId: "settings-memory-slot",
                onSelect: { selectSlot($0) }
            )
            slotCard
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-memory-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-memory-save") {
                        Task { await vm.save() }
                    }
                }
            }
        }
        .task(id: slot) { await vm.loadIfNeeded(slot) }
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
        case .applied: AsyncNotice(kind: .success, title: "Changes applied")
        case .failed(let message): SoulInlineError(message: message)
        }
    }

    @ViewBuilder
    private var slotCard: some View {
        let state = vm.state(for: slot)
        SettingsCard(title: slot.label, sub: slotExplain[slot]) {
            if !state.loaded {
                SoulLoadingRow()
            } else if let loadError = state.loadError {
                AsyncNotice(kind: .error, title: "Couldn't load this memory", detail: loadError) {
                    Task { await vm.retry(slot) }
                }
            } else {
                editor(state)
            }
        }
    }

    @ViewBuilder
    private func editor(_ state: MemoryViewModel.SlotState) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            RowSegmented(
                options: viewOptions,
                selectedId: viewMode,
                accessibilityId: "settings-memory-view",
                onSelect: { viewMode = $0 }
            )
            if viewMode == "edit" {
                MonoEditor(
                    text: state.draft,
                    placeholder: "Nothing here yet. Add a note now or let the assistant build this over time.",
                    maxLength: state.charLimit > 0 ? state.charLimit : nil,
                    accessibilityId: "settings-memory-editor",
                    onChange: { vm.setDraft($0, for: slot) }
                )
            } else {
                Text(state.draft.isEmpty ? "Nothing to preview." : state.draft)
                    .font(Typo.mono(TypeScale.sm))
                    .foregroundStyle(state.draft.isEmpty ? DuskColors.ink4 : DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("settings-memory-preview")
            }
        }
        .padding(.vertical, Space.sm)
    }

    private func selectSlot(_ id: String) {
        slot = (id == "user") ? .user : .memory
        viewMode = "edit"
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("edit") {
    NavigationStack {
        SettingsPageScaffold(title: "Memory", screenId: "settings-memory-screen") {
            RowSegmented(
                options: slotOptions, selectedId: "memory",
                accessibilityId: "settings-memory-slot", onSelect: { _ in }
            )
            SettingsCard(title: "Shared notes", sub: slotExplain[.memory]) {
                MonoEditor(
                    text: "The kitchen light is on circuit 3.",
                    maxLength: 4000,
                    accessibilityId: "settings-memory-editor", onChange: { _ in }
                )
                .padding(.vertical, Space.sm)
            }
        }
    }
    .preferredColorScheme(.dark)
}
