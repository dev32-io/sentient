// ---------------------------------------------------------------------------
// HistoryModel — drives the history side panel's session list + search state.
//
// Consumes session.sdk.listSessions() directly (the same SDK surface the old
// SdkStore.listSessions used) — avoids the HistoryRepository.load() flow's
// SKIE generic bridging complexity (List<SessionRowData> → [SessionRowData]
// cast is not guaranteed safe across SKIE boundaries). This is semantically
// equivalent: request-then-cache, refresh on open + after each mutation.
//
// The HistoryRepository's load() flow is still used internally by the session
// (connection/outbox flush collector) — this file consumes the SDK's direct
// session-list method, which returns SessionsListPage ([SessionRow]) directly.
//
// Search is client-side substring over title (gateway does not expose sessions.search).
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// Deadline for the session-list fetch. Mirror the old SdkStore timeout.
private let listSessionsTimeoutSeconds: Double = 12

/// Page size for the session list fetch. Mirrors Android's LIST_PAGE_LIMIT (50).
private let listPageLimit: Int32 = 50

@MainActor
final class HistoryModel: ObservableObject {
    @Published private(set) var sessions: [SessionRow] = []
    @Published var query: String = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?

    private let session: MobileSession
    private let log = AppLog("history", "model")

    init(session: MobileSession) {
        self.session = session
    }

    // ── Rows after client-side search filter ────────────────────────────────────

    var visible: [SessionRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return sessions }
        return sessions.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    // ── Refresh ─────────────────────────────────────────────────────────────────

    /// Re-fetch the session list. Call on panel open + after each mutation.
    func refresh() async {
        log.info("refresh")
        await loadSessions()
    }

    // ── Mutations ───────────────────────────────────────────────────────────────

    func switchSession(_ sessionId: String) async {
        log.info("switchSession sessionId=\(sessionId)")
        do { try await session.sdk.switchSession(sessionId: sessionId) } catch {
            log.warn("switchSession failed reason=\(error.localizedDescription)")
        }
        await loadSessions()
    }

    func newChat() async {
        log.info("newChat")
        do { try await session.sdk.doNewChat() } catch {
            log.warn("newChat failed reason=\(error.localizedDescription)")
        }
        await loadSessions()
    }

    func renameSession(_ sessionId: String, title: String) async {
        log.info("renameSession sessionId=\(sessionId)")
        do { try await session.sdk.renameSession(id: sessionId, title: title) } catch {
            log.warn("renameSession failed reason=\(error.localizedDescription)")
        }
        await loadSessions()
    }

    func deleteSession(_ sessionId: String) async {
        log.info("deleteSession sessionId=\(sessionId)")
        do { try await session.sdk.deleteSession(id: sessionId) } catch {
            log.warn("deleteSession failed reason=\(error.localizedDescription)")
        }
        await loadSessions()
    }

    // ── Load via sdk.listSessions ───────────────────────────────────────────────

    private func loadSessions() async {
        loading = true
        error = nil
        do {
            let page = try await withThrowingTaskGroup(of: SessionsListPage.self) { group in
                group.addTask { try await self.session.sdk.listSessions(limit: listPageLimit, offset: 0) }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(listSessionsTimeoutSeconds * 1_000_000_000))
                    throw HistoryModelError.timedOut
                }
                guard let result = try await group.next() else { throw HistoryModelError.timedOut }
                group.cancelAll()
                return result
            }
            log.info("loaded count=\(page.items.count) total=\(page.total)")
            sessions = page.items
            loading = false
            error = nil
        } catch {
            log.warn("load-failed reason=\(error.localizedDescription)")
            loading = false
            self.error = error.localizedDescription
        }
    }
}

private enum HistoryModelError: Error {
    case timedOut
}

// ---------------------------------------------------------------------------
// Preview support — exposes a setter so #Preview blocks can seed sessions
// without performing real I/O.
// ---------------------------------------------------------------------------
#if DEBUG
extension HistoryModel {
    /// Overwrite the session list for SwiftUI previews (never call in production).
    func seedForPreview(_ rows: [SessionRow]) {
        sessions = rows
    }

    /// Seed an error state for SwiftUI previews.
    func seedErrorForPreview(_ message: String, rows: [SessionRow] = []) {
        sessions = rows
        error = message
        loading = false
    }
}
#endif
