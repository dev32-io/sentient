// ---------------------------------------------------------------------------
// ChatViewModel — @MainActor bridge from the shared repositories to SwiftUI.
//
// Mirrors the Android ChatViewModel role: collects the ChatRepository chatStream
// (Flow<SentientResult<ChatModel>>) and ConnectionRepository status flow, folds
// SentientResult into @Published ChatUiState and @Published ConnectionState.
//
// Session lifecycle:
//   - init: starts background open() + begins collecting chatStream + connection.
//   - deinit: cancels collection + calls session.close() — the SINGLE close path.
//
// scenePhase presence (mirrors Android PresenceCoordinator cold-start-skip):
//   - onBackground(): session.pause() — drops WS, keeps scope.
//   - onForeground(): session.resume() — re-arms reconnect.
//   - Cold-start skip: the FIRST active transition is skipped because init already
//     called open(). hasBackgrounded tracks whether we have ever actually gone to
//     background — only then do we resume on the next foreground edge.
//
// @MainActor: all @Published mutation on the main actor; SKIE async iteration
// is already actor-safe — the for-await resumes on the calling actor.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class ChatViewModel: ObservableObject {
    /// Single chat UI state snapshot (committed + pending + live + banner).
    @Published private(set) var state = ChatUiState()

    /// Connection state folded from ConnectionRepository.status. Defaults to
    /// DISCONNECTED before the first emission; updated as results arrive.
    @Published private(set) var connection: ConnectionState = makeDisconnectedConnection()

    let session: MobileSession
    private var collectTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    /// Cold-start-skip: true after the first onBackground(). Only once we have
    /// actually backgrounded do we resume on the next foreground edge (mirrors
    /// Android PresenceCoordinator.backgrounded guard). Readable by ChatView for
    /// lifecycle logging (distinguishes cold-start-skip from genuine foreground).
    private(set) var hasBackgrounded = false

    init(session: MobileSession) {
        self.session = session
        log.info("init")
        // Background connect: UI is usable while open() works toward READY.
        Task { try? await session.open() }
        startCollecting()
        startConnectionCollecting()
    }

    // ── Public actions ────────────────────────────────────────────────────────

    /// Enqueue an optimistic send; the outbox shows the bubble immediately.
    func send(_ text: String) {
        log.info("send len=\(text.count)")
        _ = session.chatRepo.send(text: text)
    }

    /// Re-queue a FAILED pending message for retry on next flush.
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        session.chatRepo.retry(pendingId: pendingId)
    }

    // ── scenePhase presence ───────────────────────────────────────────────────

    /// Called when the scene enters background. Drops the WS, keeps scope alive.
    func onBackground() {
        hasBackgrounded = true
        log.info("background — pause")
        session.pause()
    }

    /// Called when the scene enters foreground. Skips on cold start (init already
    /// connected); only resumes after a real background transition.
    func onForeground() {
        guard hasBackgrounded else {
            log.info("foreground.cold-start-skip")
            return
        }
        log.info("foreground — resume")
        session.resume()
    }

    // ── Chat stream collection ────────────────────────────────────────────────

    private func startCollecting() {
        // chatStream is exposed by SKIE as SkieSwiftFlow<SentientResult<ChatModel>>
        // (SKIE wraps the underlying Kotlin Flow at the property boundary).
        // Iterate directly — no manual cast needed.
        collectTask = Task { [weak self] in
            guard let self else { return }
            for await result in session.chatRepo.chatStream {
                self.apply(result)
            }
        }
    }

    private func apply(_ result: SentientResult<ChatModel>) {
        switch onEnum(of: result) {
        case .loading(let l):
            state.isLoading = true
            if let partial = l.partial {
                state.model = partial
            }
            log.debug("apply loading hasPartial=\(l.partial != nil)")
        case .success(let s):
            state = ChatUiState(model: s.data, isLoading: false, banner: nil)
            log.debug("apply success committed=\(s.data.committed.count)")
        case .failure(let f):
            let canRetry: Bool
            switch onEnum(of: f.error.retry) {
            case .none: canRetry = false
            case .internal: canRetry = false
            case .userPrompt: canRetry = true
            }
            state.isLoading = false
            state.banner = ErrorBanner(text: f.error.userMessage, canRetry: canRetry)
            log.warn("apply failure msg=\(f.error.userMessage) canRetry=\(canRetry)")
        }
        log.debug("uiState messages=\(state.model.committed.count) pending=\(state.model.pending.count) live=\(state.model.live != nil) loading=\(state.isLoading) banner=\(state.banner != nil)")
    }

    // ── Connection stream collection ──────────────────────────────────────────

    private func startConnectionCollecting() {
        // connectionRepo.status is exposed by SKIE as a SkieSwiftFlow.
        // Iterate directly — same pattern as chatStream.
        connectionTask = Task { [weak self] in
            guard let self else { return }
            for await result in session.connectionRepo.status {
                self.applyConnection(result)
            }
        }
    }

    private func applyConnection(_ result: SentientResult<ConnectionState>) {
        // Fold Success/Loading→partial to get the current ConnectionState.
        // Failure: for a terminal auth error, set authExpired=true so ChatView's
        // onAuthExpired fires and routes to login. All other failures keep the
        // last-good connection value so the banner path (connectionLost/status) works.
        switch onEnum(of: result) {
        case .success(let s):
            connection = s.data
            log.debug("connection success status=\(s.data.status.name)")
        case .loading(let l):
            if let partial = l.partial { connection = partial }
            log.debug("connection loading hasPartial=\(l.partial != nil)")
        case .failure(let f):
            let isTerminalAuth = f.error.kind == .auth && !f.error.recoverable
            if isTerminalAuth {
                connection = makeAuthExpiredConnection()
                log.warn("connection auth-expired — routing to login")
            } else {
                // Keep last-good connection; the banner derives from connectionLost/status.
                log.debug("connection failure — keeping last-good")
            }
        }
    }

    /// Single teardown path: cancel collection tasks + close session.
    deinit {
        log.info("deinit")
        collectTask?.cancel()
        connectionTask?.cancel()
        session.close()
    }
}
