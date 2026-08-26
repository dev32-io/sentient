import SwiftUI
import MobileData

/// Encapsulated native composer. Draft ownership stays here so permission,
/// capture failures, reconnects, and Hold/Auto transitions never erase text.
struct Composer: View {
    let tasks: [TaskListItem]
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let onSend: (String) -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void
    let onFocusGained: () -> Void

    @State private var draft = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var draftPresent: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var held: Bool { talkMode == .hold }

    var body: some View {
        VStack(spacing: 0) {
            TaskShelf(items: tasks)
            VStack(spacing: Space.sm) {
                DraftEditor(text: $draft, focused: $inputFocused, receded: held, onSubmit: submit)
                ComposerActions(
                    draftPresent: draftPresent && !held,
                    held: held,
                    ttsEnabled: ttsEnabled,
                    talkMode: talkMode,
                    micLevels: micLevels,
                    voiceDisabled: voiceDisabled,
                    canInterrupt: canInterrupt,
                    onSend: submit,
                    onVoiceIntent: onVoiceIntent,
                    onTtsToggle: onTtsToggle,
                    onInterrupt: onInterrupt
                )
            }
            .padding(Space.md)
            .designPlate(elevated: true)
            .contentShape(Rectangle())
            .onTapGesture { if !held { inputFocused = true } }
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: held)
        .onChange(of: inputFocused) { _, focused in if focused { onFocusGained() } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-composer")
    }

    private func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        onSend(text)
        draft = ""
        inputFocused = false
    }
}

struct DraftEditor: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let receded: Bool
    let onSubmit: () -> Void

    var body: some View {
        TextField("Message or speak to Sentient", text: $text, axis: .vertical)
            .lineLimit(1...6)
            .designText(.body)
            .foregroundStyle(DuskColors.ink)
            .tint(DuskColors.accent)
            .focused(focused)
            .submitLabel(.send)
            .onSubmit(onSubmit)
            .frame(minHeight: DesignMetrics.minimumTarget, alignment: .topLeading)
            .opacity(receded ? 0.08 : 1)
            .allowsHitTesting(!receded)
            .accessibilityHidden(receded)
            .accessibilityLabel("Message Sentient")
            .accessibilityIdentifier("composer-input")
    }
}

struct ComposerActionState: Equatable {
    let draftPresent: Bool
    let talkMode: TalkMode

    var showsSend: Bool { draftPresent }
    var showsVoiceCapture: Bool { !draftPresent || talkMode != .idle }
}

private struct ComposerActions: View {
    let draftPresent: Bool
    let held: Bool
    let ttsEnabled: Bool
    let talkMode: TalkMode
    let micLevels: [Float]
    let voiceDisabled: Bool
    let canInterrupt: Bool
    let onSend: () -> Void
    let onVoiceIntent: (VoiceCaptureIntent) -> Void
    let onTtsToggle: () -> Void
    let onInterrupt: () -> Void

    var body: some View {
        let actions = ComposerActionState(draftPresent: draftPresent, talkMode: talkMode)

        HStack(alignment: .bottom, spacing: Space.sm) {
            if !held {
                ComposerIconButton(systemName: "paperclip", label: "Attachments are not available", enabled: false, action: {})
                    .accessibilityIdentifier("chat-attach")
                ComposerIconButton(
                    systemName: ttsEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                    label: ttsEnabled ? "Spoken responses on; turn off" : "Spoken responses off; turn on",
                    selected: ttsEnabled,
                    action: onTtsToggle
                )
                .accessibilityIdentifier("chat-tts-toggle")
            }
            Spacer(minLength: 0)
            if canInterrupt && !held {
                ComposerIconButton(systemName: "stop.fill", label: "Stop Sentient response", destructive: true, action: onInterrupt)
                    .accessibilityIdentifier("chat-interrupt")
            }
            if actions.showsSend {
                ComposerIconButton(systemName: "paperplane.fill", label: "Send message", selected: true, action: onSend)
                    .accessibilityIdentifier("chat-send")
            }
            if actions.showsVoiceCapture {
                VoiceCaptureControl(
                    talkMode: talkMode,
                    levels: micLevels,
                    disabled: voiceDisabled,
                    onIntent: onVoiceIntent
                )
            }
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
    }
}

private struct ComposerIconButton: View {
    let systemName: String
    let label: String
    var selected = false
    var destructive = false
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: DesignV2.Typography.large, weight: .semibold))
                .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
        }
        .buttonStyle(DesignButtonStyle(role: destructive ? .destructive : selected ? .action : .quiet))
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
