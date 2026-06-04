// ---------------------------------------------------------------------------
// BackendSetupModel — drives the iOS backend setup view. Save folds in a probe
// (createAuthClient → listUsers); success persists + reconfigures the SdkStore
// and signals dismiss; failure shows an error and stays.
// ---------------------------------------------------------------------------
import Foundation
import MobileSdk

@MainActor
final class BackendSetupModel: ObservableObject {
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
        self.port = existing.map { String($0.port) } ?? "8888"
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
            case .failure:
                log.warn("save.failed")
                isSaving = false
                error = "Couldn't verify the server. Check the host, port, and TLS option."
            }
        } catch {
            log.warn("save.threw: \(error)")
            isSaving = false
            self.error = "Can't reach that server. Check the host, port, and TLS option."
        }
    }
}
