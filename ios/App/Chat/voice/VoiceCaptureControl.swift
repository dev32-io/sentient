import AVFoundation
import SwiftUI
import UIKit
import MobileData

/// Shared native microphone permission adapter. It does not start audio.
enum MicPermission {
    enum Status { case granted, denied, undetermined }

    static func status() -> Status {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .granted
        case .denied: .denied
        default: .undetermined
        }
    }

    static func request(_ completion: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission(completionHandler: completion)
    }
}

private enum VoiceCaptureMetrics {
    static let waveformWidth = DesignMetrics.minimumTarget * 3
}

struct VoiceCapturePermission {
    enum Status { case granted, denied, undetermined }
    var status: () -> Status
    var request: (@escaping (Bool) -> Void) -> Void

    static let live = VoiceCapturePermission(
        status: {
            switch MicPermission.status() {
            case .granted: .granted
            case .denied: .denied
            case .undetermined: .undetermined
            }
        },
        request: MicPermission.request
    )
}

/// Internal capture mini-component. It emits semantic intents only; KMP owns
/// capture identity, first-terminal-wins, frame ordering, and barge-in.
struct VoiceCaptureControl: View {
    let talkMode: TalkMode
    let levels: [Float]
    let disabled: Bool
    var permission: VoiceCapturePermission = .live
    let onIntent: (VoiceCaptureIntent) -> Void

