// ---------------------------------------------------------------------------
// MemoryScreen — Soul-group "Memory" category page. A MEMORY.md / USER.md slot
// segmented switch (each slot fetched lazily on first view), an edit / preview
// toggle, and a char-capped mono editor with a live counter. SLOW save (PUT
// memory → apply-with-restart) puts every dirty slot.
//
// Discard restores drafts in place; Back separately confirms dirty navigation.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let slotOptions: [SegmentOption] = [
    SegmentOption(id: "memory", label: "Shared notes"),
    SegmentOption(id: "user", label: "About you"),
]

private let slotExplain: [MemoryViewModel.Slot: String] = [
    .memory: "Notes the assistant can maintain over time. Edit them to seed or correct a fact.",
    .user: "Preferences and expectations the assistant has learned about you. Edit them to seed or correct a detail.",
]

struct MemoryScreen: View {
    let onBack: () -> Void

    @State private var vm: MemoryViewModel
    @State private var slot: MemoryViewModel.Slot = .memory
    @State private var viewMode = "edit"
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.init(viewModel: MemoryViewModel(settings: settings), onBack: onBack)
    }

    init(viewModel: MemoryViewModel, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: viewModel)
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Memory", screenId: "settings-memory-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty && !vm.isApplying,
            backAccessibilityId: "settings-memory-back"
        ) {
            VStack(alignment: .leading, spacing: Space.md) {
                DesignSegmentedPicker(
                    title: "Memory file",
                    options: slotOptions.map { (value: $0.id, label: $0.label) },
                    selection: Binding(get: { slot.rawValue }, set: selectSlot),
                    accessibilityId: "settings-memory-slot"
                )
                slotContent
            }
        }
        .disabled(vm.isApplying)
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-memory-discard",
            applyAccessibilityId: "settings-memory-save",
            onDiscard: vm.discard,
            onApply: { Task { await vm.save() } }
        )
        .task(id: slot) { await vm.loadIfNeeded(slot) }
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

    @ViewBuilder
    private var slotContent: some View {
        let state = vm.state(for: slot)
        if !state.loaded {
            SoulLoadingRow(title: "Loading memory")
        } else if let loadError = state.loadError {
            AsyncNotice(kind: .error, title: "Couldn't load this memory", detail: loadError) {
                Task { await vm.retry(slot) }
            }
        } else {
            editor(state)
        }
    }

    private func editor(_ state: MemoryViewModel.SlotState) -> some View {
        DesignSettingsEditor(
            title: slot.label,
            detail: slotExplain[slot] ?? "",
            state: state.isDirty ? .unsaved : .saved
        ) {
            DesignSegmentedPicker(
                title: "Document mode",
                options: [(value: "edit", label: "Edit"), (value: "preview", label: "Preview")],
                selection: $viewMode,
                accessibilityId: "settings-memory-view",
                isEnabled: !vm.isApplying
            )
            if viewMode == "edit" {
                DesignMultilineEditor(
                    title: slot.label,
                    text: Binding(get: { vm.state(for: slot).draft }, set: { vm.setDraft($0, for: slot) }),
                    placeholder: "Nothing here yet. Add a note now or let the assistant build this over time.",
                    maxLength: state.charLimit > 0 ? state.charLimit : nil,
                    accessibilityId: "settings-memory-editor",
                    isEnabled: !vm.isApplying,
                    usesMonospacedText: true
                )
            } else if state.draft.isEmpty {
                Text("Nothing to preview.").designText(.supporting).foregroundStyle(DuskColors.ink2)
            } else {
                // Draft text does not grant remote-image fetch authority.
                MessageDocumentSurface(source: state.draft, imageCache: nil)
                    .accessibilityIdentifier("settings-memory-preview")
            }
        }
    }

    private func selectSlot(_ id: String) {
        guard !vm.isApplying else { return }
        slot = (id == "user") ? .user : .memory
        viewMode = "edit"
    }

    private func attemptBack() {
        guard !vm.isApplying else { return }
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}
