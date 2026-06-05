// ---------------------------------------------------------------------------
// SdkStore+Sessions — session-management passthroughs.
//
// Async passthroughs to the SDK's SessionsConnector surface (SKIE bridges the
// Kotlin `suspend` funcs to Swift `async throws`; `newChat` is exposed as
// `doNewChat`). The HistoryModel awaits these and re-queries `listSessions`
// after each mutation — the SDK does NOT surface onSessionsChanged through
// SentientSdk, so the open + post-mutation re-query is the refresh path.
// ---------------------------------------------------------------------------
import MobileSdk

extension SdkStore {
    /// Page the session list. Returns a SessionsListPage (items + total + hasMore).
    func listSessions(limit: Int32, offset: Int32) async throws -> SessionsListPage {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("listSessions limit=\(limit) offset=\(offset)")
        return try await sdk.listSessions(limit: limit, offset: offset)
    }

    /// Switch to a session; awaits the session.switched broadcast inside the SDK.
    func switchSession(_ sessionId: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("switchSession sessionId=\(sessionId)")
        try await sdk.switchSession(sessionId: sessionId)
    }

    /// Start a fresh chat; awaits the session.created broadcast inside the SDK.
    func newChat() async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("newChat")
        try await sdk.doNewChat()
    }

    func deleteSession(_ id: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("deleteSession id=\(id)")
        try await sdk.deleteSession(id: id)
    }

    func renameSession(_ id: String, title: String) async throws {
        guard let sdk else { throw SdkStoreError.notConfigured }
        log.info("renameSession id=\(id)")
        try await sdk.renameSession(id: id, title: title)
    }
}
