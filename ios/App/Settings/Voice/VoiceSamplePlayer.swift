// ---------------------------------------------------------------------------
// VoiceSamplePlayer — single-flight preview/sample playback for the voice cluster.
//
// TWO sources, one output policy (at most one clip audible at a time — mirrors the
// webui `use-voice-preview` single-flight rule + `FishClonePanel.togglePreview`):
//   - local voice-pack preview: WAV `Data` from `voices.preview` → `AVAudioPlayer`.
//   - Fish library sample: a REMOTE https URL (`FishVoiceEntry.previewAudioUrl`,
//     the same field the webui streams via `new Audio(url)`) → `AVPlayer`.
//
// Owns a scoped `.playback` AVAudioSession while a clip plays and deactivates it on
// stop, so a preview never fights the SDK's call-time `VoiceAudio` engine (which
// runs `.playAndRecord`/`.videoChat` and is idle while Settings is on screen).
// `onFinished` fires on the main actor when a clip ends naturally. NEVER logs bytes.
// ---------------------------------------------------------------------------
import AVFoundation
import Foundation

/// Plays at most one voice sample at a time from either local WAV bytes or a
/// remote URL. Not actor-isolated (AVFoundation delegates arrive off-main); the
/// finish callback hops to the main actor. Owned and driven by a `@MainActor` VM.
final class VoiceSamplePlayer: NSObject, AVAudioPlayerDelegate, @unchecked Sendable {
    /// Invoked on the main actor when the current clip finishes on its own.
    var onFinished: (@MainActor () -> Void)?

    private var dataPlayer: AVAudioPlayer?
    private var urlPlayer: AVPlayer?
    private var endObserver: NSObjectProtocol?
    private let log = AppLog("settings", "voice-player")

    /// Play local WAV `Data` (a voice-pack preview). Throws if the bytes can't be
    /// decoded; the caller surfaces a non-fatal notice.
    func playData(_ data: Data) throws {
        stop()
        activatePlayback()
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        dataPlayer = player
        log.debug("play.data bytes=\(data.count)")
        player.play()
    }

    /// Play a remote sample URL (a Fish library entry). Streams via `AVPlayer`.
    func playRemote(_ url: URL) {
        stop()
        activatePlayback()
        let player = AVPlayer(url: url)
        urlPlayer = player
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.finish() }
        }
        log.debug("play.remote")
        player.play()
    }

    /// Stop any current playback and release the session. Idempotent.
    func stop() {
        dataPlayer?.stop()
        dataPlayer = nil
        urlPlayer?.pause()
        urlPlayer = nil
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        deactivate()
    }

    @MainActor
    private func finish() {
        stop()
        onFinished?()
    }

    // AVAudioPlayerDelegate — data-clip completion. Arrives off the main actor.
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finish() }
    }

    private func activatePlayback() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true)
        } catch {
            log.warn("session.activate.failed code=audio-session")
        }
    }

    private func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            log.warn("session.deactivate.failed code=audio-session")
        }
    }
}
