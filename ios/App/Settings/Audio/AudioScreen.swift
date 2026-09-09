// ---------------------------------------------------------------------------
// AudioScreen — Soul-group "Audio" category page. "Speak responses (TTS)" toggle
// + "Reply channel" segmented (voice / text). FAST save: the profile PUT's
// audio-only diff takes ApplyProfileChangeUseCase's fast path (live WS patch, NO
// Hermes restart), so there is no "restarting…" copy.
//
// Chrome: the shared apply bar appears for the existing draft/save lifecycle;
// its Discard action routes through the native confirmation. The leading back
// button keeps the same dirty-navigation guard through the `onBack` seam.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let audioChannelOptions: [SegmentOption] = [
    SegmentOption(id: "voice", label: "Voice"),
    SegmentOption(id: "text", label: "Text only"),
]

struct AudioScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: AudioViewModel
    @State private var showDiscard = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: AudioViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Audio", screenId: "settings-audio-screen",
            onBack: attemptBack, allowsInteractiveBack: !vm.isDirty,
            backAccessibilityId: "settings-audio-back"
        ) {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load audio settings", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                outputCard
            }
        }
        .designApplyBarDock(
            isDirty: vm.isDirty,
            state: applyState,
            discardAccessibilityId: "settings-audio-discard",
            applyAccessibilityId: "settings-audio-save",
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
        case .saving, .restarting: .saving
        case .alreadyApplying: .alreadyApplying
        case .applied: .applied
        case .failed(let message): .failed(message)
        }
    }

    private var outputCard: some View {
        AudioPreferenceBlock(
            ttsEnabled: Binding(get: { vm.ttsEnabled }, set: { vm.ttsEnabled = $0 }),
            channel: Binding(get: { vm.channel }, set: { vm.channel = $0 })
        )
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

/// Speaking is the primary decision; the channel remains an independent preference.
private struct AudioPreferenceBlock: View {
    @Binding var ttsEnabled: Bool
    @Binding var channel: String

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            Text("Response behavior")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
                .accessibilityAddTraits(.isHeader)
            DesignCard(bodyStyle: .padded) {
                DesignToggleRow(
                    title: "Speak responses",
                    detail: "When off, replies are silent — text still streams to chat.",
                    isOn: $ttsEnabled,
                    accessibilityId: "settings-audio-tts"
                )
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Reply channel")
                        .designText(.label)
                        .fontWeight(.medium)
                        .foregroundStyle(DuskColors.ink)
                    Text("Voice allows spoken replies when Speak responses is on. Text only keeps replies silent.")
                        .designText(.supporting)
                        .foregroundStyle(DuskColors.ink2)
                    DesignSegmentedPicker(
                        title: "Reply channel",
                        options: audioChannelOptions.map { (value: $0.id, label: $0.label) },
                        selection: $channel,
                        accessibilityId: "settings-audio-channel"
                    )
                }
                .padding(Space.md)
                .designWell()
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
