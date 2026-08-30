// ---------------------------------------------------------------------------
// SystemPromptScreen — Soul-group "System Prompt" category page. Edit / preview
// toggle over the Soul.md mono editor, a "Restore default" action (confirm →
// canonical template into the draft, not saved until Save), and a SLOW save
// (PUT soul → apply-with-restart) surfaced by the applying banner.
//
// The shared apply bar receives this screen's dirty/save actions; discard and
// dirty-back still use the existing native confirmation and navigation seam.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let viewOptions: [SegmentOption] = [
    SegmentOption(id: "edit", label: "Edit"),
    SegmentOption(id: "preview", label: "Preview"),
]

struct SystemPromptScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: SystemPromptViewModel
    @State private var viewMode = "edit"
    @State private var showDiscard = false
    @State private var showRestore = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: SystemPromptViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "System Prompt", screenId: "settings-system-prompt-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load system instructions", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                soulCard
            }
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-system-prompt-discard",
            applyAccessibilityId: "settings-system-prompt-save",
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
                    SoulBackButton(accessibilityId: "settings-system-prompt-back", action: attemptBack)
                }
            }
        }
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { onBack() }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Restore default instructions?", isPresented: $showRestore, titleVisibility: .visible) {
            Button("Restore", role: .destructive) { Task { await vm.restoreDefault() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This replaces your edits with the canonical template. You can still discard before saving.")
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

    private var soulCard: some View {
        DesignSettingsEditor(
            title: "System instructions",
            detail: "Markdown supported. The assistant restarts after saving.",
            state: vm.isDirty ? .unsaved : .saved
        ) {
            VStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    DesignSegmentedPicker(
                        title: "System prompt view",
                        options: viewOptions.map { (value: $0.id, label: $0.label) },
                        selection: $viewMode,
                        accessibilityId: "settings-system-prompt-view"
                    )
                    DesignActionButton(
                        title: "Restore default",
                        role: .destructive,
                        state: vm.isRestoring ? .disabled : .normal,
                        accessibilityId: "settings-system-prompt-restore",
                        action: { showRestore = true }
                    )
                }
                if viewMode == "edit" {
                    DesignMultilineEditor(
                        text: $vm.draft,
                        placeholder: "The base personality and behavior contract…",
                        accessibilityId: "settings-system-prompt-editor"
                    )
                } else {
                    Text(vm.draft.isEmpty ? "Nothing to preview." : vm.draft)
                        .designText(.supporting)
                        .foregroundStyle(vm.draft.isEmpty ? DuskColors.ink4 : DuskColors.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-system-prompt-preview")
                }
            }
        }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("edit") {
    NavigationStack {
        SettingsPageScaffold(title: "System Prompt", screenId: "settings-system-prompt-screen") {
            DesignSettingsEditor(
                title: "System instructions",
                detail: "Markdown supported. The assistant restarts after saving.",
                state: .saved
            ) {
                DesignMultilineEditor(
                    text: .constant("You are Sentient, a warm and capable family assistant…"),
                    accessibilityId: "settings-system-prompt-editor"
                )
            }
        }
    }
    .preferredColorScheme(.dark)
}
