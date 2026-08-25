import Foundation
import UIKit

enum VoiceMicrophonePermission: Equatable {
    case granted, denied, undetermined
}

@MainActor
protocol VoicePermissionProviding {
    func status() -> VoiceMicrophonePermission
    func request(_ completion: @escaping (Bool) -> Void)
}

struct SystemVoicePermissionProvider: VoicePermissionProviding {
    func status() -> VoiceMicrophonePermission {
        switch MicPermission.status() {
        case .granted: .granted
        case .denied: .denied
        case .undetermined: .undetermined
        }
    }

    func request(_ completion: @escaping (Bool) -> Void) {
        MicPermission.request(completion)
    }
}

@MainActor
protocol VoiceRecording: AnyObject {
    func start() throws
    @discardableResult func stop() -> URL?
    func recordedData() -> Data?
    func discard()
}

@MainActor
protocol VoiceSamplePlaying: AnyObject {
    var onFinished: (@MainActor () -> Void)? { get set }
    func playData(_ data: Data) throws
    func playRemote(_ url: URL)
    func stop()
}

@MainActor
protocol VoiceSettingsOpening {
    func openMicrophoneSettings()
}

struct SystemVoiceSettingsOpener: VoiceSettingsOpening {
    func openMicrophoneSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

extension VoiceRecorder: VoiceRecording {}
extension VoiceSamplePlayer: VoiceSamplePlaying {}
