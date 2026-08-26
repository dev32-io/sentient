import SwiftUI

/// The visual shell for the capture control. It composes presentation leaves
/// while VoiceCaptureControl supplies the semantic actions and gesture adapter.
struct VoiceCaptureSurface: View {
    let state: VoiceCaptureState
    let target: VoiceCaptureTarget
    let levels: [Float]
    let disabled: Bool
    let announcement: String
    let captureGesture: VoiceCaptureGesture
    let onActivate: () -> Void
    let onTarget: (VoiceCaptureTarget) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var presentation: VoiceCapturePresentationState {
        VoiceCapturePresentationState(state: state, disabled: disabled)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            if presentation.showsTargetDeck {
                VoiceCaptureTargetDeck(selected: target, onSelect: onTarget)
            }
            VoiceCapturePrimaryButton(
                presentation: presentation,
                levels: levels,
                captureGesture: captureGesture,
                onActivate: onActivate
            )
            if presentation.showsFailureNotice {
                VoiceCaptureFailureNotice(message: presentation.failureMessage)
            }
        }
        .animation(
            DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion),
            value: state
        )
        .accessibilityElement(children: .contain)
        .accessibilityValue(announcement)
    }
}

private struct VoiceCapturePrimaryButton: View {
    let presentation: VoiceCapturePresentationState
    let levels: [Float]
    let captureGesture: VoiceCaptureGesture
    let onActivate: () -> Void

    private var glyph: some View {
        Image(systemName: presentation.isAuto ? "waveform" : "mic.fill")
            .font(.system(size: DesignV2.Typography.large, weight: .semibold))
    }

    var body: some View {
        Button(action: onActivate) {
            if presentation.showsWaveform {
                HStack(spacing: Space.sm) {
                    PttBigWave(levels: levels)
                        .frame(width: VoiceCaptureLayout.waveformWidth)
                        .accessibilityHidden(true)
                    glyph
                }
                .padding(.horizontal, Space.md)
            } else {
                glyph
                    .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
            }
        }
        .foregroundStyle(presentation.isAuto ? DuskColors.bgSunk : DuskColors.ink)
        .frame(minWidth: DesignMetrics.minimumTarget, minHeight: DesignMetrics.minimumTarget)
        .buttonStyle(DesignButtonStyle(role: presentation.isAuto ? .action : .quiet))
        .disabled(presentation.isDisabled)
        .gesture(captureGesture)
        .accessibilityLabel(presentation.primaryLabel)
        .accessibilityAddTraits(presentation.isAuto ? .isSelected : [])
        .accessibilityIdentifier("chat-mic")
    }
}

private struct VoiceCaptureTargetDeck: View {
    let selected: VoiceCaptureTarget
    let onSelect: (VoiceCaptureTarget) -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            targetButton(.auto, icon: "waveform")
            targetButton(.cancel, icon: "xmark")
            targetButton(.send, icon: "paperplane.fill")
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .accessibilityLabel("Voice capture actions")
    }

    private func targetButton(_ choice: VoiceCaptureTarget, icon: String) -> some View {
        Button {
            onSelect(choice)
        } label: {
            Label(choice.rawValue.capitalized, systemImage: icon)
                .designText(.supporting)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .padding(.horizontal, Space.sm)
        }
        .buttonStyle(DesignButtonStyle(role: role(for: choice)))
        .accessibilityLabel(label(for: choice))
        .accessibilityAddTraits(selected == choice ? .isSelected : [])
        .accessibilityIdentifier("voice-\(choice.rawValue)")
    }

    private func role(for choice: VoiceCaptureTarget) -> DesignButtonRole {
        choice == .cancel ? .destructive : choice == .send ? .action : .quiet
    }

    private func label(for choice: VoiceCaptureTarget) -> String {
        switch choice {
        case .auto: "Switch to Auto listening"
        case .cancel: "Cancel voice message"
        case .send: "Send voice message"
        }
    }
}

private struct VoiceCaptureFailureNotice: View {
    let message: String

    var body: some View {
        Text(message)
            .designText(.supporting)
            .foregroundStyle(DuskColors.stop)
            .accessibilityIdentifier("mic-denied-notice")
    }
}

private enum VoiceCaptureLayout {
    static let waveformWidth = DesignMetrics.minimumTarget * 3
}
