// ---------------------------------------------------------------------------
// AdvancedScreen — Soul-group "Advanced" category page. Reasoning select
// (none…xhigh), Compression slider (0–1 / 0.05), Max-tokens slider
// (128–8192 / 128), and the extra-system-prompt mono editor. SLOW save
// (PUT profile → apply-with-restart) — the applying banner shows while the
// assistant restarts.
//
// Save chrome + discard-on-dirty-back are the shared SoulPageChrome pieces; nav
// wiring lives in UserSessionHost. This file fills the body + owns its VM only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let reasoningLabels: [String: String] = [
    "none": "None", "minimal": "Minimal", "low": "Low",
    "medium": "Medium", "high": "High", "xhigh": "Extra high",
]

private let compressionRange: ClosedRange<Double> = 0...1
private let compressionStep = 0.05
private let maxTokensRange: ClosedRange<Double> = 128...8192
private let maxTokensStep: Double = 128

struct AdvancedScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: AdvancedViewModel
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: AdvancedViewModel(settings: settings))
    }

    private var reasoningOptions: [SelectOption] {
        ProfileEnums.shared.reasoningEfforts.map {
            SelectOption(id: $0, label: reasoningLabels[$0] ?? $0)
        }
    }

    var body: some View {
        SettingsPageScaffold(title: "Advanced", screenId: "settings-advanced-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load advanced settings", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                saveBanner
                contextCard
                promptCard
            }
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-advanced-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-advanced-save") {
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
        case .applied: AsyncNotice(kind: .success, title: "Changes applied")
        case .failed(let message): SoulInlineError(message: message)
        }
    }

    private var contextCard: some View {
        SettingsCard(title: "Context") {
            RowSelect(
                label: "Reasoning",
                options: reasoningOptions,
                selectedId: vm.reasoningEffort,
                accessibilityId: "settings-advanced-reasoning",
                onSelect: { vm.reasoningEffort = $0 }
            )
            Divider().background(DuskColors.lineSoft)
            RowSlider(
                label: "Compression threshold",
                value: vm.threshold,
                range: compressionRange,
                step: compressionStep,
                format: { String(format: "%.2f", $0) },
                accessibilityId: "settings-advanced-compression",
                onChange: { vm.threshold = $0 }
            )
            Divider().background(DuskColors.lineSoft)
            RowSlider(
                label: "Max tokens",
                value: vm.maxTokens,
                range: maxTokensRange,
                step: maxTokensStep,
                format: { "\(Int($0)) tok" },
                accessibilityId: "settings-advanced-max-tokens",
                onChange: { vm.maxTokens = $0 }
            )
        }
    }

    private var promptCard: some View {
        SettingsCard(title: "Additional instructions", sub: "Included with each request. Use sparingly because this reduces available context.") {
            MonoEditor(
                text: vm.extraSystemPrompt,
                placeholder: "Optional extra instructions…",
                accessibilityId: "settings-advanced-extra-prompt",
                onChange: { vm.extraSystemPrompt = $0 }
            )
            .padding(.vertical, Space.sm)
        }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("ready") {
    NavigationStack {
        SettingsPageScaffold(title: "Advanced", screenId: "settings-advanced-screen") {
            SettingsCard(title: "Context") {
                RowSelect(
                    label: "Reasoning",
                    options: [SelectOption(id: "minimal", label: "Minimal")],
                    selectedId: "minimal", accessibilityId: "settings-advanced-reasoning", onSelect: { _ in }
                )
                Divider().background(DuskColors.lineSoft)
                RowSlider(
                    label: "Compression threshold", value: 0.3, range: 0...1, step: 0.05,
                    format: { String(format: "%.2f", $0) },
                    accessibilityId: "settings-advanced-compression", onChange: { _ in }
                )
            }
        }
    }
    .preferredColorScheme(.dark)
}
