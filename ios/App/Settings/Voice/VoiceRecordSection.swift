// ---------------------------------------------------------------------------
// VoiceRecordSection — the record-mode UI for Add Voice: the idle → recording →
// review state machine plus the mic-denied rationale + settings-bounce. Mirrors
// the webui VoiceCapture states. Stateless leaf: state + closures in, no VM.
// ---------------------------------------------------------------------------
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
        switch state {
        case .idle: idle
        case .recording: recording
        case .review: review
        case .denied: denied
        }
    }

    private var idle: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            actionButton("Record", icon: "mic.fill", action: onRecordTapped)
                .accessibilityIdentifier("settings-voice-add-record")
            hint("Record ~10–15s of clear speech.")
        }
    }

    private var recording: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(spacing: Space.sm) {
                Circle().fill(DuskColors.stop).frame(width: 10, height: 10)
                Text(String(format: "%.1fs", elapsedSeconds))
                    .font(Typo.mono(TypeScale.base))
                    .foregroundStyle(DuskColors.ink)
            }
            HStack(spacing: Space.sm) {
                actionButton("Use recording", icon: "checkmark", action: onStopRecording)
                    .disabled(!canFinish)
                    .accessibilityIdentifier("settings-voice-add-use-recording")
            }
            if !canFinish {
                hint("Record at least \(Int(VoiceAddViewModel.minRecordingSeconds))s to continue.")
            }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text(String(format: "Recorded %.1fs.", elapsedSeconds))
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
            HStack(spacing: Space.sm) {
                actionButton(previewingTake ? "Stop" : "Play", icon: previewingTake ? "stop.fill" : "play.fill", action: onTogglePreview)
                    .accessibilityIdentifier("settings-voice-add-review-play")
                actionButton("Re-record", icon: "arrow.counterclockwise", action: onReRecord)
                    .accessibilityIdentifier("settings-voice-add-rerecord")
            }
        }
    }

    private var denied: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Microphone access is off. Enable it in Settings, or switch to Upload.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.stop)
            actionButton("Open Settings", icon: "gear", action: onOpenSettings)
                .accessibilityIdentifier("settings-voice-add-open-settings")
        }
    }

    private func actionButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.xs) {
                Image(systemName: icon)
                Text(title).font(Typo.ui(TypeScale.sm, .semibold))
            }
            .foregroundStyle(DuskColors.ink)
            .padding(.horizontal, Space.md)
            .padding(.vertical, Space.sm)
            .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
            .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.xs))
            .foregroundStyle(DuskColors.ink3)
    }
}

#Preview {
    VStack(alignment: .leading, spacing: Space.xl) {
        VoiceRecordSection(state: .idle, elapsedSeconds: 0, canFinish: false, previewingTake: false,
                           disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {},
                           onTogglePreview: {}, onOpenSettings: {})
        VoiceRecordSection(state: .recording, elapsedSeconds: 3.4, canFinish: false, previewingTake: false,
                           disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {},
                           onTogglePreview: {}, onOpenSettings: {})
        VoiceRecordSection(state: .review, elapsedSeconds: 8.2, canFinish: true, previewingTake: false,
                           disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {},
                           onTogglePreview: {}, onOpenSettings: {})
        VoiceRecordSection(state: .denied, elapsedSeconds: 0, canFinish: false, previewingTake: false,
                           disabled: false, onRecordTapped: {}, onStopRecording: {}, onReRecord: {},
                           onTogglePreview: {}, onOpenSettings: {})
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
