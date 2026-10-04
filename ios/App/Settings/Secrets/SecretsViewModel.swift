// ---------------------------------------------------------------------------
// SecretsViewModel — Admin "Secrets" page over `settings.admin` (provider keys)
// + `settings.applyProfileChange` (bare apply). Presence-only status (never key
// material), per-provider key update, active-provider selection, and the Custom
// base-URL. IMPERATIVE ops: PUT then refetch. After any successful key/base-URL/
// active change the running worker still holds the OLD key, so the page raises a
// "Restart assistant to pick up the new key" notice with an Apply-now button that
// drives `ApplyProfileChangeUseCase.applyOnly()` — the bare-apply entry the
// mobile-data layer settled on (POST /profile/apply, no mutation).
//
// Keys are NEVER logged (only provider name). @MainActor @Observable.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

private let appliedResetDelayNs: UInt64 = 3_000_000_000

@MainActor
@Observable
final class SecretsViewModel {
    /// The three LLM providers; rawValue is the exact gateway path/key token.
    enum Provider: String, CaseIterable {
        case openrouter
        case ollamaCloud = "ollama-cloud"
        case custom
    }

    /// Which row (if any) is in edit mode. Only one at a time (webui parity).
    enum EditTarget: Equatable {
        case none
        case key(Provider)
        case customBaseUrl
    }

    /// The restart-notice / apply lifecycle.
    enum ApplyPhase: Equatable {
        case hidden
        case notice
        case applying
        case applied
        case alreadyApplying
        case failed(String)
    }

    private(set) var status: SecretsStatus?
    private(set) var isError = false
    private(set) var isNotAdmin = false
    private(set) var mutationError: String?
    private(set) var editing: EditTarget = .none
    private(set) var isSavingKey = false
    private(set) var apply: ApplyPhase = .hidden

    private let loadStatus: () async throws -> SentientResult<SecretsStatus>
    private let writeKey: (String, String?, String?) async throws -> SentientResult<KotlinUnit>
    private let writeActive: (String) async throws -> SentientResult<KotlinUnit>
    private var editorRevision = 0
    private let applyProfileChange: ApplyProfileChangeUseCase?
    private let log = AppLog("settings", "secrets-vm")
    private var appliedResetTask: Task<Void, Never>?

    init(admin: AdminUseCases, applyProfileChange: ApplyProfileChangeUseCase) {
        self.loadStatus = { try await admin.getSecretsStatus() }
        self.writeKey = { try await admin.setLlmProviderKey(provider: $0, value: $1, baseUrl: $2) }
        self.writeActive = { try await admin.setActiveLlmProvider(provider: $0) }
        self.applyProfileChange = applyProfileChange
    }

    init(
        loadStatus: @escaping () async throws -> SentientResult<SecretsStatus>,
        writeKey: @escaping (String, String?, String?) async throws -> SentientResult<KotlinUnit>,
        writeActive: @escaping (String) async throws -> SentientResult<KotlinUnit>
    ) {
        self.loadStatus = loadStatus
        self.writeKey = writeKey
        self.writeActive = writeActive
        self.applyProfileChange = nil
    }

    var isBusy: Bool { isSavingKey || apply == .applying }

    /// Load presence status. Idempotent; safe on each `.task`.
    func load() async {
        isError = false
        isNotAdmin = false
        do {
            let result = try await loadStatus()
            switch onEnum(of: result) {
            case .success(let s):
                status = s.data
                isError = false
                isNotAdmin = false
                log.info("secrets.loaded active=\(s.data.llm.active)")
            case .failure(let f):
                isNotAdmin = isAuthorizationFailure(kindName: f.error.kind.name)
                isError = !isNotAdmin
                log.warn("secrets.load.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            isError = true
        }
    }

    func startEditKey(_ provider: Provider) { startEdit(.key(provider)) }
    func startEditBaseUrl() { startEdit(.customBaseUrl) }
    func cancelEdit() {
        guard !isBusy else { return }
        editorRevision += 1
        editing = .none
    }

    private func startEdit(_ target: EditTarget) {
        guard !isBusy else { return }
        editorRevision += 1
        mutationError = nil
        editing = target
    }

    /// Save a provider key (value never logged), refetch, then raise the restart notice.
    func saveKey(_ provider: Provider, value: String) async {
        await mutate("key.saved provider=\(provider.rawValue)", editor: .key(provider)) {
            try await self.writeKey(provider.rawValue, value, nil)
        }
    }

    /// Save the Custom base URL, refetch, then raise the restart notice.
    func saveBaseUrl(_ url: String) async {
        await mutate("baseurl.saved", editor: .customBaseUrl) {
            try await self.writeKey(Provider.custom.rawValue, nil, url)
        }
    }

    /// Select the active provider, refetch, then raise the restart notice.
    func setActive(_ provider: Provider) async {
        await mutate("active.set provider=\(provider.rawValue)") {
            try await self.writeActive(provider.rawValue)
        }
    }

    /// Apply now: restart the worker so the new key is picked up. Drives the FSM.
    func applyNow() async {
        guard !isBusy, let applyProfileChange else { return }
        appliedResetTask?.cancel()
        apply = .applying
        for await state in applyProfileChange.applyOnly() {
            switch onEnum(of: state) {
            case .saving, .restarting:
                apply = .applying
            case .ready:
                apply = .applied
                log.info("apply.ready")
                scheduleAppliedReset()
            case .alreadyApplying:
                apply = .alreadyApplying
                log.warn("apply.already-applying")
            case .failed(let f):
                apply = .failed(f.error.userMessage)
                log.warn("apply.failed kind=\(f.error.kind.name)")
            case .idle:
                break
            }
        }
    }

    func dismissNotice() {
        guard !isBusy else { return }
        appliedResetTask?.cancel()
        apply = .hidden
    }

    /// Run a secrets mutation, then refetch + raise the restart notice on success.
    private func mutate<T>(_ label: String, editor: EditTarget? = nil, _ call: @escaping () async throws -> SentientResult<T>) async {
        guard !isBusy, editor == nil || editor == editing else { return }
        let revision = editorRevision
        isSavingKey = true
        mutationError = nil
        appliedResetTask?.cancel()
        defer { isSavingKey = false }
        do {
            let result = try await call()
            switch onEnum(of: result) {
            case .success:
                log.info(label)
                await load()
                // Keep the submitted editor visible through refresh, then close
                // only that context. Provider selection preserves unrelated drafts.
                if let editor, editing == editor, editorRevision == revision {
                    cancelSubmittedEditor()
                }
                mutationError = nil
                apply = .notice
            case .failure(let f):
                if isAuthorizationFailure(kindName: f.error.kind.name) {
                    isNotAdmin = true
                    status = nil
                    editing = .none
                } else {
                    mutationError = f.error.userMessage
                }
                log.warn("secrets.mutate.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            mutationError = "Couldn't save this change. Please try again."
            log.warn("secrets.mutate.threw")
        }
    }

    private func cancelSubmittedEditor() {
        editorRevision += 1
        editing = .none
    }

    private func scheduleAppliedReset() {
        appliedResetTask?.cancel()
        appliedResetTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: appliedResetDelayNs) } catch { return }
            guard let self, self.apply == .applied else { return }
            self.apply = .hidden
        }
    }
}
