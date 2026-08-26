// ---------------------------------------------------------------------------
// VoiceViewModel — the thin state-holder for the Voice list page. Loads the voice
// library + the current active voice, owns the filter inputs (search / source /
// tags / language), and drives preview / pick / delete over `settings.voices`.
//
// The library is fetched ONCE (unfiltered) and filtered locally for responsive
// search — mirroring the webui VoicesPanel (fetch-all-once + `filterPacks` in the
// view), and keeping the tag/language filter options derivable from the full set.
// The KMP `filterVoices` stays the wire-tested source of truth; this Swift filter
// is a view-layer mirror for keystroke responsiveness only.
//
// Active-voice seed reads `profileRepository.getProfile()` directly — the
// SettingsComponent exposes its repos "for the rare direct read" (its own doc);
// VoicesUseCases has no plain active-voice getter, and `pickActive` returns the
// saved profile so the badge re-anchors from the write.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

extension Notification.Name {
    /// Posted by the Add / Fish-clone VMs after a successful create/clone so the
    /// still-alive VoiceScreen refetches its list when the sub-page pops back.
    /// (The parent's NavigationStack `.task` never re-fires on pop, and the host
    /// route wiring can't be extended with a success callback — this is the
    /// deterministic cross-screen signal.)
    static let voiceLibraryChanged = Notification.Name("io.sentient.voiceLibraryChanged")
}

@MainActor
@Observable
final class VoiceViewModel {
    enum Phase: Equatable { case loading, loaded, failed }

    private(set) var phase: Phase = .loading
    private(set) var allVoices: [VoiceSummary] = []
    private(set) var activeVoiceId: String = ""
    /// Gates the "Clone from Fish" entry (features.fish_browse_enabled). Degrades
    /// to hidden on any access-read failure (fail-safe) — mirrors the root gate.
    private(set) var fishBrowseEnabled = false

    // Filter inputs (mirror VoiceFilterState; "all"/"" = no filter).
    var query: String = ""
    var source: String = "all"
    var selectedTags: [String] = []
    var language: String = ""

    // Ephemeral op state.
    private(set) var previewingId: String?
    private(set) var previewLoadingId: String?
    private(set) var busy = false
    var notice: String?
    var pendingDelete: VoiceSummary?

    private let settings: SettingsComponent
    private let player = VoiceSamplePlayer()
    private var previewTask: Task<Void, Never>?
    private let log = AppLog("settings", "voice-vm")

    init(settings: SettingsComponent) {
        self.settings = settings
        player.onFinished = { [weak self] in self?.previewingId = nil }
    }

    var shownVoices: [VoiceSummary] {
        VoiceLibraryFiltering.apply(
            allVoices, query: query, source: source,
            selectedTags: selectedTags, language: language
        )
    }

    var tagOptions: [String] {
        Array(Set(allVoices.flatMap { $0.tags })).sorted()
    }

    var languageOptions: [(code: String, label: String)] {
        VoiceLanguages.filterOptions(present: allVoices.map { $0.language })
    }

    /// Load the library + active voice + fish gate. Idempotent; safe on each `.task`.
    func load() async {
        log.info("load")
        phase = allVoices.isEmpty ? .loading : phase
        async let profile: Void = seedActiveVoice()
        async let access: Void = loadFishGate()
        await refresh()
        await profile
        await access
    }

    private func loadFishGate() async {
        do {
            let result = try await settings.observeSettingsAccess.invoke()
            if case .success(let s) = onEnum(of: result) {
                fishBrowseEnabled = s.data.fishBrowseEnabled
                log.info("fishGate enabled=\(fishBrowseEnabled)")
            }
        } catch is CancellationError {
        } catch {
            log.warn("fishGate.threw code=transport")
        }
    }

    /// Re-fetch the list + active voice after a sub-page create/clone (clone
    /// auto-activates server-side, so the badge must re-anchor too).
    func onLibraryChanged() async {
        log.info("library.changed")
        await refresh()
        await seedActiveVoice()
    }

