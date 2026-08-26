// ---------------------------------------------------------------------------
// SystemPromptScreen — Soul-group "System Prompt" category page. Edit / preview
// toggle over the Soul.md mono editor, a "Restore default" action (confirm →
// canonical template into the draft, not saved until Save), and a SLOW save
// (PUT soul → apply-with-restart) surfaced by the applying banner.
//
// Save chrome + discard-on-dirty-back are shared SoulPageChrome pieces; nav
// wiring lives in UserSessionHost. This file fills the body + owns its VM only.
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
                saveBanner
                soulCard
            }
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-system-prompt-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-system-prompt-save") {
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
        .confirmationDialog("Restore default instructions?", isPresented: $showRestore, titleVisibility: .visible) {
            Button("Restore", role: .destructive) { Task { await vm.restoreDefault() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This replaces your edits with the canonical template. You can still discard before saving.")
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

    private var soulCard: some View {
        SettingsCard(title: "System instructions", sub: "Markdown supported. The assistant restarts after saving.") {
            VStack(alignment: .leading, spacing: Space.md) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    RowSegmented(
                        options: viewOptions,
                        selectedId: viewMode,
                        accessibilityId: "settings-system-prompt-view",
                        onSelect: { viewMode = $0 }
                    )
                    Button("Restore default") { showRestore = true }
                        .font(Typo.ui(TypeScale.base, .semibold))
                        .foregroundStyle(DuskColors.stop)
                        .frame(minHeight: DesignMetrics.minimumTarget)
                        .disabled(vm.isRestoring)
                        .accessibilityIdentifier("settings-system-prompt-restore")
                }
                if viewMode == "edit" {
                    MonoEditor(
                        text: vm.draft,
                        placeholder: "The base personality and behavior contract…",
                        accessibilityId: "settings-system-prompt-editor",
                        onChange: { vm.draft = $0 }
                    )
                } else {
                    Text(vm.draft.isEmpty ? "Nothing to preview." : vm.draft)
                        .font(Typo.mono(TypeScale.sm))
                        .foregroundStyle(vm.draft.isEmpty ? DuskColors.ink4 : DuskColors.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("settings-system-prompt-preview")
                }
            }
            .padding(.vertical, Space.sm)
        }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("edit") {
    NavigationStack {
        SettingsPageScaffold(title: "System Prompt", screenId: "settings-system-prompt-screen") {
            SettingsCard(title: "System instructions", sub: "Markdown supported. The assistant restarts after saving.") {
                MonoEditor(
                    text: "You are Sentient, a warm and capable family assistant…",
                    accessibilityId: "settings-system-prompt-editor", onChange: { _ in }
                )
                .padding(.vertical, Space.sm)
            }
        }
    }
    .preferredColorScheme(.dark)
}
