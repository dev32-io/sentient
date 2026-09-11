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
        SettingsPageScaffold(
            title: "Memory", screenId: "settings-memory-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-memory-back"
        ) {
            VStack(alignment: .leading, spacing: Space.md) {
                DesignSegmentedPicker(
                    title: "Memory file",
                    options: slotOptions.map { (value: $0.id, label: $0.label) },
                    selection: Binding(get: { slot.rawValue }, set: selectSlot),
                    accessibilityId: "settings-memory-slot"
                )
                Text(slotExplain[slot] ?? "")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                slotContent
            }
            .padding(Space.md)
            .designPlate()
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-memory-discard",
            applyAccessibilityId: "settings-memory-save",
            onDiscard: attemptBack,
            onApply: { Task { await vm.save() } }
        )
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
    private var slotContent: some View {
        let state = vm.state(for: slot)
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

    @ViewBuilder
    private func editor(_ state: MemoryViewModel.SlotState) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text(viewMode == "edit" ? "Editing" : "Preview")
                    .designText(.label)
                    .foregroundStyle(DuskColors.ink2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DesignActionButton(
                    title: viewMode == "edit" ? "Preview" : "Edit",
                    role: .quiet,
                    accessibilityId: "settings-memory-view",
                    fillsWidth: false,
                    action: { viewMode = viewMode == "edit" ? "preview" : "edit" }
                )
            }
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
                    .designText(.body)
                    .foregroundStyle(state.draft.isEmpty ? DuskColors.ink2 : DuskColors.ink)
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