    /// Re-fetch just the library list (after create/delete/clone returns).
    func refresh() async {
        do {
            let result = try await settings.voices.listFiltered(filter: emptyFilter())
            switch onEnum(of: result) {
            case .success(let s):
                allVoices = (s.data as? [VoiceSummary]) ?? []
                phase = .loaded
                log.info("load.ok count=\(allVoices.count)")
            case .failure(let f):
                phase = .failed
                log.warn("load.failed kind=\(f.error.kind.name)")
            case .loading:
                phase = .loading
            }
        } catch is CancellationError {
        } catch {
            phase = .failed
            log.warn("load.threw code=transport")
        }
    }

    private func seedActiveVoice() async {
        do {
            let result = try await settings.profileRepository.getProfile()
            if case .success(let s) = onEnum(of: result) {
                activeVoiceId = s.data.voice.id
                log.debug("active.seed")
            }
        } catch is CancellationError {
        } catch {
            log.warn("active.seed.threw code=transport")
        }
    }

    /// Toggle preview for [voice]: stop if it's playing, else fetch + play its WAV.
    func togglePreview(_ voice: VoiceSummary) {
        if previewingId == voice.voiceId {
            player.stop()
            previewingId = nil
            return
        }
        previewLoadingId = voice.voiceId
        previewTask?.cancel()
        previewTask = Task { await playPreview(voice) }
    }

    private func playPreview(_ voice: VoiceSummary) async {
        defer { if previewLoadingId == voice.voiceId { previewLoadingId = nil } }
        do {
            let result = try await settings.voices.preview(voiceId: voice.voiceId, lang: voice.language)
            guard previewLoadingId == voice.voiceId else { return } // superseded
            switch onEnum(of: result) {
            case .success(let s):
                let data = s.data.toData()
                log.debug("preview.ok bytes=\(data.count)")
                try player.playData(data)
                previewingId = voice.voiceId
            case .failure(let f):
                notice = "Couldn't play preview"
                log.warn("preview.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch {
            notice = "Couldn't play preview"
            log.warn("preview.threw code=transport")
        }
    }

    /// Pick [voice] as the active voice (FAST profile PUT; re-anchors the badge).
    func pick(_ voice: VoiceSummary) {
        guard !busy, activeVoiceId != voice.voiceId else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let result = try await settings.voices.pickActive(voiceId: voice.voiceId)
                switch onEnum(of: result) {
                case .success(let s):
                    activeVoiceId = s.data.voice.id
                    log.info("pick.ok")
                case .failure(let f):
                    notice = "Couldn't switch voice"
                    log.warn("pick.failed kind=\(f.error.kind.name)")
                case .loading:
                    break
                }
            } catch {
                notice = "Couldn't switch voice"
                log.warn("pick.threw code=transport")
            }
        }
    }

    /// Confirm-then-delete a user pack. The server resets the active pick to the
    /// default when the deleted pack was active; we re-seed from the fresh profile.
    func confirmDelete() {
        guard let voice = pendingDelete else { return }
        pendingDelete = nil
        busy = true
        if previewingId == voice.voiceId { player.stop(); previewingId = nil }
        Task {
            defer { busy = false }
            do {
                let result = try await settings.voices.delete(voiceId: voice.voiceId)
                switch onEnum(of: result) {
                case .success(let s):
                    notice = s.data.warning != nil ? "Voice deleted, but the active pick may be stale." : "Voice deleted"
                    log.info("delete.ok warning=\(s.data.warning != nil)")
                    await refresh()
                    await seedActiveVoice()
                case .failure(let f):
                    notice = "Couldn't delete voice"
                    log.warn("delete.failed kind=\(f.error.kind.name)")
                case .loading:
                    break
                }
            } catch {
                notice = "Couldn't delete voice"
                log.warn("delete.threw code=transport")
            }
        }
    }

    /// Stop playback + release the audio session on screen teardown.
    func teardown() {
        previewTask?.cancel()
        previewTask = nil
        player.stop()
        previewingId = nil
        previewLoadingId = nil
    }

    func toggleTag(_ tag: String) {
        if let idx = selectedTags.firstIndex(of: tag) {
            selectedTags.remove(at: idx)
        } else {
            selectedTags.append(tag)
        }
    }

    private func emptyFilter() -> VoiceFilterState {
        VoiceFilterState(query: "", source: "all", tags: [], language: "")
    }
}
