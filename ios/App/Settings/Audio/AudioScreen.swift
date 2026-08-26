// ---------------------------------------------------------------------------
// AudioScreen — Soul-group "Audio" category page. "Speak responses (TTS)" toggle
// + "Reply channel" segmented (voice / text). FAST save: the profile PUT's
// audio-only diff takes ApplyProfileChangeUseCase's fast path (live WS patch, NO
// Hermes restart), so there is no "restarting…" copy.
//
// Chrome: a Save toolbar button appears iff the draft is dirty (disabled while a
// save runs); the leading back button routes through a discard confirmation when
// dirty (the `onBack` seam). Nav wiring lives in UserSessionHost — this file only
// fills the page body + owns its VM.
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
        SettingsPageScaffold(title: "Audio", screenId: "settings-audio-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                AsyncNotice(kind: .error, title: "Couldn't load audio settings", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                saveBanner
                outputCard
            }
        }
        // Clean → system back button (native interactive edge-swipe pop). Dirty →
        // hide it + show the custom back that routes through the discard confirm
        // (gesture is intentionally disabled only while a draft is unsaved).
        .navigationBarBackButtonHidden(vm.isDirty)
        .toolbar {
            if vm.isDirty {
                ToolbarItem(placement: .navigation) {
                    SoulBackButton(accessibilityId: "settings-audio-back", action: attemptBack)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    SoulSaveButton(disabled: vm.isApplying, accessibilityId: "settings-audio-save") {
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
        case .saving, .restarting: .saving
        case .alreadyApplying: .alreadyApplying
        case .applied: .applied
        case .failed(let message): .failed(message)
        }
    }

    private var outputCard: some View {
        DesignCard(title: "Output", detail: "Takes effect on the next reply.") {
            DesignToggleRow(
                title: "Speak responses",
                detail: "When off, replies are silent — text still streams to chat.",
                isOn: Binding(get: { vm.ttsEnabled }, set: { vm.ttsEnabled = $0 }),
                accessibilityId: "settings-audio-tts"
            )
            DesignDivider()
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Reply channel")
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                DesignSegmentedPicker(
                    title: "Reply channel",
                    options: audioChannelOptions.map { (value: $0.id, label: $0.label) },
                    selection: Binding(get: { vm.channel }, set: { vm.channel = $0 }),
                    accessibilityId: "settings-audio-channel"
                )
            }
            .padding(.vertical, Space.sm)
        }
    }

    private func attemptBack() {
        if vm.isDirty { showDiscard = true } else { onBack() }
    }
}

#Preview("ready") {
    NavigationStack {
        SettingsPageScaffold(title: "Audio", screenId: "settings-audio-screen") {
            DesignCard(title: "Output", detail: "Takes effect on the next reply.") {
                DesignToggleRow(
                    title: "Speak responses",
                    detail: "When off, replies are silent — text still streams to chat.",
                    isOn: .constant(true), accessibilityId: "settings-audio-tts"
                )
                DesignDivider()
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Reply channel").font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink)
                    DesignSegmentedPicker(
                        title: "Reply channel",
                        options: audioChannelOptions.map { (value: $0.id, label: $0.label) },
                        selection: .constant("voice"), accessibilityId: "settings-audio-channel"
                    )
                }
                .padding(.vertical, Space.sm)
            }
        }
    }
    .preferredColorScheme(.dark)
}