    @State private var state: VoiceCaptureState = .idle
    @State private var target: VoiceCaptureTarget = .send
    @State private var startedAt: Date?
    @State private var gestureActive = false
    @State private var captureNeedsCancellation = false
    /// A physical release is handled by the zero-distance gesture. Suppress the
    /// Button's trailing activation so a quick Hold-to-Auto cannot immediately
    /// fire the assistive Auto-exit action for the same touch.
    @State private var suppressButtonActivationUntil = Date.distantPast
    @State private var announcement = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            if state == .hold { targetDeck }
            primary
            if state == .denied || state == .failed {
                Text(state == .denied ? "Microphone access is off. Text messages are still available." : "Voice capture could not start. Text messages are still available.")
                    .designText(.supporting)
                    .foregroundStyle(DuskColors.stop)
                    .accessibilityIdentifier("mic-denied-notice")
            }
        }
        .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.state, reduceMotion: reduceMotion), value: state)
        .onAppear { synchronize() }
        .onChange(of: talkMode) { _, _ in synchronize() }
        .onChange(of: disabled) { _, now in
            if now { lifecycleCancel(reason: "disabled") }
            synchronize()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { lifecycleCancel(reason: "scene-interruption") }
        }
        .onDisappear { lifecycleCancel(reason: "teardown") }
        .accessibilityElement(children: .contain)
        .accessibilityValue(announcement)
    }

    private var primary: some View {
        Button(action: activateForAccessibility) {
            if state == .hold || state == .auto {
                HStack(spacing: Space.sm) {
                    PttBigWave(levels: levels)
                        .frame(width: VoiceCaptureMetrics.waveformWidth)
                        .accessibilityHidden(true)
                    captureGlyph
                }
                .padding(.horizontal, Space.md)
            } else {
                captureGlyph
                    .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
            }
        }
        .foregroundStyle(state == .auto ? DuskColors.bgSunk : DuskColors.ink)
        .frame(minWidth: DesignMetrics.minimumTarget, minHeight: DesignMetrics.minimumTarget)
        .buttonStyle(DesignButtonStyle(role: state == .auto ? .action : .quiet))
        .disabled(disabled)
        .gesture(captureGesture)
        .accessibilityLabel(primaryLabel)
        .accessibilityAddTraits(state == .auto ? .isSelected : [])
        .accessibilityIdentifier("chat-mic")
    }

    private var captureGlyph: some View {
        Image(systemName: state == .auto ? "waveform" : "mic.fill")
            .font(.system(size: DesignV2.Typography.large, weight: .semibold))
    }

    private var targetDeck: some View {
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
            target = choice
            completeHold(choice)
        } label: {
            Label(choice.rawValue.capitalized, systemImage: icon)
                .designText(.supporting)
                .frame(minHeight: DesignMetrics.minimumTarget)
                .padding(.horizontal, Space.sm)
        }
        .buttonStyle(DesignButtonStyle(role: choice == .cancel ? .destructive : choice == .send ? .action : .quiet))
        .accessibilityLabel(choice == .auto ? "Switch to Auto listening" : choice == .cancel ? "Cancel voice message" : "Send voice message")
        .accessibilityIdentifier("voice-\(choice.rawValue)")
    }

    private var captureGesture: VoiceCaptureGesture {
        VoiceCaptureGesture(
            onBegin: {
                guard !disabled else { return }
                if state == .auto {
                    gestureActive = true
                    startedAt = Date()
                } else {
                    beginPhysicalHold()
                }
            },
            onChange: { upwardTravel in
                guard gestureActive, state == .hold else { return }
                let next = VoiceCaptureReducer.target(for: upwardTravel)
                if next != target {
                    target = next
                    UISelectionFeedbackGenerator().selectionChanged()
                    announce("\(next.rawValue.capitalized) selected.")
                }
            },
            onTerminate: { termination in
                guard gestureActive else { return }
                gestureActive = false
                if state == .auto {
                    if termination == .released {
                        apply(VoiceCaptureReducer.activate(from: state))
                        announce("Auto listening off. Voice message sent.")
                    } else {
                        apply(VoiceCaptureReducer.interrupt(from: state))
                        announce("Voice capture cancelled by the system.")
                    }
                    return
                }
                let elapsed = Date().timeIntervalSince(startedAt ?? Date())
                apply(VoiceCaptureReducer.terminatePhysicalHold(
                    from: state,
                    target: target,
                    elapsed: elapsed,
                    termination: termination
                ))
            }
        )
    }

    private func beginPhysicalHold() {
        suppressButtonActivationUntil = Date().addingTimeInterval(0.5)
        switch permission.status() {
        case .granted:
            gestureActive = true
            captureNeedsCancellation = true
            startedAt = Date()
            target = .send
            apply(VoiceCaptureReducer.begin(from: state))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            announce("Listening. Send selected.")
        case .denied:
            state = .denied
            announce("Microphone permission denied. Text input is still available.")
        case .undetermined:
            state = .transitioning
            permission.request { granted in
                Task { @MainActor in
                    state = granted ? .idle : .denied
                    announce(granted ? "Microphone ready. Hold again to talk." : "Microphone permission denied. Text input is still available.")
                }
            }
        }
    }

    private func completeHold(_ choice: VoiceCaptureTarget) {
        gestureActive = false
        apply(VoiceCaptureReducer.release(from: state, target: choice, elapsed: VoiceCaptureReducer.quickAutoThreshold))
    }

    private func activateForAccessibility() {
        guard !disabled, Date() >= suppressButtonActivationUntil else { return }
        if state == .auto {
            apply(VoiceCaptureReducer.activate(from: state))
            announce("Auto listening off. Voice message sent.")
            return
        }
        guard permission.status() == .granted else {
            beginPhysicalHold()
            gestureActive = false
            return
        }
        apply(VoiceCaptureReducer.activate(from: state))
        announce("Auto listening on.")
    }

    private func apply(_ transition: VoiceCaptureTransition) {
        state = transition.state
        for intent in transition.intents {
            switch intent {
            case .holdStart, .enterAuto:
                captureNeedsCancellation = true
            case .sendHeld, .cancelHeld, .exitAuto, .lifecycleCancel:
                captureNeedsCancellation = false
            }
            onIntent(intent)
        }
    }

    private func synchronize() {
        state = VoiceCaptureReducer.authority(talkMode, disabled: disabled)
        captureNeedsCancellation = talkMode != .idle && !disabled
        if state == .idle { gestureActive = false }
    }

    private func lifecycleCancel(reason: String) {
        guard captureNeedsCancellation else { return }
        gestureActive = false
        apply(VoiceCaptureReducer.interrupt(from: state))
        if disabled { state = .disabled }
        announce("Voice capture cancelled by the system.")
    }

    private func announce(_ text: String) {
        announcement = text
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    private var primaryLabel: String {
        if disabled { return "Voice unavailable while reconnecting" }
        if state == .auto { return "Auto listening is on; activate to send and turn it off" }
        return "Tap for Auto listening or hold to talk"
    }
}
