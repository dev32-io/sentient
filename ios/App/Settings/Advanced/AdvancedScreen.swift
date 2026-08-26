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

    private var saveBanner: some View {
        DesignApplyFeedback(state: applyState)
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

    private var contextCard: some View {
        DesignCard(title: "Context") {
            DesignSelect(
                title: "Reasoning",
                options: reasoningOptions.map { (value: $0.id, label: $0.label) },
                selection: Binding(get: { vm.reasoningEffort }, set: { vm.reasoningEffort = $0 }),
                accessibilityId: "settings-advanced-reasoning"
            )
            DesignDivider()
            DesignSlider(
                title: "Compression threshold",
                value: Binding(get: { vm.threshold }, set: { vm.threshold = $0 }),
                range: compressionRange,
                step: compressionStep,
                format: { String(format: "%.2f", $0) },
                accessibilityId: "settings-advanced-compression"
            )
            DesignDivider()
            DesignSlider(
                title: "Max tokens",
                value: Binding(get: { vm.maxTokens }, set: { vm.maxTokens = $0 }),
                range: maxTokensRange,
                step: maxTokensStep,
                format: { "\(Int($0)) tok" },
                accessibilityId: "settings-advanced-max-tokens"
            )
        }
    }

    private var promptCard: some View {
        DesignCard(title: "Additional instructions", detail: "Included with each request. Use sparingly because this reduces available context.") {
            DesignMultilineEditor(
                text: Binding(get: { vm.extraSystemPrompt }, set: { vm.extraSystemPrompt = $0 }),
                placeholder: "Optional extra instructions…",
                accessibilityId: "settings-advanced-extra-prompt"
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
            DesignCard(title: "Context") {
                DesignSelect(
                    title: "Reasoning",
                    options: [(value: "minimal", label: "Minimal")],
                    selection: .constant("minimal"),
                    accessibilityId: "settings-advanced-reasoning"
                )
                DesignDivider()
                DesignSlider(
                    title: "Compression threshold", value: .constant(0.3), range: 0...1, step: 0.05,
                    format: { String(format: "%.2f", $0) },
                    accessibilityId: "settings-advanced-compression"
                )
            }
        }
    }
    .preferredColorScheme(.dark)
}
