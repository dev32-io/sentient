import Foundation
import SwiftUI
import UIKit
import MobileData

/// Internal capture mini-component. It emits semantic intents only; KMP owns
/// capture IDs, first-terminal-wins, frame ordering, and barge-in.
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
    /// True after a semantic capture has started and until its terminal or
    /// lifecycle transition is delivered. It prevents teardown from emitting a
    /// second terminal intent for the same capture.
    @State private var captureNeedsCancellation = false
    /// A physical release is handled by the zero-distance gesture. Suppress the
    /// Button's trailing activation so a quick Hold-to-Auto cannot immediately
    /// fire the assistive Auto-exit action for the same touch.
    @State private var suppressButtonActivationUntil = Date.distantPast
    @State private var announcement = ""
    @Environment(\.scenePhase) private var scenePhase

    private static let trailingButtonSuppression: TimeInterval = 0.5

    var body: some View {
        VoiceCaptureSurface(
            state: state,
            target: target,
            levels: levels,
            disabled: disabled,
            announcement: announcement,
            captureGesture: captureGesture,
            onActivate: activateForAccessibility,
            onTarget: completeHold
        )
        .onAppear { synchronize() }
        .onChange(of: talkMode) { _, _ in synchronize() }
        .onChange(of: disabled) { _, now in
            if now { lifecycleCancel() }
            synchronize()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { lifecycleCancel() }
        }
        .onDisappear { lifecycleCancel() }
    }

    private var captureGesture: VoiceCaptureGesture {
        VoiceCaptureGesture(
            onBegin: {
                guard !disabled else { return }
                if state == .auto {
                    // The physical release is the Auto exit action; do not let
                    // the enclosing Button replay it as a second activation.
                    suppressButtonActivation()
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
                // Cover the trailing Button event even when the physical hold
                // lasted longer than the initial gesture window.
                suppressButtonActivation()
                if state == .auto {
                    if termination == .released {
                        apply(VoiceCaptureReducer.activate(from: state))
                        announce("Auto listening off. Voice message sent.")
                    } else {
                        lifecycleCancel()
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
        guard state != .transitioning else { return }
        suppressButtonActivation()
        switch permission.status() {
        case .granted:
            gestureActive = true
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
        target = choice
        gestureActive = false
        apply(VoiceCaptureReducer.release(from: state, target: choice, elapsed: VoiceCaptureReducer.quickAutoThreshold))
    }

    private func activateForAccessibility() {
        guard !disabled, state != .transitioning, Date() >= suppressButtonActivationUntil else { return }
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

    private func suppressButtonActivation() {
        suppressButtonActivationUntil = Date().addingTimeInterval(Self.trailingButtonSuppression)
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
        if state == .idle || state == .disabled { gestureActive = false }
    }

    private func lifecycleCancel() {
        guard captureNeedsCancellation else { return }
        gestureActive = false
        let transition = VoiceCaptureReducer.interrupt(from: state)
        guard !transition.intents.isEmpty else {
            captureNeedsCancellation = false
            return
        }
        apply(transition)
        if disabled { state = .disabled }
        announce("Voice capture cancelled by the system.")
    }

    private func announce(_ text: String) {
        announcement = text
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}
