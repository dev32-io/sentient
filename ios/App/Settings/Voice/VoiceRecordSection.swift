import SwiftUI

struct VoiceRecordSection: View {
    let state: VoiceAddViewModel.RecordState
    let elapsedSeconds: Double
    let canFinish: Bool
    let previewingTake: Bool
    let disabled: Bool
    let onRecordTapped: () -> Void
    let onStopRecording: () -> Void
    let onReRecord: () -> Void
    let onTogglePreview: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        DesignPane(title: state == .review ? "Review your sample" : "Record a sample") {
            switch state {
            case .idle: idle
            case .recording: recording
            case .review: review
            case .denied: denied
            }
        }
        .accessibilityIdentifier("settings-voice-record-\(state.identifier)")
    }

    private var idle: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignActionButton(title: "Record", state: disabled ? .disabled : .normal, accessibilityId: "settings-voice-add-record", action: onRecordTapped)
            hint("Record about 10–15 seconds of clear speech.")
        }
    }

    private var recording: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Label(String(format: "%.1f seconds", elapsedSeconds), systemImage: "record.circle.fill")
                .designText(.body)
                .foregroundStyle(DuskColors.stop)
                .accessibilityLabel("Recording, \(Int(elapsedSeconds)) seconds")
            DesignActionButton(
                title: "Use recording",
                state: canFinish && !disabled ? .normal : .disabled,
                accessibilityId: "settings-voice-add-use-recording",
                action: onStopRecording
            )
            if !canFinish { hint("Record at least \(Int(VoiceAddViewModel.minRecordingSeconds)) seconds to continue.") }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            AsyncNotice(kind: .success, title: "Recording ready", detail: String(format: "%.1f seconds", elapsedSeconds))
            DesignActionButton(
                title: previewingTake ? "Stop preview" : "Play recording",
                role: .quiet,
                state: disabled ? .disabled : .normal,
                accessibilityId: "settings-voice-add-review-play",
                action: onTogglePreview
            )
            DesignActionButton(
                title: "Record again", role: .quiet, state: disabled ? .disabled : .normal,
                accessibilityId: "settings-voice-add-rerecord", action: onReRecord
            )
        }
    }

    private var denied: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            AsyncNotice(
                kind: .warning,
                title: "Microphone access is off",
                detail: "Enable it in Settings, or switch to Upload."
            )
            DesignActionButton(
                title: "Open Settings", role: .quiet, state: disabled ? .disabled : .normal,
                accessibilityId: "settings-voice-add-open-settings", action: onOpenSettings
            )
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).designText(.caption).foregroundStyle(DuskColors.ink2)
    }
}

private extension VoiceAddViewModel.RecordState {
    var identifier: String {
        switch self {
        case .idle: "idle"
        case .recording: "recording"
        case .review: "review"
        case .denied: "denied"
        }
    }
}

#Preview("Record states — fake, no audio") {
    ScrollView {
        VStack(spacing: Space.lg) {
            VoiceRecordSection(state: .idle, elapsedSeconds: .zero, canFinish: false, previewingTake: false, disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {}, onTogglePreview: {}, onOpenSettings: {})
            VoiceRecordSection(state: .recording, elapsedSeconds: VoiceAddViewModel.minRecordingSeconds, canFinish: true, previewingTake: false, disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {}, onTogglePreview: {}, onOpenSettings: {})
            VoiceRecordSection(state: .review, elapsedSeconds: VoiceAddViewModel.minRecordingSeconds, canFinish: true, previewingTake: true, disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {}, onTogglePreview: {}, onOpenSettings: {})
            VoiceRecordSection(state: .denied, elapsedSeconds: .zero, canFinish: false, previewingTake: false, disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {}, onTogglePreview: {}, onOpenSettings: {})
        }
        .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .environment(\.dynamicTypeSize, .accessibility3)
    .transaction { $0.disablesAnimations = true }
    .preferredColorScheme(.dark)
}
