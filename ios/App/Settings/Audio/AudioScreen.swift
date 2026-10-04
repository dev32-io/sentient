// ---------------------------------------------------------------------------
// AudioScreen — Soul-group "Audio" category page. "Speak responses (TTS)" toggle
// + "Reply channel" segmented (voice / text). FAST save: the profile PUT's
// audio-only diff takes ApplyProfileChangeUseCase's fast path (live WS patch, NO
// Hermes restart), so there is no "restarting…" copy.
//
// Chrome: the shared apply bar appears for the existing draft/save lifecycle;
// its Discard action restores drafts in place. The leading back
// button keeps the same dirty-navigation guard through the `onBack` seam.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let audioChannelOptions: [SegmentOption] = [
    SegmentOption(id: "voice", label: "Voice"),
    SegmentOption(id: "text", label: "Text only"),
]

struct AudioScreen: View {
    let onBack: () -> Void

    @State private var vm: AudioViewModel
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.init(viewModel: AudioViewModel(settings: settings), onBack: onBack)
    }

    init(viewModel: AudioViewModel, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: viewModel)
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Audio", screenId: "settings-audio-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty && !vm.isApplying,
            backAccessibilityId: "settings-audio-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow(title: "Loading audio settings")
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load audio settings", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                outputCard
            }
        }
        .disabled(vm.isApplying)
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-audio-discard",
            applyAccessibilityId: "settings-audio-save",
            onDiscard: vm.discard,
            onApply: { Task { await vm.save() } }
        )
        .task { await vm.load() }
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

    private var outputCard: some View {
        AudioPreferenceBlock(
            ttsEnabled: Binding(get: { vm.ttsEnabled }, set: { vm.ttsEnabled = $0 }),
            channel: Binding(get: { vm.channel }, set: { vm.channel = $0 })
        )
    }

    private func attemptBack() {
        guard !vm.isApplying else { return }
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

/// Speaking is the primary decision; the channel remains an independent preference.
private struct AudioPreferenceBlock: View {
    @Binding var ttsEnabled: Bool
    @Binding var channel: String

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            DesignCard(title: "Reply output", bodyStyle: .settingsGroup) {
                DesignToggleRow(
                    title: "Speak responses",
                    detail: "When off, replies are silent — text still streams to chat.",
                    isOn: $ttsEnabled,
                    accessibilityId: "settings-audio-tts"
                )
                DesignSettingsRow(
                    title: "Reply channel",
                    detail: "Voice allows spoken replies when Speak responses is on. Text only keeps replies silent."
                ) {
                    DesignSegmentedPicker(
                        title: "Reply channel",
                        options: audioChannelOptions.map { (value: $0.id, label: $0.label) },
                        selection: $channel,
                        accessibilityId: "settings-audio-channel"
                    )
                }
            }
            Text("Changes take effect on the next reply.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
        }
    }
}

#Preview("ready") {
    NavigationStack {
        SettingsPageScaffold(title: "Audio", screenId: "settings-audio-screen") {
            AudioPreferenceBlock(ttsEnabled: .constant(true), channel: .constant("voice"))
        }
    }
    .preferredColorScheme(.dark)
}
