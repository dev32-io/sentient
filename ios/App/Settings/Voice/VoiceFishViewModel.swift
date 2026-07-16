// ---------------------------------------------------------------------------
// VoiceFishViewModel — state + logic for the gated "Clone from Fish" page: browse /
// title-search the Fish library (paged, load-more), play a remote sample, and clone
// a picked entry (name prefilled from its title). Mirrors the webui FishClonePanel.
//
// The Fish surface is gated: every route 404s when `fish_browse_enabled` is off,
// modelled as `FishResult.FeatureDisabled` → the `.disabled` phase (inline notice,
// no crash). Sample playback streams `entry.previewAudioUrl` DIRECTLY (the gateway
// does NOT proxy Fish samples — same as webui/Android); play is disabled when that
// URL is absent. On a successful clone the VM posts `.voiceLibraryChanged` so the
// parent VoiceScreen refetches, then the page pops.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
@Observable
final class VoiceFishViewModel {
    enum Phase: Equatable { case loading, loaded, failed, disabled }

    private(set) var phase: Phase = .loading
    private(set) var entries: [FishVoiceEntry] = []
    private(set) var hasMore = false
    private(set) var loadingMore = false
    private(set) var playingId: String?

    var query: String = "" { didSet { scheduleSearch() } }

    // Clone editor (revealed when an entry is picked; name prefilled from title).
    private(set) var selected: FishVoiceEntry?
    var cloneName = ""
    var cloneLanguage = ""
    private(set) var cloneDescription = ""
    private(set) var cloneTags: [String] = []
    private(set) var cloning = false
    var notice: String?
    private(set) var done = false

    private var currentPage = 1
    private var searchTask: Task<Void, Never>?
    private let settings: SettingsComponent
    private let player = VoiceSamplePlayer()
    private let log = AppLog("settings", "voice-fish-vm")

    private static let searchDebounceNanos: UInt64 = 300_000_000

    init(settings: SettingsComponent) {
        self.settings = settings
        player.onFinished = { [weak self] in self?.playingId = nil }
    }

    /// Initial browse (no search term). Idempotent; safe on `.task`.
    func load() async {
        currentPage = 1
        await fetchFirst(title: nil)
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let term = query.trimmingCharacters(in: .whitespaces)
        searchTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: VoiceFishViewModel.searchDebounceNanos)
            guard !Task.isCancelled, let self else { return }
            self.currentPage = 1
            await self.fetchFirst(title: term.isEmpty ? nil : term)
        }
    }

    private func fetchFirst(title: String?) async {
        phase = entries.isEmpty ? .loading : phase
        do {
            let result = try await settings.voices.fishBrowse(title: title, page: nil)
            switch onEnum(of: result) {
            case .success(let s):
                entries = s.value?.voices ?? []
                hasMore = s.value?.hasMore ?? false
                phase = .loaded
                log.info("browse.ok count=\(entries.count) hasMore=\(hasMore)")
            case .featureDisabled:
                phase = .disabled
                log.warn("browse.feature-disabled")
            case .failure(let f):
                phase = .failed
                log.warn("browse.failed reason=\(fishFailure(f.error))")
            }
        } catch is CancellationError {
        } catch {
            phase = .failed
            log.warn("browse.threw reason=\(error.localizedDescription)")
        }
    }

    /// Fetch the next page and append (dedup by id — Fish paging can repeat entries).
    func loadMore() {
        guard hasMore, !loadingMore else { return }
        loadingMore = true
        let title = query.trimmingCharacters(in: .whitespaces)
        let next = currentPage + 1
        Task {
            defer { loadingMore = false }
            do {
                let result = try await settings.voices.fishBrowse(
                    title: title.isEmpty ? nil : title,
                    page: KotlinInt(int: Int32(next))
                )
                if case .success(let s) = onEnum(of: result), let page = s.value {
                    let existing = Set(entries.map { $0.id })
                    entries += page.voices.filter { !existing.contains($0.id) }
                    hasMore = page.hasMore
                    currentPage = next
                    log.info("loadMore.ok page=\(next) total=\(entries.count)")
                }
            } catch {
                log.warn("loadMore.threw reason=\(error.localizedDescription)")
            }
        }
    }

    /// Play / stop a remote sample. Disabled upstream when `previewAudioUrl` is nil.
    func toggleSample(_ entry: FishVoiceEntry) {
        if playingId == entry.id {
            player.stop()
            playingId = nil
            return
        }
        guard let raw = entry.previewAudioUrl, let url = URL(string: raw) else { return }
        player.playRemote(url)
        playingId = entry.id
        log.debug("sample.play")
    }

    /// Pick an entry to clone: reveal the editor prefilled from the entry.
    func select(_ entry: FishVoiceEntry) {
        selected = entry
        cloneName = entry.title
        cloneLanguage = VoiceLanguages.normalize(entry.languages.first ?? "")
        cloneDescription = entry.description_
        cloneTags = Array(entry.tags.prefix(VoiceCaps.maxTags))
    }

    func cancelSelect() { selected = nil }

    func setCloneName(_ value: String) { cloneName = String(value.prefix(VoiceCaps.nameMax)) }

    var canClone: Bool { selected != nil && !cloneName.trimmingCharacters(in: .whitespaces).isEmpty && !cloning }

    func clone() {
        guard canClone, let entry = selected else { return }
        let name = cloneName.trimmingCharacters(in: .whitespaces)
        cloning = true
        player.stop()
        playingId = nil
        log.info("clone.request nameLen=\(name.count) tags=\(cloneTags.count) lang=\(cloneLanguage)")
        Task {
            defer { cloning = false }
            do {
                let request = CloneFromFishRequest(
                    name: name,
                    description: cloneDescription,
                    tags: cloneTags,
                    language: cloneLanguage
                )
                let result = try await settings.voices.fishClone(fishVoiceId: entry.id, request: request)
                switch onEnum(of: result) {
                case .success(let s):
                    log.info("clone.ok id=\(s.value?.voiceId ?? "?") warning=\(s.value?.warning ?? "none")")
                    NotificationCenter.default.post(name: .voiceLibraryChanged, object: nil)
                    done = true
                case .featureDisabled:
                    notice = "Fish cloning is turned off."
                    log.warn("clone.feature-disabled")
                case .failure(let f):
                    notice = "Couldn't clone this voice"
                    log.warn("clone.failed reason=\(fishFailure(f.error))")
                }
            } catch {
                notice = "Couldn't clone this voice"
                log.warn("clone.threw reason=\(error.localizedDescription)")
            }
        }
    }

    func teardown() {
        searchTask?.cancel()
        player.stop()
        playingId = nil
    }

    /// Compact, non-sensitive label for an AuthError (Fish failures carry AuthError).
    private func fishFailure(_ error: AuthError) -> String {
        switch onEnum(of: error) {
        case .invalidCredentials: return "invalid-credentials"
        case .network: return "network"
        case .server: return "server"
        case .unknown: return "unknown"
        }
    }
}
