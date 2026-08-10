// ---------------------------------------------------------------------------
// BackendSetupViewModel — drives the iOS backend setup view. Save folds in a probe
// (createAuthClient → listUsers); success persists + reconfigures the AppConfig
// and signals dismiss; failure shows an error and stays.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

// Delay before the single probe retry. The first probe may be the connection
// that raised the iOS Local Network prompt; this window lets the user tap
// "Allow" before we retry, so a just-granted permission isn't shown as failure.
private let probeRetryDelaySeconds: UInt64 = 1
private let probeRetryDelayNanosExtra: UInt64 = 500_000_000 // 1.5s total

@MainActor
final class BackendSetupViewModel: ObservableObject {
    @Published var host: String
    @Published var port: String
    @Published var security: ConnectionSecurity
    @Published private(set) var isSaving = false
    @Published private(set) var didSave = false
    @Published private(set) var error: String?

    private let reconfigure: (BackendConfig) -> Void
    private let log = AppLog("backend", "setup")

    init(existing: BackendConfig?, reconfigure: @escaping (BackendConfig) -> Void) {
        self.host = existing?.host ?? ""
        self.port = existing.map { String($0.port) } ?? "443"
        self.security = existing?.security ?? .tlsValid
        self.reconfigure = reconfigure
    }

    func save() {
        guard !host.trimmingCharacters(in: .whitespaces).isEmpty else {
            error = "Enter a host or IP."
            return
        }
        guard let portInt = Int(port), (1...65535).contains(portInt) else {
            error = "Port must be 1–65535."
            return
        }
        let candidate = BackendConfig(
            host: host.trimmingCharacters(in: .whitespaces),
            port: portInt,
            security: security
        )
        log.info("save.probe host=\(candidate.host) port=\(portInt) security=\(security.rawValue)")
        isSaving = true
        error = nil
        Task { await probeThenApply(candidate) }
    }

    private func probeThenApply(_ candidate: BackendConfig) async {
        // First probe may be the connection that raised the Local Network prompt.
        // If it fails, wait briefly (for the user to tap "Allow") and retry ONCE
        // before surfacing an error — but never more than once, so a genuinely
        // wrong host still fails fast.
        if await probeOnce(candidate) { return }
        log.info("save.retry waiting before single retry")
        let delay = probeRetryDelaySeconds * 1_000_000_000 + probeRetryDelayNanosExtra
        try? await Task.sleep(nanoseconds: delay)
        if await probeOnce(candidate) { return }
        log.warn("save.failed after retry")
        isSaving = false
        error = "Couldn't verify the server. Check the host, port, and TLS option."
    }

    /// Runs one probe attempt. On success: persists + reconfigures + signals
    /// dismiss and returns `true`. On any failure: returns `false` WITHOUT
    /// touching the error/isSaving UX (the caller decides retry vs. surface).
    private func probeOnce(_ candidate: BackendConfig) async -> Bool {
        let client = createAuthClient(
            gatewayWsUrl: candidate.gatewayWsURL,
            allowSelfSignedDevHost: candidate.allowSelfSigned
        )
        do {
            let result = try await client.listUsers()
            switch onEnum(of: result) {
            case .success:
                log.info("save.ok")
                reconfigure(candidate)
                isSaving = false
                didSave = true
                return true
            case .failure:
                log.warn("save.probe.failed")
                return false
            }
        } catch {
            log.warn("save.probe.threw: \(error)")
            return false
        }
    }
}
