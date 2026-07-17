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
    private(set) var editing: EditTarget = .none
    private(set) var isSavingKey = false
    private(set) var apply: ApplyPhase = .hidden

    private let admin: AdminUseCases
    private let applyProfileChange: ApplyProfileChangeUseCase
    private let log = AppLog("settings", "secrets-vm")
    private var appliedResetTask: Task<Void, Never>?

    init(admin: AdminUseCases, applyProfileChange: ApplyProfileChangeUseCase) {
        self.admin = admin
        self.applyProfileChange = applyProfileChange
    }

    /// Load presence status. Idempotent; safe on each `.task`.
    func load() async {
        do {
            let result = try await admin.getSecretsStatus()
            switch onEnum(of: result) {
            case .success(let s):
                status = s.data
                isError = false
                log.info("secrets.loaded active=\(s.data.llm.active)")
            case .failure(let f):
                isError = true
                log.warn("secrets.load.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            isError = true
        }
    }

    func startEditKey(_ provider: Provider) { editing = .key(provider) }
    func startEditBaseUrl() { editing = .customBaseUrl }
    func cancelEdit() { editing = .none }

    /// Save a provider key (value never logged), refetch, then raise the restart notice.
    func saveKey(_ provider: Provider, value: String) async {
        await mutate("key.saved provider=\(provider.rawValue)") {
            try await self.admin.setLlmProviderKey(provider: provider.rawValue, value: value, baseUrl: nil)
        }
    }

    /// Save the Custom base URL, refetch, then raise the restart notice.
    func saveBaseUrl(_ url: String) async {
        await mutate("baseurl.saved") {
            try await self.admin.setLlmProviderKey(provider: Provider.custom.rawValue, value: nil, baseUrl: url)
        }
    }

    /// Select the active provider, refetch, then raise the restart notice.
    func setActive(_ provider: Provider) async {
        await mutate("active.set provider=\(provider.rawValue)") {
            try await self.admin.setActiveLlmProvider(provider: provider.rawValue)
        }
    }

    /// Apply now: restart the worker so the new key is picked up. Drives the FSM.
    func applyNow() async {
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
        appliedResetTask?.cancel()
        apply = .hidden
    }

    /// Run a secrets mutation, then refetch + raise the restart notice on success.
    private func mutate<T>(_ label: String, _ call: @escaping () async throws -> SentientResult<T>) async {
        isSavingKey = true
        defer { isSavingKey = false }
        do {
            let result = try await call()
            switch onEnum(of: result) {
            case .success:
                editing = .none
                log.info(label)
                await load()
                apply = .notice
            case .failure(let f):
                log.warn("secrets.mutate.failed kind=\(f.error.kind.name)")
            case .loading:
                break
            }
        } catch is CancellationError {
        } catch {
            log.warn("secrets.mutate.threw")
        }
    }

    private func scheduleAppliedReset() {
        appliedResetTask?.cancel()
        appliedResetTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: appliedResetDelayNs)
            guard let self, self.apply == .applied else { return }
            self.apply = .hidden
        }
    }
}
