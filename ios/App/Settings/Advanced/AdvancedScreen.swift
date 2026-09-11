// ---------------------------------------------------------------------------
// AdvancedScreen — Soul-group "Advanced" category page. Reasoning select
// (none…xhigh), Compression slider (0–1 / 0.05), Max-tokens slider
// (128–8192 / 128), and the extra-system-prompt mono editor. SLOW save
// (PUT profile → apply-with-restart) — the applying banner shows while the
// assistant restarts.
//
// The shared apply bar receives this screen's dirty/save actions; discard and
// dirty-back still use the existing native confirmation and navigation seam.
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
        var values = ProfileEnums.shared.reasoningEfforts
        if !values.contains(vm.reasoningEffort) { values.append(vm.reasoningEffort) }
        return values.map { SelectOption(id: $0, label: reasoningLabels[$0] ?? $0) }
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Advanced", screenId: "settings-advanced-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-advanced-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load advanced settings", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                tuningSections
                promptCard
            }
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-advanced-discard",
            applyAccessibilityId: "settings-advanced-save",
            onDiscard: attemptBack,
            onApply: { Task { await vm.save() } }
        )
        .task { await vm.load() }
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
    private var tuningSections: some View {
        DesignCard(title: "Reasoning effort", bodyStyle: .padded) {
            DesignSettingsSelectRow(
                title: "Effort level",
                options: reasoningOptions.map { (value: $0.id, label: $0.label) },
                selection: Binding(get: { vm.reasoningEffort }, set: { vm.reasoningEffort = $0 }),
                accessibilityId: "settings-advanced-reasoning"
            )
            if reasoningLabels[vm.reasoningEffort] == nil {
                // The shared menu trigger is single-line; never hide an unknown value there.
                Text(vm.reasoningEffort)
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        AdvancedRangeSection(
            title: "Compression threshold",
            valueLabel: "Threshold",
            value: Binding(get: { vm.threshold }, set: { vm.threshold = $0 }),
            range: compressionRange,
            step: compressionStep,
            format: { String(format: "%.2f", $0) },
            accessibilityId: "settings-advanced-compression"
        )
        AdvancedRangeSection(
            title: "Profile limits",
            detail: "Saved with your profile. Chat response limits are managed separately by the gateway.",
            valueLabel: "Max tokens",
            value: Binding(get: { vm.maxTokens }, set: { vm.maxTokens = $0 }),
            range: maxTokensRange,
            step: maxTokensStep,
            format: { "\(Int32($0.rounded()).formatted()) tokens" },
            accessibilityId: "settings-advanced-max-tokens"
        )
    }

    private var promptCard: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Optional instructions")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .accessibilityAddTraits(.isHeader)
            DesignSettingsEditor(
                title: "Additional instructions",
                detail: "Included with each request. Use sparingly because this reduces available context."
            ) {
                DesignMultilineEditor(
                    text: Binding(get: { vm.extraSystemPrompt }, set: { vm.extraSystemPrompt = $0 }),
                    placeholder: "Optional extra instructions…",
                    accessibilityId: "settings-advanced-extra-prompt"
                )
            }
        }
        .padding(.top, Space.sm)
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

/// A value-first tuning section. The native slider receives the entire available width.
private struct AdvancedRangeSection: View {
    let title: String
    var detail: String? = nil
    let valueLabel: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    let accessibilityId: String

    var body: some View {
        DesignCard(title: title, detail: detail, bodyStyle: .padded) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(valueLabel)
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.ink2)
                Text(format(value))
                    .designText(.large)
                    .fontWeight(.medium)
                    .monospacedDigit()
                    .foregroundStyle(DuskColors.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            DesignSliderControlBody(
                value: $value,
                range: range,
                step: step,
                accessibilityLabel: "\(title), \(valueLabel)",
                accessibilityValue: format(value),
                accessibilityId: accessibilityId
            )
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.md) {
                    Text(format(range.lowerBound))
                    Spacer(minLength: Space.sm)
                    Text(format(range.upperBound))
                }
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("Minimum: \(format(range.lowerBound))")
                    Text("Maximum: \(format(range.upperBound))")
                }
            }
            .designText(.supporting)
            .foregroundStyle(DuskColors.ink2)
            .accessibilityHidden(true)
        }
    }
}

#Preview("range") {
    NavigationStack {
        SettingsPageScaffold(title: "Advanced", screenId: "settings-advanced-screen") {
            AdvancedRangeSection(
                title: "Compression threshold", valueLabel: "Threshold",
                value: .constant(0.3), range: compressionRange, step: compressionStep,
                format: { String(format: "%.2f", $0) },
                accessibilityId: "settings-advanced-compression"
            )
        }
    }
    .preferredColorScheme(.dark)
}
