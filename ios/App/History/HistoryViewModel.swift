// ---------------------------------------------------------------------------
// HistoryViewModel — drives the history side panel's session list + search state.
//
// Consumes session.historyRepo.load() (Flow<SentientResult<List<SessionRowData>>>)
// via the same SKIE SkieSwiftFlow iteration pattern as ChatViewModel uses for
// chatStream. Each call to load() emits Loading(cached) immediately (instant
// drawer render from cache), then Success or Failure from the live fetch —
// giving cache-then-refresh UX that matches Android HistoryViewModel.
//
// SessionRowData{id, title, updatedAtMs} → SessionRow mapping mirrors Android's
// toSessionRow(): startedAt=0, lastActiveAt=updatedAtMs, messageCount=0,
// isActive=false.
//
// refresh() re-collects load() (cold Flow — each collection re-runs fetch).
// Mutations (switchSession/newChat/rename/delete) still route through session.sdk.
//
// Search is client-side substring over title.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published private(set) var sessions: [SessionRow] = []
    @Published var query: String = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?

    private let session: MobileSession
    private let log = AppLog("history", "model")

    /// In-flight load task; cancelled and replaced each time refresh() is called.
    private var loadTask: Task<Void, Never>?

    init(session: MobileSession) {
        self.session = session
    }

    // ── Rows after client-side search filter ─────────────────────────────────

    var visible: [SessionRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return sessions }
        return sessions.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    // ── Refresh ──────────────────────────────────────────────────────────────

    /// Re-collect load(). Cancels any in-flight collection; load() is cold so
    /// each collection re-runs the cache-then-refresh pair.
    func refresh() {
        log.info("refresh")
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            guard let self else { return }
            for await result in session.historyRepo.load() {
                guard !Task.isCancelled else { break }
                apply(result)
            }
        }
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    func switchSession(_ sessionId: String) async {
        log.info("switchSession sessionId=\(sessionId)")
        do { try await session.sdk.switchSession(sessionId: sessionId) } catch {
            log.warn("switchSession failed reason=\(error.localizedDescription)")
        }
        refresh()
    }

    func newChat() async {
        log.info("newChat")
        do { try await session.sdk.doNewChat() } catch {
            log.warn("newChat failed reason=\(error.localizedDescription)")
        }
        refresh()
    }

    func renameSession(_ sessionId: String, title: String) async {
        log.info("renameSession sessionId=\(sessionId)")
        do { try await session.sdk.renameSession(id: sessionId, title: title) } catch {
            log.warn("renameSession failed reason=\(error.localizedDescription)")
        }
        refresh()
    }

    func deleteSession(_ sessionId: String) async {
        log.info("deleteSession sessionId=\(sessionId)")
        do { try await session.sdk.deleteSession(id: sessionId) } catch {
            log.warn("deleteSession failed reason=\(error.localizedDescription)")
        }
        refresh()
    }

    // ── Result folding ────────────────────────────────────────────────────────

    private func apply(_ result: SentientResult<NSArray>) {
        switch onEnum(of: result) {
        case .loading(let l):
            loading = true
            if let rows = l.partial as? [SessionRowData] {
                sessions = rows.map { $0.toSessionRow() }
                log.debug("load.cache count=\(sessions.count)")
            }
        case .success(let s):
            if let rows = s.data as? [SessionRowData] {
                sessions = rows.map { $0.toSessionRow() }
                log.info("loaded count=\(sessions.count)")
            }
            loading = false
            error = nil
        case .failure(let f):
            log.warn("load-failed reason=\(f.error.userMessage)")
            loading = false
            error = f.error.userMessage
        }
    }
}

// ── SessionRowData → SessionRow mapping ──────────────────────────────────────

private extension SessionRowData {
    /// Maps the repository row to the SDK's SessionRow shape.
    /// Mirrors Android HistoryViewModel.toSessionRow():
    ///   startedAt=0, lastActiveAt=updatedAtMs, messageCount=0, isActive=false.
    func toSessionRow() -> SessionRow {
        SessionRow(
            sessionId: id,
            rootId: nil,
            title: title,
            startedAt: 0,
            lastActiveAt: updatedAtMs,
            messageCount: 0,
            isActive: false
        )
    }
}

// ---------------------------------------------------------------------------
// Preview support — exposes a setter so #Preview blocks can seed sessions
// without performing real I/O.
// ---------------------------------------------------------------------------
#if DEBUG
extension HistoryViewModel {
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
