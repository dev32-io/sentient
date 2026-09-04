import Foundation
import MobileData
import SwiftUI
import UIKit

/// Internal capture mini-component. It emits semantic intents only; KMP owns
/// capture IDs, first-terminal-wins, frame ordering, and barge-in.
struct VoiceCaptureControl: View {
    let talkMode: TalkMode
    let levels: [Float]
    let disabled: Bool
    var permission: VoiceCapturePermission = .live
    let onHoldPresentationChanged: (Bool) -> Void
    let onIntent: (VoiceCaptureIntent) -> Void

    @State private var state: VoiceCaptureState = .idle
    @State private var target: VoiceCaptureTarget = .send
    @State private var startedAt: Date?
    @State private var gestureActive = false
    @State private var gestureProgress = VoiceCaptureGestureProgress()
    @State private var physicalPressState = VoiceCapturePhysicalPressState()
    /// True after a semantic capture has started and until its terminal or
    /// lifecycle transition is delivered. It prevents teardown from emitting a
    /// second terminal intent for the same capture.
    @State private var captureNeedsCancellation = false
    @State private var announcement = ""
    @Environment(\.scenePhase) private var scenePhase

    init(
        talkMode: TalkMode,
        levels: [Float],
        disabled: Bool,
        permission: VoiceCapturePermission = .live,
        onHoldPresentationChanged: @escaping (Bool) -> Void,
        onIntent: @escaping (VoiceCaptureIntent) -> Void
    ) {
        self.talkMode = talkMode
        self.levels = levels
        self.disabled = disabled
        self.permission = permission
        self.onHoldPresentationChanged = onHoldPresentationChanged
        self.onIntent = onIntent
        _state = State(initialValue: VoiceCaptureReducer.authority(talkMode, disabled: disabled))
        _captureNeedsCancellation = State(initialValue: talkMode != .idle && !disabled)
    }

    var body: some View {
        VoiceCaptureSurface(
            state: state,
            target: target,
            levels: levels,
            disabled: disabled,
            physicallyPressed: physicalPressState.isPressed,
            announcement: announcement,
            captureGesture: captureGesture,
            onActivate: activateForAccessibility,
            onStartAccessibleHold: beginAccessibleHold,
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
            onBegin: { sample in
                guard !disabled else { return }
                physicalPressState.begin()
                gestureProgress.begin(at: sample.locationInWindow)
                if state == .auto {
                    gestureActive = true
                    startedAt = Date()
                } else {
                    beginPhysicalHold()
                }
            },
            onChange: { sample in
                guard gestureActive else { return }
                gestureProgress.update(at: sample.locationInWindow)
                if state == .hold { selectTarget(at: sample) }
            },
            onTerminate: { termination, sample in
                physicalPressState.end()
                guard gestureActive else { return }
                gestureProgress.update(at: sample.locationInWindow)
                if state == .hold, termination == .released {
                    // UIKit can deliver the final position with `.ended`
                    // without a matching `.changed` callback.
                    selectTarget(at: sample)
                }
                let maximumTravel = gestureProgress.maximumTravel
                gestureProgress.reset()
                gestureActive = false
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
                finishHold(
                    VoiceCaptureReducer.terminatePhysicalHold(
                        from: state,
                        target: target,
                        elapsed: elapsed,
                        maximumTravel: maximumTravel,
                        termination: termination
                    ),
                    termination: termination
                )
            }
        )
    }

    private func selectTarget(at sample: VoiceCaptureGestureSample) {
        let next = VoiceCaptureReducer.target(
            at: sample.locationInWindow,
            geometry: sample.targetGeometryInWindow
        )
        if next != target {
            target = next
            UISelectionFeedbackGenerator().selectionChanged()
            announce("\(next.rawValue.capitalized) selected.")
        }
    }

    private func beginPhysicalHold() {
        guard state != .transitioning else { return }
        switch permission.status() {
        case .granted:
            gestureActive = true
            startedAt = Date()
            target = .send
            apply(VoiceCaptureReducer.begin(from: state))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            announce("Listening. Send selected.")
        case .denied:
            setPresentationState(.denied)
            announce("Microphone permission denied. Text input is still available.")
        case .undetermined:
            setPresentationState(.transitioning)
            permission.request { granted in
                Task { @MainActor in
                    setPresentationState(granted ? .idle : .denied)
                    announce(granted ? "Microphone ready. Hold again to talk." : "Microphone permission denied. Text input is still available.")
                }
            }
        }
    }

    private func beginAccessibleHold() {
        guard !disabled, state != .transitioning else { return }
        beginPhysicalHold()
    }

    private func completeHold(_ choice: VoiceCaptureTarget) {
        target = choice
        gestureActive = false
        physicalPressState.end()
        gestureProgress.reset()
        finishHold(
            VoiceCaptureReducer.release(
                from: state,
                target: choice,
                elapsed: VoiceCaptureReducer.quickAutoThreshold,
                maximumTravel: VoiceCaptureReducer.quickAutoTravelThreshold
            ),
            termination: .released
        )
    }

    private func finishHold(
        _ transition: VoiceCaptureTransition,
        termination: VoiceCaptureGestureTermination
    ) {
        apply(transition)
        guard !transition.intents.isEmpty else { return }
        if termination == .cancelled {
            announce("Voice capture cancelled by the system.")
        } else if transition.intents.contains(.cancelHeld) {
            announce("Voice message cancelled.")
        } else if transition.intents.contains(.enterAuto) {
            announce("Auto listening on.")
        } else if transition.intents.contains(.sendHeld) {
            announce("Voice message sent.")
        }
    }

    private func activateForAccessibility() {
        guard !disabled, state != .transitioning else { return }
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
        setPresentationState(transition.state)
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
        setPresentationState(VoiceCaptureReducer.authority(talkMode, disabled: disabled))
        captureNeedsCancellation = talkMode != .idle && !disabled
        if state == .idle || state == .disabled {
            gestureActive = false
            gestureProgress.reset()
            physicalPressState.end()
        }
    }

    private func lifecycleCancel() {
        physicalPressState.end()
        guard captureNeedsCancellation else { return }
        gestureActive = false
        gestureProgress.reset()
        let transition = VoiceCaptureReducer.interrupt(from: state)
        guard !transition.intents.isEmpty else {
            captureNeedsCancellation = false
            return
        }
        apply(transition)
        if disabled { setPresentationState(.disabled) }
        announce("Voice capture cancelled by the system.")
    }

    private func setPresentationState(_ next: VoiceCaptureState) {
        state = next
        onHoldPresentationChanged(next == .hold && !disabled)
    }

    private func announce(_ text: String) {
        announcement = text
        UIAccessibility.post(notification: .announcement, argument: text)
    }
}
