// ---------------------------------------------------------------------------
// HistoryViewModel — drives the history side panel's session list + search.
//
// Swift mirror of Android's HistoryViewModel over the User/Connection-scoped
// ChatComponent: reads the session list via observeSessions (suspend list fetch)
// and routes rename/delete through the same component. It NO LONGER switches
// conversation or starts a new chat — those are NAVIGATIONS owned by the host
// (the drawer's onSelect/onNewChat callbacks flip the host's activeSessionId).
// So this VM is read + mutate (rename/delete) only.
//
// Search is client-side substring over the loaded title list (the SDK does not
// expose a session search). The published surface (visible/loading/hasLoaded/
// error/query/refresh) is unchanged so HistorySidePanel renders identically.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

/// Page size for the session-list fetch — the drawer shows the most-recent chats.
private let sessionsPageLimit: Int32 = 100

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published private(set) var sessions: [SessionRow] = []
    @Published var query: String = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    /// False until the first terminal load result. Drives the panel's open-slide
    /// spinner so an empty list never paints mid-animation. Latches once true.
    @Published private(set) var hasLoaded = false

    private let component: ChatComponent
    private let log = AppLog("history", "model")

    /// In-flight load task; cancelled and replaced on each refresh().
    private var loadTask: Task<Void, Never>?

    init(component: ChatComponent) {
        self.component = component
    }

    // ── Rows after client-side search filter ─────────────────────────────────

    var visible: [SessionRow] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return sessions }
        return sessions.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
    }

    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    // ── Refresh ──────────────────────────────────────────────────────────────

    /// Re-query the session list. Call on drawer-open + after any mutation.
    func refresh() async {
        log.info("refresh")
        loadTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.loadSessions()
        }
        loadTask = task
        await task.value
    }

    private func loadSessions() async {
        loading = true
        error = nil
        do {
            let summaries = try await component.observeSessions.invoke(limit: sessionsPageLimit, offset: 0)
            guard !Task.isCancelled else { return }
            sessions = summaries.map { $0.toSessionRow() }
            loading = false
            hasLoaded = true
            error = nil
            log.info("loaded count=\(sessions.count)")
        } catch is CancellationError {
            // Drawer dismissed / replaced — not a real failure.
        } catch {
            guard !Task.isCancelled else { return }
            loading = false
            hasLoaded = true
            self.error = "Can't load conversation history."
            log.warn("load-failed code=transport")
        }
    }

    // ── Mutations ─────────────────────────────────────────────────────────────

    func renameSession(_ sessionId: String, title: String) async {
        log.info("renameSession sessionId=\(sessionId)")
        do { try await component.renameSession.invoke(sessionId: sessionId, title: title) } catch {
            log.warn("renameSession failed code=transport")
        }
        await refresh()
    }

    func deleteSession(_ sessionId: String) async {
        log.info("deleteSession sessionId=\(sessionId)")
        do { try await component.deleteSession.invoke(sessionId: sessionId) } catch {
            log.warn("deleteSession failed code=transport")
        }
        await refresh()
    }
}

// ── SessionSummary → SessionRow mapping ──────────────────────────────────────

private extension SessionSummary {
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
// Preview support — seed sessions without real I/O.
// ---------------------------------------------------------------------------
#if DEBUG
extension HistoryViewModel {
    /// Overwrite the session list for SwiftUI previews (never call in production).
    func seedForPreview(_ rows: [SessionRow]) {
        sessions = rows
        hasLoaded = true
    }

    /// Seed an error state for SwiftUI previews.
    func seedErrorForPreview(_ message: String, rows: [SessionRow] = []) {
        sessions = rows
        error = message
        loading = false
        hasLoaded = true
    }
}
#endif
