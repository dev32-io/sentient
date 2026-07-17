// ---------------------------------------------------------------------------
// VoiceRecorder — screen-scoped WAV capture for Add Voice, mirroring the Android
// VoiceRecorder (AudioRecord → 16-bit PCM mono WAV) and the webui VoiceCapture.
//
// AVAudioRecorder with LinearPCM WAV settings (16-bit, mono, 44100) to a temp file.
// Session policy: a PLAIN `.record` category activated on start and DEACTIVATED on
// stop / teardown — scoped to this screen and restored on exit. It deliberately does
// NOT use `.playAndRecord`/`.videoChat`: that VoIP mode belongs to the SDK's
// call-time `VoiceAudio` engine (VoiceAudio.ios.kt), which is idle while Settings is
// open. Review playback of a take runs through `VoiceSamplePlayer` (its own scoped
// `.playback`), so the recorder never needs a playback-capable category itself.
//
// NEVER logs audio content — byte counts / durations only.
// ---------------------------------------------------------------------------
import AVFoundation
import Foundation

/// Errors surfaced to the Add-Voice VM. Mic permission is gated by `MicPermission`
/// BEFORE `start()`, so these cover only session/recorder setup failures — both
/// degrade to an inline "couldn't record" notice.
enum VoiceRecorderError: Error, Equatable {
    case sessionFailed
    case recorderFailed
}

/// Owns one `AVAudioRecorder` + its scoped audio session. Driven by a `@MainActor`
/// VM; AVFoundation delegate callbacks are tolerated off-main (error logging only).
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate, @unchecked Sendable {
    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private let log = AppLog("settings", "voice-recorder")

    private static let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 44_100.0,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsFloatKey: false,
    ]

    /// Configure the scoped `.record` session and begin capture to a fresh temp WAV.
    func start() throws {
        try activateRecordSession()
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString).wav")
        do {
            let recorder = try AVAudioRecorder(url: url, settings: Self.settings)
            recorder.delegate = self
            guard recorder.record() else { throw VoiceRecorderError.recorderFailed }
            self.recorder = recorder
            self.fileURL = url
            log.info("record.start")
        } catch let error as VoiceRecorderError {
            throw error
        } catch {
            log.warn("record.start.failed reason=\(error.localizedDescription)")
            throw VoiceRecorderError.recorderFailed
        }
    }

    /// Stop capture, release the session, and return the recorded WAV URL (if any).
    @discardableResult
    func stop() -> URL? {
        recorder?.stop()
        recorder = nil
        deactivate()
        log.info("record.stop")
        return fileURL
    }

    /// Read the last recorded clip's bytes (WAV). Returns nil if nothing was recorded.
    func recordedData() -> Data? {
        guard let fileURL else { return nil }
        let data = try? Data(contentsOf: fileURL)
        if let data { log.debug("record.read bytes=\(data.count)") }
        return data
    }

    /// Discard the current recording + delete its temp file (re-record / exit).
    func discard() {
        recorder?.stop()
        recorder = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        deactivate()
    }

    private func activateRecordSession() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
        } catch {
            log.warn("session.activate.failed reason=\(error.localizedDescription)")
            throw VoiceRecorderError.sessionFailed
        }
    }

    private func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            log.warn("session.deactivate.failed reason=\(error.localizedDescription)")
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in self.log.warn("record.encode-error") }
    }
}
