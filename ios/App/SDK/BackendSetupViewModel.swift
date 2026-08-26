import Foundation
import MobileData

private let probeRetryDelay: Duration = .milliseconds(1_500)

/// Pure validation shared by the setup UI and focused tests. It intentionally
/// returns only user-facing configuration errors and never includes host input.
func backendValidationError(host: String, port: String) -> String? {
    let normalizedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedHost.isEmpty else { return "Enter a host or IP." }
    let forbiddenHostText = ["://", "/", "@", "?", "#"]
    guard !forbiddenHostText.contains(where: normalizedHost.contains),
          normalizedHost.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
        return "Enter a host or IP without a scheme, credentials, or path."
    }
    guard let value = Int(port), (1...65_535).contains(value) else {
        return "Port must be 1–65535."
    }
    return nil
}

@MainActor
final class BackendSetupViewModel: ObservableObject {
    typealias Probe = (BackendConfig) async -> Bool

    @Published var host: String
    @Published var port: String
    @Published var security: ConnectionSecurity
    @Published private(set) var isSaving = false
    @Published private(set) var didSave = false
    @Published private(set) var error: String?

    private let reconfigure: (BackendConfig) -> Void
    private let probe: Probe
    private let retryDelay: Duration
    private let log = AppLog("backend", "setup")

    init(
        existing: BackendConfig?,
        reconfigure: @escaping (BackendConfig) -> Void,
        probe: @escaping Probe = BackendSetupViewModel.productionProbe,
        retryDelay: Duration = probeRetryDelay
    ) {
        host = existing?.host ?? ""
        port = existing.map { String($0.port) } ?? "443"
        security = existing?.security ?? .tlsValid
        self.reconfigure = reconfigure
        self.probe = probe
        self.retryDelay = retryDelay
    }

    func save() {
        if let validation = backendValidationError(host: host, port: port) {
            error = validation
            return
        }
        guard let portValue = Int(port) else { return }
        let candidate = BackendConfig(
            host: host.trimmingCharacters(in: .whitespacesAndNewlines),
            port: portValue,
            security: security
        )
        // Deliberately omit host, credentials, and endpoint text from diagnostics.
        log.info("save.probe security=\(security.rawValue)")
        isSaving = true
        didSave = false
        error = nil
        Task { await probeThenApply(candidate) }
    }

    private func probeThenApply(_ candidate: BackendConfig) async {
        if await probe(candidate) {
            apply(candidate)
            return
        }
        log.info("save.retry waiting before single retry")
        do {
            try await Task.sleep(for: retryDelay)
        } catch {
            isSaving = false
            return
        }
        guard !Task.isCancelled else { isSaving = false; return }
        if await probe(candidate) {
            apply(candidate)
            return
        }
        log.warn("save.failed after retry")
        isSaving = false
        error = "Couldn't verify the server. Check the host, port, and TLS option."
    }

    private func apply(_ candidate: BackendConfig) {
        log.info("save.ok")
        reconfigure(candidate)
        isSaving = false
        didSave = true
    }

    /// External probe adapter. The iOS AuthClient factory installs the bounded
    /// request timeout; this boundary folds typed and thrown failures to `false`.
    nonisolated static func productionProbe(_ candidate: BackendConfig) async -> Bool {
        let client = createAuthClient(
            gatewayWsUrl: candidate.gatewayWsURL,
            allowSelfSignedDevHost: candidate.allowSelfSigned
        )
        do {
            let result = try await client.listUsers()
            if case .success = onEnum(of: result) { return true }
            return false
        } catch {
            return false
        }
    }
}
