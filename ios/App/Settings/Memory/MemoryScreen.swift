// ---------------------------------------------------------------------------
// MemoryScreen — Soul-group "Memory" category page. A MEMORY.md / USER.md slot
// segmented switch (each slot fetched lazily on first view), an edit / preview
// toggle, and a char-capped mono editor with a live counter. SLOW save (PUT
// memory → apply-with-restart) puts every dirty slot.
//
// The shared apply bar receives this screen's dirty/save actions; discard and
// dirty-back still use the existing native confirmation and navigation seam.
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
            DesignSegmentedPicker(
                title: "Memory file",
                options: slotOptions.map { (value: $0.id, label: $0.label) },
                selection: Binding(get: { slot.rawValue }, set: selectSlot),
                accessibilityId: "settings-memory-slot"
            )
            slotCard
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-memory-discard",
            applyAccessibilityId: "settings-memory-save",
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
                    SoulBackButton(accessibilityId: "settings-memory-back", action: attemptBack)
                }
            }
        }
        .task(id: slot) { await vm.loadIfNeeded(slot) }
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
    private var slotCard: some View {
        let state = vm.state(for: slot)
        if !state.loaded {
            DesignCard(title: slot.label, detail: slotExplain[slot]) {
                SoulLoadingRow()
            }
        } else if let loadError = state.loadError {
            DesignCard(title: slot.label, detail: slotExplain[slot]) {
                AsyncNotice(kind: .error, title: "Couldn't load this memory", detail: loadError) {
                    Task { await vm.retry(slot) }
                }
            }
        } else {
            DesignSettingsEditor(
                title: slot.label,
                detail: slotExplain[slot] ?? "",
                state: state.isDirty ? .unsaved : .saved
            ) {
                editor(state)
            }
        }
    }

    @ViewBuilder
    private func editor(_ state: MemoryViewModel.SlotState) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            DesignSegmentedPicker(
                title: "Memory view",
                options: viewOptions.map { (value: $0.id, label: $0.label) },
                selection: $viewMode,
                accessibilityId: "settings-memory-view"
            )
            if viewMode == "edit" {
                DesignMultilineEditor(
                    text: Binding(
                        get: { state.draft },
                        set: { vm.setDraft($0, for: slot) }
                    ),
                    placeholder: "Nothing here yet. Add a note now or let the assistant build this over time.",
                    maxLength: state.charLimit > 0 ? state.charLimit : nil,
                    accessibilityId: "settings-memory-editor"
                )
            } else {
                Text(state.draft.isEmpty ? "Nothing to preview." : state.draft)
                    .designText(.supporting)
                    .foregroundStyle(state.draft.isEmpty ? DuskColors.ink4 : DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("settings-memory-preview")
            }
        }
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
            DesignSegmentedPicker(
                title: "Memory file",
                options: slotOptions.map { (value: $0.id, label: $0.label) },
                selection: .constant("memory"),
                accessibilityId: "settings-memory-slot"
            )
            DesignSettingsEditor(
                title: "Shared notes",
                detail: slotExplain[.memory] ?? "",
                state: .saved
            ) {
                DesignMultilineEditor(
                    text: .constant("The kitchen light is on circuit 3."),
                    maxLength: 4000,
                    accessibilityId: "settings-memory-editor"
                )
            }
        }
    }
    .preferredColorScheme(.dark)
}
