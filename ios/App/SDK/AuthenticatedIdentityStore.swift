// ---------------------------------------------------------------------------
// AuthenticatedIdentityStore — the non-secret server identity retained beside
// the Keychain token. Calendar namespaces must use AuthUser.userId from the
// successful login response; display names are deliberately not substitutes.
// ---------------------------------------------------------------------------
import Foundation

final class AuthenticatedIdentityStore {
    private static let key = "sentient.authenticated.userId"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> String? {
        guard let value = defaults.string(forKey: Self.key) else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? nil : normalized
    }

    func save(_ userId: String) {
        let normalized = userId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            clear()
            return
        }
        defaults.set(normalized, forKey: Self.key)
    }

    func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}
