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

struct SystemPromptScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: SystemPromptViewModel
    @State private var viewMode = "edit"
    @State private var showDiscard = false
    @State private var showRestore = false
    @State private var showAdvanced = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: SystemPromptViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(
            title: "System Prompt", screenId: "settings-system-prompt-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-system-prompt-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load system instructions", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                instructionWorkspace
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

    private var instructionWorkspace: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.md) {
                Text("Base instructions for the assistant. Markdown supported; Apply saves this draft and applies configuration.")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                    Text(viewMode == "edit" ? "Editing instructions" : "Preview")
                        .designText(.label)
                        .foregroundStyle(DuskColors.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    DesignActionButton(
                        title: viewMode == "edit" ? "Preview" : "Edit",
                        role: .quiet,
                        accessibilityId: "settings-system-prompt-view",
                        fillsWidth: false,
                        action: { viewMode = viewMode == "edit" ? "preview" : "edit" }
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
                        .designText(.body)
                        .foregroundStyle(vm.draft.isEmpty ? DuskColors.ink2 : DuskColors.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-system-prompt-preview")
                }
            }
            .padding(Space.md)
            .designPlate()

            DesignDisclosureGroup(isExpanded: showAdvanced) {
                DesignDisclosureButton(
                    isExpanded: showAdvanced,
                    accessibilityLabel: "Advanced actions",
                    accessibilityId: "settings-system-prompt-advanced",
                    action: { showAdvanced.toggle() }
                ) {
                    Text("Advanced actions")
                        .designText(.label)
                        .foregroundStyle(DuskColors.ink2)
                }
            } content: {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Restore the default instructions into this draft. Nothing changes until you apply.")
                        .designText(.supporting)
                        .foregroundStyle(DuskColors.ink2)
                    DesignActionButton(
                        title: "Restore default",
                        role: .destructive,
                        state: vm.isRestoring ? .disabled : .normal,
                        accessibilityId: "settings-system-prompt-restore",
                        fillsWidth: false,
                        action: { showRestore = true }
                    )
                }
                .padding(Space.sm)
            }
        }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}
