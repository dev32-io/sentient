import Foundation
import MobileData

private let sessionsPageLimit: Int32 = 100

enum HistoryEntryKind: Equatable {
    case session(id: String, draftId: String?)
    case draft(id: String)
}

enum HistoryDestructiveAction: Equatable {
    case deleteConversation(sessionId: String)
    case discardDraft(draftId: String)
}

struct HistoryEntry: Identifiable, Equatable {
    let kind: HistoryEntryKind
    let title: String
    let lastActiveAt: Int64
    let hasDraft: Bool

    var id: String {
        switch kind {
        case .session(let id, _): id
        case .draft(let id): "draft-\(id)"
        }
    }
    var sessionId: String? {
        if case .session(let id, _) = kind { id } else { nil }
    }
    var draftId: String? {
        switch kind {
        case .session(_, let draftId): draftId
        case .draft(let id): id
        }
    }
    var isLocalDraft: Bool {
        if case .draft = kind { true } else { false }
    }
    var destructiveActions: [HistoryDestructiveAction] {
        var actions: [HistoryDestructiveAction] = sessionId.map { [.deleteConversation(sessionId: $0)] } ?? []
        if let draftId { actions.append(.discardDraft(draftId: draftId)) }
        return actions
    }
}

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published private(set) var sessions: [SessionRow] = []
    @Published private(set) var drafts: [NativeDraft] = []
    @Published private(set) var deleteIntents: [NativeDeleteIntent] = []
    @Published var query: String = ""
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var hasLoaded = false

    private let component: ChatComponent
    private let log = AppLog("history", "model")
    private var loadTask: Task<Void, Never>?
    private var draftsTask: Task<Void, Never>?
    private var sessionChangesTask: Task<Void, Never>?

    init(component: ChatComponent) {
        self.component = component
        if let coordinator = component.drafts {
            draftsTask = Task { [weak self] in
                for await snapshot in coordinator.snapshot {
                    self?.apply(snapshot)
                }
            }
        }
        sessionChangesTask = Task { [weak self] in
            for await event in component.sessionChanges {
                if case .deleted(let deleted) = onEnum(of: event) {
                    self?.sessions.removeAll { $0.sessionId == deleted.sessionId }
                }
            }
        }
    }

    var visible: [HistoryEntry] { historyEntries(sessions: sessions, drafts: drafts, deleting: deleteIntents, matching: query) }
    var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    var hasPermanentDeleteFailure: Bool { deleteIntents.contains { $0.failureCode == "permanent" } }

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
            if let snapshot = try await component.drafts?.restore() { apply(snapshot) }
            let summaries = try await component.observeSessions.invoke(limit: sessionsPageLimit, offset: 0)
            guard !Task.isCancelled else { return }
            sessions = summaries.map { $0.toSessionRow() }
            loading = false
            hasLoaded = true
            log.info("loaded count=\(sessions.count)")
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            loading = false
            hasLoaded = true
            self.error = "Can't load conversation history."
            log.warn("load-failed code=transport")
        }
    }

    func renameSession(_ sessionId: String, title: String) async {
        do { try await component.renameSession.invoke(sessionId: sessionId, title: title) } catch {
            log.warn("renameSession failed code=transport")
        }
        await refresh()
    }

    /// Returns once durable intent exists; network deletion continues without blocking navigation.
    func deleteSession(_ sessionId: String) async -> Bool {
        guard let coordinator = component.drafts else {
            error = "Conversation couldn't be hidden because local storage is unavailable."
            return false
        }
        do {
            _ = try await coordinator.persistDelete(sessionId: sessionId)
            apply(try await coordinator.restore())
            sessions.removeAll { $0.sessionId == sessionId }
            Task { [component] in try? await component.processDeleteIntent(sessionId: sessionId) }
            return true
        } catch is CancellationError {
            return false
        } catch {
            self.error = "Conversation deletion couldn't be saved."
            return false
        }
    }

    func retryDeletes(includePermanent: Bool = true) async {
        for intent in deleteIntents where includePermanent || intent.failureCode != "permanent" {
            await attemptDelete(intent.sessionId)
        }
    }

    private func attemptDelete(_ sessionId: String) async {
        do { try await component.processDeleteIntent(sessionId: sessionId) } catch is CancellationError {}
        catch { log.warn("delete.retry-failed code=transport") }
    }

    func discardDraft(_ draftId: String) async -> Bool {
        guard let coordinator = component.drafts else {
            error = "Draft couldn't be discarded because local storage is unavailable."
            return false
        }
        do {
            let discarded = (try await coordinator.discard(draftId: draftId)).boolValue
            if !discarded { error = "Draft couldn't be discarded." }
            return discarded
        } catch is CancellationError {
            return false
        } catch {
            self.error = "Draft couldn't be discarded."
            return false
        }
    }

    private func apply(_ snapshot: NativeDraftSnapshot) {
        drafts = snapshot.drafts
        deleteIntents = snapshot.deleteIntents
    }

    deinit {
        loadTask?.cancel()
        draftsTask?.cancel()
        sessionChangesTask?.cancel()
    }
}

func historyEntries(
    sessions: [SessionRow],
    drafts: [NativeDraft],
    deleting: [NativeDeleteIntent],
    matching query: String
) -> [HistoryEntry] {
    let hidden = Set(deleting.map(\.sessionId))
    let draftsBySession = Dictionary(uniqueKeysWithValues: drafts.compactMap { draft in
        draft.sessionId.map { ($0, draft) }
    })
    var entries = sessions.filter { !hidden.contains($0.sessionId) }.map { row in
        HistoryEntry(
            kind: .session(id: row.sessionId, draftId: draftsBySession[row.sessionId]?.id),
            title: row.title,
            lastActiveAt: row.lastActiveAt,
            hasDraft: draftsBySession[row.sessionId] != nil
        )
    }
    let listedSessions = Set(sessions.map(\.sessionId))
    entries += drafts.filter { draft in
        draft.sessionId == nil || (!listedSessions.contains(draft.sessionId!) && !hidden.contains(draft.sessionId!))
    }.map { draft in
        let label = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", maxSplits: 1).first.map { String($0.prefix(60)) }
        return HistoryEntry(
            kind: draft.sessionId.map { .session(id: $0, draftId: draft.id) } ?? .draft(id: draft.id),
            title: label ?? "New draft",
            lastActiveAt: draft.updatedAt,
            hasDraft: true
        )
    }
    entries.sort { $0.lastActiveAt > $1.lastActiveAt }
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? entries : entries.filter {
        $0.title.range(of: trimmed, options: .caseInsensitive) != nil
    }
}

func historySessions(_ sessions: [SessionRow], matching query: String) -> [SessionRow] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return sessions }
    return sessions.filter { $0.title.range(of: trimmed, options: .caseInsensitive) != nil }
}

private extension SessionSummary {
    func toSessionRow() -> SessionRow {
        SessionRow(sessionId: id, rootId: nil, title: title, startedAt: 0,
                   lastActiveAt: updatedAtMs, messageCount: 0, isActive: false)
    }
}

#if DEBUG
extension HistoryViewModel {
    func seedForPreview(_ rows: [SessionRow]) { sessions = rows; hasLoaded = true }
    func seedErrorForPreview(_ message: String, rows: [SessionRow] = []) {
        sessions = rows; error = message; loading = false; hasLoaded = true
    }
}
#endif
