// ---------------------------------------------------------------------------
// Composer+Mic — mic-permission gate and composer previews, extracted from
// Composer.swift to keep that file within the clean-code line limit.
//
// MicPermission wraps the iOS 17+ AVAudioApplication record-permission API
// (three states: granted / denied / undetermined). MicCorner calls
// onMicPressGate() on a press from idle; the helper lives here alongside the
// permission enum it depends on.
//
// #Preview blocks are compile-time tooling only; they import AVFoundation/
// SwiftUI through Composer.swift's module scope, so no re-import is needed.
// ---------------------------------------------------------------------------
import AVFoundation
import SwiftUI

// ── Mic-permission gate ───────────────────────────────────────────────────
//
// A corner-mic press from idle gates on the AVAudio record permission:
// granted → the control may enter hold (mic starts). Undetermined → fire the
// system request and do NOT enter hold; a grant does NOT auto-start (the user
// presses again). Denied → inline notice, no hold. A press from locked never
// consults the gate — the mic is already running.

extension Composer {
    /// Returns true only when record permission is already granted — MicCorner
    /// enters hold and starts the mic. The request hop lands back on the main
    /// actor before mutating UI.
    func onMicPressGate() -> Bool {
        switch MicPermission.status() {
        case .granted:
            micDenied = false
            return true
        case .denied:
            log.warn("micPress denied")
            micDenied = true
            return false
        case .undetermined:
            log.info("micPress requesting permission")
            MicPermission.request { granted in
                Task { @MainActor in
                    log.info("micPermissionResult granted=\(granted)")
                    micDenied = !granted
                }
            }
            return false
        }
    }
}

/// Record-permission gate over AVAudio. The app's deployment target is iOS 17,
/// so this routes through `AVAudioApplication` (the iOS 17+ replacement for the
/// deprecated `AVAudioSession` permission API). Three states mirror the Android
/// RECORD_AUDIO gate (granted / denied / undetermined).
enum MicPermission {
    enum Status { case granted, denied, undetermined }

    static func status() -> Status {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return .granted
        case .denied: return .denied
        default: return .undetermined
        }
    }

    static func request(_ completion: @escaping (Bool) -> Void) {
        AVAudioApplication.requestRecordPermission(completionHandler: completion)
    }
}

// ── Composer previews ─────────────────────────────────────────────────────

#Preview("Default") {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: false,
            canInterrupt: false,
            onSend: { _ in },
            onMicPress: {},
            onMicRelease: {},
            onMicLock: {},
            onMicStopContinuous: {},
            onTtsToggle: {},
            onInterrupt: {},
            onFocusGained: {}
        )
    }
    .background(DuskColors.bg)
}

#Preview("Mic active (listening glow)") {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: true,
            canInterrupt: false,
            onSend: { _ in },
            onMicPress: {},
            onMicRelease: {},
            onMicLock: {},
            onMicStopContinuous: {},
            onTtsToggle: {},
            onInterrupt: {},
            onFocusGained: {}
        )
    }
    .background(DuskColors.bg)
}

#Preview("Streaming (Type to interrupt… + tinted stop)") {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: false,
            canInterrupt: true,
            onSend: { _ in },
            onMicPress: {},
            onMicRelease: {},
            onMicLock: {},
            onMicStopContinuous: {},
            onTtsToggle: {},
            onInterrupt: {},
            onFocusGained: {}
        )
    }
    .background(DuskColors.bg)
}
