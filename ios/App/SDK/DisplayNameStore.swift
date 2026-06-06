// ---------------------------------------------------------------------------
// DisplayNameStore — persists the logged-in user's display name in UserDefaults.
//
// AuthUserLite (and AuthModel) are login-scoped and torn down after a successful
// login, so the selected user's display name is persisted here at login time and
// read back by SdkStore for the chat / history-drawer headers. Synchronous read
// so the first frame can show the real name.
//
// This is a DISPLAY name, not a secret — it never travels through the token /
// Keychain path. Cleared on logout (alongside the token) so a logged-out
// relaunch never shows a stale name. Mirrors BackendConfigStore's style.
// ---------------------------------------------------------------------------
import Foundation

struct DisplayNameStore {
    private let defaults: UserDefaults
    private let kDisplayName = "auth.displayName"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// Reads the persisted display name, or nil when nothing is stored or the
    /// stored value is blank (treated as absent so callers fall back cleanly).
    func load() -> String? {
        guard let name = defaults.string(forKey: kDisplayName) else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func save(_ name: String) {
        defaults.set(name, forKey: kDisplayName)
    }

    func clear() {
        defaults.removeObject(forKey: kDisplayName)
    }
}
