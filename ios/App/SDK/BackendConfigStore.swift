// ---------------------------------------------------------------------------
// BackendConfigStore — persists the user-entered BackendConfig in UserDefaults.
// Synchronous read so the first frame knows whether to force the setup page.
// ---------------------------------------------------------------------------
import Foundation

struct BackendConfigStore {
    private let defaults: UserDefaults
    private let kHost = "backend.host"
    private let kPort = "backend.port"
    private let kSecurity = "backend.security"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load() -> BackendConfig? {
        guard let host = defaults.string(forKey: kHost),
              let secRaw = defaults.string(forKey: kSecurity),
              let security = ConnectionSecurity(rawValue: secRaw) else { return nil }
        let port = defaults.integer(forKey: kPort)
        guard (1...65535).contains(port) else { return nil }
        return BackendConfig(host: host, port: port, security: security)
    }

    func save(_ config: BackendConfig) {
        defaults.set(config.host, forKey: kHost)
        defaults.set(config.port, forKey: kPort)
        defaults.set(config.security.rawValue, forKey: kSecurity)
    }
}
