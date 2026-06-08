// ---------------------------------------------------------------------------
// ChatViewModel — thin per-conversation state holder over the shared usecase
// layer (ChatComponent). Swift mirror of Android's ChatViewModel.
//
// Takes the User/Connection-scoped ChatComponent + the route's sessionId (null =
// new chat). On init it switches the active conversation to sessionId, then folds
// observeChat(cache.pending) → @Published ChatUiState. The optimistic outbox
// (OutboundCache) is per-conversation: it lives and dies with this VM, so
// switching conversation = a fresh route-keyed VM = clean state.
//
// Lifecycle (open / close / pause / resume) is owned by UserSession, NOT here — a
// VM teardown on conversation switch must NEVER disconnect the SDK. deinit only
// cancels this VM's collection tasks.
//
// Flush gate (web-sdk / Android parity): queued sends drain on the rising edge to
// READY; a send while already-READY flushes immediately. Reconcile-by-pendingId
// drops the optimistic copy once its committed echo arrives.
//
// SKIE bridges Kotlin Flows as AsyncSequence (for await) and usecases'
// `operator fun invoke` as `.invoke(...)`. @MainActor: all @Published mutation on
// the main actor; the for-await resumes on the calling actor.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class ChatViewModel: ObservableObject {
    /// Single chat UI state snapshot (committed + pending + live + banner).
    @Published private(set) var state = ChatUiState()

    /// Transport + voice axis. Drives the connection banner + composer state.
    @Published private(set) var connection: ConnectionState = makeDisconnectedConnection()

    private let component: ChatComponent
    /// Per-conversation optimistic outbox. Dies with this VM (conversation switch).
    private let cache = OutboundCache()

    private var chatTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    init(component: ChatComponent, sessionId: String?) {
        self.component = component
        log.info("init sessionId=\(sessionId ?? "<new>")")

        // Make the route's conversation active (null = new chat). The flush gate +
        // observeChat collect below pick up whatever conversation this resolves to.
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await self.component.switchConversation.invoke(sessionId: sessionId) } catch {
                self.log.warn("switch-failed reason=\(error.localizedDescription)")
            }
        }

        startChatCollecting()
        startConnectionCollecting()
    }

    private var isReady: Bool { connection.status == .ready }

    // ── Public actions ────────────────────────────────────────────────────────

    /// Enqueue an optimistic send; the outbox shows the bubble immediately. Flush
    /// now if READY, otherwise it drains on the next rising edge to READY.
    func send(_ text: String) {
        let id = UUID().uuidString
        log.info("send len=\(text.count) pendingId=\(id)")
        cache.enqueue(id: id, text: text)
        if isReady { flush() }
    }

    /// Re-queue a FAILED pending message; flush now if READY.
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        cache.retry(id: pendingId)
        if isReady { flush() }
    }

    /// Toggle the voice uplink (mic on/off) through the component passthroughs.
    func toggleMic() {
        if connection.voiceMode == .active {
            component.stopMic()
        } else {
            component.startMic()
        }
    }

    /// Toggle TTS through the component passthrough (gateway echoes via prefs).
    func toggleTts() {
        Task { [weak self] in
            guard let self else { return }
            let next = !self.connection.prefs.ttsEnabled
            try? await self.component.setTtsEnabled(enabled: next)
        }
    }

    /// UI Stop — idempotent hard interrupt of the active cycle + audio.
    func interrupt() {
        component.interrupt()
    }

    /// Manual reconnect — re-arm the reconnect controller and drive recovery.
    func reconnect() {
        component.forceReconnect()
    }

    // ── Flush ───────────────────────────────────────────────────────────────────

    /// Drain still-QUEUED entries: send each, mark SENT (echo reconciles by id).
    private func flush() {
        for m in cache.queued() {
            component.sendMessage.invoke(text: m.text, pendingId: m.id)
            cache.markSent(id: m.id)
        }
    }

    // ── Chat stream collection ────────────────────────────────────────────────

    private func startChatCollecting() {
        // observeChat.invoke(pending:) takes a SkieSwiftFlow; cache.pending is a
        // SkieSwiftStateFlow (a hot variant), so wrap it in SkieSwiftFlow(_:) — SKIE
        // exposes that convenience upcast. The result is a SkieSwiftFlow<ChatModel>
        // (AsyncSequence) iterated directly.
        let pendingFlow = SkieSwiftFlow(cache.pending)
        chatTask = Task { [weak self] in
            guard let self else { return }
            for await model in self.component.observeChat.invoke(pending: pendingFlow) {
                self.applyChat(model)
            }
        }
    }

    private func applyChat(_ model: ChatModel) {
        // Reconcile: drop optimistic entries whose committed echo arrived.
        for id in model.committed.compactMap({ $0.pendingId }) {
            cache.remove(id: id)
        }
        state = ChatUiState(model: model, isLoading: false, banner: nil)
        log.debug("chat committed=\(model.committed.count) pending=\(model.pending.count) live=\(model.live != nil)")
    }

    // ── Connection stream collection + flush-on-READY ─────────────────────────

    private func startConnectionCollecting() {
        // connection.state is a SkieSwiftFlow<ConnectionState>. Folds the latest
        // value into @Published connection and flushes the outbox on READY.
        connectionTask = Task { [weak self] in
            guard let self else { return }
            for await conn in self.component.connection.state {
                self.applyConnection(conn)
            }
        }
    }

    private func applyConnection(_ conn: ConnectionState) {
        connection = conn
        log.debug("connection status=\(conn.status.name)")
        if conn.status == .ready { flush() }
    }

    /// Single teardown path for THIS VM: cancel collection tasks ONLY. The SDK /
    /// socket are owned by UserSession and MUST survive a conversation switch.
    deinit {
        chatTask?.cancel()
        connectionTask?.cancel()
    }
}
