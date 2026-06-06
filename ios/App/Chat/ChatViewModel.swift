// ---------------------------------------------------------------------------
// ChatViewModel — @MainActor bridge from the shared ChatRepository to SwiftUI.
//
// Mirrors the Android ChatViewModel role: collects the shared ChatRepository
// chatStream (Flow<SentientResult<ChatModel>>) via SKIE's Flow→AsyncSequence
// bridge, folds SentientResult into @Published ChatUiState (graceful
// degradation: last-good model + error banner on Failure), and exposes
// send + per-message retry.
//
// Session lifecycle:
//   - init: starts background open() + begins collecting chatStream.
//   - deinit: cancels collection task (session close is owned by the caller).
//
// @MainActor: all @Published mutation on the main actor; SKIE async iteration
// is already actor-safe — the for-await resumes on the calling actor.
// ---------------------------------------------------------------------------
import Foundation
import MobileData

@MainActor
final class ChatViewModel: ObservableObject {
    /// Single UI state snapshot; SwiftUI renders this directly.
    @Published private(set) var state = ChatUiState()

    private let session: MobileSession
    private var collectTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    init(session: MobileSession) {
        self.session = session
        log.info("init")
        // Background connect: UI is usable while open() works toward READY.
        Task { try? await session.open() }
        startCollecting()
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

    // ── Collection ────────────────────────────────────────────────────────────

    private func startCollecting() {
        // chatStream is a raw Kotlinx_coroutines_coreFlow on the ObjC boundary.
        // SKIE cannot fully bridge it because ChatRepository's constructor takes
        // lambda args, so we cast to SkieKotlinFlow and wrap in SkieSwiftFlow
        // (the same bridge pattern SKIE uses internally for StateFlow/SharedFlow).
        let kotlinFlow = session.chatRepo.chatStream as! SkieKotlinFlow<SentientResult<ChatModel>>
        let swiftFlow = SkieSwiftFlow<SentientResult<ChatModel>>(kotlinFlow)
        collectTask = Task { [weak self] in
            guard let self else { return }
            for await result in swiftFlow {
                self.apply(result)
            }
        }
    }

    // ── State folding ─────────────────────────────────────────────────────────

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
    }

    deinit { collectTask?.cancel() }
}
