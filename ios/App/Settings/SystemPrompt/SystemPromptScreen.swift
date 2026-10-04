// ---------------------------------------------------------------------------
// SystemPromptScreen — Soul-group "System Prompt" category page. Edit / preview
// toggle over the Soul.md mono editor, a "Restore default" action (confirm →
// canonical template into the draft, not saved until Save), and a SLOW save
// (PUT soul → apply-with-restart) surfaced by the applying banner.
//
// Discard restores drafts in place; Back separately confirms dirty navigation.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct SystemPromptScreen: View {
    let onBack: () -> Void

    @State private var vm: SystemPromptViewModel
    @State private var viewMode = "edit"
    @State private var showDiscard = false
    @State private var showRestore = false
    @State private var showAdvanced = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.init(viewModel: SystemPromptViewModel(settings: settings), onBack: onBack)
    }

    init(viewModel: SystemPromptViewModel, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: viewModel)
    }

    var body: some View {
        SettingsPageScaffold(
            title: "System Prompt", screenId: "settings-system-prompt-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty && !vm.isApplying && !vm.isRestoring,
            backAccessibilityId: "settings-system-prompt-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow(title: "Loading system prompt")
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load system instructions", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                instructionWorkspace
            }
        }
        .disabled(vm.isApplying || vm.isRestoring)
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-system-prompt-discard",
            applyAccessibilityId: "settings-system-prompt-save",
            onDiscard: vm.discard,
            onApply: { Task { await vm.save() } }
        )
        .disabled(vm.isRestoring)
        .task { await vm.load() }
        .confirmationDialog("Discard changes?", isPresented: $showDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) {
                guard !vm.isApplying, !vm.isRestoring else { return }
                vm.discard()
                onBack()
            }
            Button("Keep editing", role: .cancel) {}
        }
        .confirmationDialog("Restore default instructions?", isPresented: $showRestore, titleVisibility: .visible) {
            Button("Restore", role: .destructive) { Task { await vm.restoreDefault() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This replaces your edits with the canonical template. You can still discard before saving.")
        }
    }

    private var applyState: DesignApplyState { vm.save }

    private var instructionWorkspace: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if let restoreError = vm.restoreError {
                AsyncNotice(kind: .error, title: "Couldn't load default instructions", detail: restoreError) {
                    Task { await vm.restoreDefault() }
                }
            }
            DesignSettingsEditor(
                title: "System instructions",
                detail: "Base instructions for the assistant. Markdown supported; Apply saves this draft and applies configuration.",
                state: vm.isDirty ? .unsaved : .saved
            ) {
                DesignSegmentedPicker(
                    title: "Document mode",
                    options: [(value: "edit", label: "Edit"), (value: "preview", label: "Preview")],
                    selection: $viewMode,
                    accessibilityId: "settings-system-prompt-view",
                    isEnabled: !vm.isApplying && !vm.isRestoring
                )
                if viewMode == "edit" {
                    DesignMultilineEditor(
                        title: "System instructions",
                        text: $vm.draft,
                        placeholder: "The base personality and behavior contract…",
                        accessibilityId: "settings-system-prompt-editor",
                        isEnabled: !vm.isApplying && !vm.isRestoring,
                        usesMonospacedText: true
                    )
                } else if vm.draft.isEmpty {
                    Text("Nothing to preview.").designText(.supporting).foregroundStyle(DuskColors.ink2)
                } else {
                    // Draft text does not grant remote-image fetch authority.
                    MessageDocumentSurface(source: vm.draft, imageCache: nil)
                        .accessibilityIdentifier("settings-system-prompt-preview")
                }
            }

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
                        loadingTitle: "Loading default…",
                        role: .destructive,
                        state: vm.isRestoring ? .loading : .normal,
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
        guard !vm.isApplying, !vm.isRestoring else { return }
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}
