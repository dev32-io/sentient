import AVFoundation

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

/// Injectable permission boundary for the composer. Production uses the system
/// adapter; tests can decide permission without touching the microphone.
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
