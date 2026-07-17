// ---------------------------------------------------------------------------
// AudioViewModel — the Audio settings page state holder. FAST save: a profile
// PUT whose only diff is `audio` takes ApplyProfileChangeUseCase's audio-only
// fast path (PUT + live WS preference patch, NO Hermes restart). So this page's
// Save never shows the "restarting…" copy — Ready lands immediately.
//
// Holds the loaded ProfileV1 as `original` (the mutation's `previous`) plus the
// two Swift-native draft primitives the controls bind to. Dirty is derived from
// those primitives (KMP data classes aren't Swift-Equatable, so we never compare
// ProfileV1 directly). Save rebuilds `next` and collects the FSM flow.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class AudioViewModel {
    /// Initial-load phase for the page body.
    enum Phase: Equatable {
        case loading
        case ready
        case failed(String)
    }

    /// Save FSM projection. Audio is fast so `.restarting` never occurs, but the
    /// case is kept so the projection matches the shared ApplyState alphabet.
    enum Save: Equatable {
        case idle
        case saving
        case restarting
        case alreadyApplying
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private(set) var save: Save = .idle

    /// Draft primitives bound to the controls.
    var ttsEnabled = false
    var channel = ProfileEnums.shared.audioChannels.first ?? "voice"

    private var original: ProfileV1?
    private let settings: SettingsComponent
    private let log = AppLog("settings", "audio-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
    }

    /// True once the draft differs from the loaded profile's audio section.
    var isDirty: Bool {
        guard let o = original else { return false }
        return ttsEnabled != o.audio.ttsEnabled || channel != o.audio.channel
    }

    /// True while a save is in flight (Save is disabled, a banner shows).
    var isApplying: Bool { save == .saving || save == .restarting }

    /// Load the profile and seed original + draft. Folds the envelope exhaustively.
    func load() async {
        log.info("load")
        do {
            let result = try await settings.profileRepository.getProfile()
            switch onEnum(of: result) {
            case .success(let s):
                apply(s.data)
                phase = .ready
                log.info("load.ready tts=\(ttsEnabled) channel=\(channel)")
            case .failure(let f):
                phase = .failed(f.error.userMessage)
                log.warn("load.failed kind=\(f.error.kind)")
            case .loading:
                phase = .loading
            }
        } catch is CancellationError {
            // View gone — not a failure.
        } catch {
            phase = .failed("Couldn't load audio settings.")
            log.warn("load.threw")
        }
    }

    /// Fast save: PUT profile → live audio patch (no restart) → refetch truth.
    func save() async {
        guard let o = original, isDirty else { return }
        log.info("save.start tts=\(ttsEnabled) channel=\(channel)")
        let mutation = ProfileMutationPutProfile(previous: o, next: nextProfile(from: o))
        for await state in settings.applyProfileChange.invoke(mutation: mutation) {
            switch onEnum(of: state) {
            case .idle: break
            case .saving: save = .saving
            case .restarting: save = .restarting
            case .ready:
                save = .idle
                log.info("save.ready")
                await load()
            case .alreadyApplying:
                save = .alreadyApplying
                log.warn("save.already-applying")
            case .failed(let f):
                save = .failed(f.error.userMessage)
                log.warn("save.failed")
            }
        }
    }

    private func apply(_ profile: ProfileV1) {
        original = profile
        ttsEnabled = profile.audio.ttsEnabled
        channel = profile.audio.channel
    }

    private func nextProfile(from o: ProfileV1) -> ProfileV1 {
        ProfileV1(
            schemaVersion: o.schemaVersion,
            userId: o.userId,
            model: o.model,
            voice: o.voice,
            audio: ProfileAudio(ttsEnabled: ttsEnabled, channel: channel),
            persona: o.persona,
            tools: o.tools,
            compression: o.compression,
            advanced: o.advanced,
            devices: o.devices
        )
    }
}
