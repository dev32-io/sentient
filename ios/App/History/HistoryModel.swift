// ---------------------------------------------------------------------------
// HistoryModel — drives the History sheet's session list + search state.
//
// Mirrors the Android HistoryViewModel (history/HistoryViewModel.kt): the SDK
// does NOT surface a sessions StateFlow / onSessionsChanged through SentientSdk,
// so per the D-A4/D-I4 plan the sheet re-queries listSessions() on present +
// after every mutation (switch / rename / delete / new). That keeps the list
// reconnect-safe and never stale — each refresh re-reads the gateway truth,
// including the freshly-recomputed isActive flag that drives the active-row
// highlight.
//
// Search mirrors the webui semantics but filters CLIENT-SIDE (SentientSdk does
// not expose sessions.search) — a substring match over the loaded title list.
//
// This is the iOS UI app's own state holder (ios-architecture-mvvm rule): an
// @MainActor ObservableObject the sheet reads, with one async mutation surface
// that forwards to the app-level SdkStore. It is NOT a second state machine over
// the SDK — the SDK owns no session-list surface, so the list lives here,
// fetched on demand.
// ---------------------------------------------------------------------------
import Foundation
import MobileSdk

/// Page size for the session list fetch. Mirrors Android's LIST_PAGE_LIMIT (50).
private let listPageLimit: Int32 = 50

@MainActor
final class HistoryModel: ObservableObject {
    @Published private(set) var sessions: [SessionRow] = []
    @Published var query: String = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?

    private let store: SdkStore
    private let log = AppLog("history", "model")

    init(store: SdkStore) {
        self.store = store
    }

    /// Rows after the client-side search filter (substring over title).
    var visible: [SessionRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return sessions }
        return sessions.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Re-query the session list. Call on sheet present + after any mutation.
    func refresh() async {
        log.info("refresh")
        await loadSessions()
    }

    func switchSession(_ sessionId: String) async {
        log.info("switchSession sessionId=\(sessionId)")
        do { try await store.switchSession(sessionId) } catch { warn("switch-failed", error) }
        await loadSessions()
    }

    func newChat() async {
        log.info("newChat")
        do { try await store.newChat() } catch { warn("new-failed", error) }
        await loadSessions()
    }

    func renameSession(_ sessionId: String, title: String) async {
        log.info("renameSession sessionId=\(sessionId)")
        do { try await store.renameSession(sessionId, title: title) } catch { warn("rename-failed", error) }
        await loadSessions()
    }

    func deleteSession(_ sessionId: String) async {
        log.info("deleteSession sessionId=\(sessionId)")
        do { try await store.deleteSession(sessionId) } catch { warn("delete-failed", error) }
        await loadSessions()
    }

    private func loadSessions() async {
        loading = true
        error = nil
        do {
            let page = try await store.listSessions(limit: listPageLimit, offset: 0)
            log.info("loaded count=\(page.items.count) total=\(page.total)")
            sessions = page.items
            loading = false
            error = nil
        } catch {
            warn("load-failed", error)
            loading = false
            self.error = error.localizedDescription
        }
    }

    private func warn(_ event: String, _ error: Error) {
        log.warn("\(event) reason=\(error.localizedDescription)")
    }
}

// ---------------------------------------------------------------------------
// Preview support — exposes a setter so #Preview blocks can seed sessions
// without performing real listSessions I/O.
// ---------------------------------------------------------------------------
#if DEBUG
extension HistoryModel {
    /// Overwrite the session list for SwiftUI previews (never call in production).
    func seedForPreview(_ rows: [SessionRow]) {
        sessions = rows
    }

    /// Seed an error state (and optional rows) for SwiftUI previews so the
    /// sessions-error / stale-banner affordances can be rendered without I/O.
    func seedErrorForPreview(_ message: String, rows: [SessionRow] = []) {
        sessions = rows
        error = message
        loading = false
    }
}
#endif
