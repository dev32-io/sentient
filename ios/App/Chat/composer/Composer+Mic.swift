// ---------------------------------------------------------------------------
// Composer+Mic — mic-permission gate and composer previews, extracted from
// Composer.swift to keep that file within the clean-code line limit.
//
// MicPermission wraps the iOS 17+ AVAudioApplication record-permission API
// (three states: granted / denied / undetermined). Composer calls
// onMicTap() from its button row; the helper lives here alongside the
// permission enum it depends on.
//
// #Preview blocks are compile-time tooling only; they import AVFoundation/
// SwiftUI through Composer.swift's module scope, so no re-import is needed.
// ---------------------------------------------------------------------------
import AVFoundation
import SwiftUI

// ── Mic-permission gate ───────────────────────────────────────────────────
//
// Active mic → stop without a permission check. Inactive → gate on the
// AVAudio record permission: granted toggles immediately; undetermined
// requests it and toggles on grant; denied shows the inline notice and does
// NOT start. The request hop lands back on the main actor before mutating UI.

extension Composer {
    func onMicTap() {
        if micActive {
            onMicToggle()
            return
        }
        switch MicPermission.status() {
        case .granted:
            micDenied = false
            onMicToggle()
        case .denied:
            log.warn("micTap denied")
            micDenied = true
        case .undetermined:
            log.info("micTap requesting permission")
            MicPermission.request { granted in
                Task { @MainActor in
                    log.info("micPermissionResult granted=\(granted)")
                    if granted {
                        micDenied = false
                        onMicToggle()
                    } else {
                        micDenied = true
                    }
                }
            }
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
            sendInFlight: false,
            onSend: { _ in },
            onMicToggle: {},
            onTtsToggle: {},
            onInterrupt: {}
        )
    }
    .background(DuskColors.bg)
}

#Preview("Mic on (waveform + Listening…)") {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: true,
            canInterrupt: false,
            sendInFlight: false,
            onSend: { _ in },
            onMicToggle: {},
            onTtsToggle: {},
            onInterrupt: {}
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
            sendInFlight: false,
            onSend: { _ in },
            onMicToggle: {},
            onTtsToggle: {},
            onInterrupt: {}
        )
    }
    .background(DuskColors.bg)
}

#Preview("Send in-flight (spinner)") {
    VStack {
        Spacer()
        Composer(
            canSend: true,
            ttsEnabled: true,
            micActive: false,
            canInterrupt: false,
            sendInFlight: true,
            onSend: { _ in },
            onMicToggle: {},
            onTtsToggle: {},
            onInterrupt: {}
        )
    }
    .background(DuskColors.bg)
}
