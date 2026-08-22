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

    /// Talk mode (Idle | Hold | Continuous), owned by the SDK's TalkModeController. Exposed
    /// for the keep-screen-on derivation below (and its reason logging in ChatView).
    @Published private(set) var talkMode: TalkMode = .idle
    @Published private(set) var micLevels: [Float] = Array(repeating: 0, count: 32)

    /// Temporary keep-screen-on condition (S8): `Continuous talk mode OR the assistant is
    /// audibly speaking`. Reuses the EXACT `connection.isSpeaking` signal that drives the
    /// existing speaking visuals (BubbleSpeakingWave) — not a new signal. TTS frames
    /// buffered during a Hold are NOT "speaking" until they actually play after release,
    /// which is the desired semantics here too. Hold itself does not force screen-on: the
    /// user's finger on the screen already keeps it awake.
    ///
    /// Pure derivation — no side effects, no logging — so it stays the testable seam.
    /// ChatView applies `UIApplication.shared.isIdleTimerDisabled` and owns every clear
    /// path (condition-false, view disappearing, scene backgrounding), logging the reason
    /// for each transition there.
    @Published private(set) var keepScreenOn = false

    /// Outstanding L3 permission-confirm prompt (design spec §7.1), or nil. Single
    /// active prompt per session — SessionRuntime blocks the turn on it, so the SDK's
    /// open-prompt list is at most one deep in practice; this holds its head.
    @Published private(set) var pendingPermission: PermissionPrompt?

    private let component: ChatComponent
    /// Per-conversation optimistic outbox. Dies with this VM (conversation switch).
    /// Built via the createOutboundCache() factory: SKIE doesn't synthesise a zero-arg
    /// init() for OutboundCache's all-default Kotlin constructor, so the factory hands
    /// Swift the same system-clock + default-timeout cache Android gets from OutboundCache().
    private let cache = createOutboundCache()

    private var chatTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var talkModeTask: Task<Void, Never>?
    private var micLevelsTask: Task<Void, Never>?
    private var coldReplaceTask: Task<Void, Never>?
    private var sweepTask: Task<Void, Never>?
    private var reopenFailedTask: Task<Void, Never>?
    private var permissionTask: Task<Void, Never>?
    /// Local defensive countdown to a shown prompt's expiresAtMs. Re-armed per prompt;
    /// cancelled on any of: a new prompt replacing it, the server resolving it, or the
    /// user answering it locally.
    private var permissionTimeoutTask: Task<Void, Never>?
    private let log = AppLog("chat", "viewmodel")

    /// Periodic outbox-sweep interval (unacked-timeout detection) in nanoseconds.
    private static let sweepIntervalNs: UInt64 = 1_000_000_000
    /// Auto-dismiss interval for the ReopenFailed notice (spec §14) in nanoseconds.
    private static let reopenFailedAutoDismissNs: UInt64 = 4_000_000_000
    /// Nanoseconds per millisecond, for converting the wire's expiresAtMs into a
    /// Task.sleep(nanoseconds:) duration.
    private static let nsPerMs: UInt64 = 1_000_000

    init(component: ChatComponent, sessionId: String?) {
        self.component = component
        log.info("init sessionId=\(sessionId ?? "<new>")")

        // A null route entry is a cold/new-chat boundary, not an implicit reattach.
        // Explicit preparation is fire-and-forget, so the composer is usable while
        // the gateway prepares the draft/attachment for the first queued message.
        if let sessionId {
            component.switchConversation.invoke(sessionId: sessionId)
        } else {
            component.switchConversation.startFreshChat()
        }

        startChatCollecting()
        startConnectionCollecting()
        startTalkModeCollecting()
        startMicLevelsCollecting()
        startColdReplaceCollecting()
        startPeriodicSweep()
        startReopenFailedCollecting()
        startPermissionCollecting()
    }

    private var isReady: Bool { connection.status == .ready }

    // ── Public actions ────────────────────────────────────────────────────────

    /// Enqueue an optimistic send; the outbox shows the bubble immediately. Flush
    /// now if READY, otherwise it drains on the next rising edge to READY (the
    /// connection collector re-fires flushIfReady on every emission).
    func send(_ text: String) {
        let id = UUID().uuidString
        log.info("send len=\(text.count) pendingId=\(id)")
        cache.enqueue(id: id, text: text)
        if isReady {
            component.sendMessage.flushIfReady(cache: cache, status: connection.status)
        }
    }

    /// Re-queue a FAILED pending message. If transport is down, force a reconnect so
    /// the rising edge to READY drains it; then attempt an immediate ready-gated flush.
    func retry(_ pendingId: String) {
        log.info("retry pendingId=\(pendingId)")
        cache.retry(id: pendingId)
        // Verify the socket rather than trusting a possibly-stale READY: a dead socket
        // after a silent path change still reports READY, so a bare re-send would fail
        // again. ensureConnected() probes (READY→ping→reconnect-if-dead) or reconnects.
        component.ensureConnected()
        component.sendMessage.flushIfReady(cache: cache, status: connection.status)
    }

    // Talk-mode intents (design spec §3) — thin passthroughs to the component. All mode
    // semantics live in the SDK's TalkModeController; the VM never decides anything here.
    // Fire-and-forget: the SDK flips voiceMode optimistically off the resulting talk mode.

    /// Corner mic pressed (idle→hold) — press-to-talk begins.
    func pressMic() {
        log.info("mic.press")
        component.pressMic()
    }

    /// Corner mic released below the lock threshold (hold→idle).
    func releaseMic() {
        log.info("mic.release")
        component.releaseMic()
    }

    /// Corner mic slid to lock (hold→locked) — continuous/hands-free begins.
    func lockMic() {
        log.info("mic.lock")
        component.lockMic()
    }

    /// Locked control released to stop (locked→idle) — hands-free ends.
    func stopContinuous() {
        log.info("mic.stop-continuous")
        component.stopContinuous()
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

    /// Engagement signal from the chat screen: fires on screen appear and on composer
    /// focus. Idempotent — READY → liveness probe; not-READY → reconnect (re-anchors
    /// the conversation via conversation.activate on the next READY edge).
    func ensureConnected() {
        log.debug("ensureConnected")
        component.ensureConnected()
    }

    /// Composer gained keyboard focus — user is about to type; ensure the connection is
    /// live so the first send is not blocked by a stale reconnect race.
    func onComposerFocus() {
        log.debug("onComposerFocus")
        component.ensureConnected()
    }

    /// Tap-to-dismiss the ReopenFailed one-shot notice. Idempotent.
    func dismissReopenFailedNotice() {
        log.debug("reopen-failed.notice.dismissed")
        state.reopenFailedNotice = nil
    }

    /// Local optimistic dismiss — fires immediately on the user's own Allow/Deny tap,
    /// ahead of the `permission.resolved` round trip. Idempotent. Never an approval:
    /// the decision itself travels via `respondPermission`, called from the same tap.
    func dismissPermissionPrompt() {
        guard let current = pendingPermission else { return }
        permissionTimeoutTask?.cancel()
        pendingPermission = PermissionPromptFSM.reduce(
            current: current,
            event: .userResponded(requestId: current.requestId)
        )
    }

    /// Answer an outstanding permission prompt. Sends `permission.response` over the
    /// wire; the dialog itself is dismissed by `dismissPermissionPrompt()`, called
    /// alongside this from the same button tap (see ChatPermissionAlert.permissionPrompt).
    func respondPermission(_ requestId: String, approved: Bool) {
        log.info("permission.response requestId=\(requestId) approved=\(approved)")
        component.respondToPermission(requestId: requestId, approved: approved)
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
        // Reconcile: drop optimistic entries whose committed echo arrived. Driven by the
        // LIVE echo (model.reconciledPendingIds) from the in-memory timeline — NOT
        // model.committed.pendingId (the committed twin may carry it null).
        for id in model.reconciledPendingIds {
            cache.remove(id: id)
        }
        state = ChatUiState(model: model, isLoading: false, historyLoading: model.historyLoading, banner: nil)
        log.debug("chat committed=\(model.committed.count) pending=\(model.pending.count) live=\(model.live != nil) historyLoading=\(model.historyLoading)")
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
        // flushIfReady is a no-op off the READY edge and when nothing is queued —
        // safe + idempotent to fire on every emission. It drains the outbox on the
        // rising edge into READY (reconnect / first-connect).
        component.sendMessage.flushIfReady(cache: cache, status: conn.status)
        // Sweep unacked timeouts on every connection event (idempotent; guarded so we
        // only touch the cache when something is in flight). The cache owns the
        // clock + timeout — we only DRIVE the sweep.
        if !cache.pending.value.isEmpty {
            cache.sweepTimeouts()
        }
        recomputeKeepScreenOn()
    }

    // ── Talk-mode stream collection (S8 keep-screen-on) ───────────────────────

    private func startMicLevelsCollecting() {
        micLevelsTask = Task { [weak self] in
            guard let self else { return }
            for await envelope in self.component.micLevels {
                self.micLevels = envelope.values.map(\.floatValue)
            }
        }
    }

    private func startTalkModeCollecting() {
        talkModeTask = Task { [weak self] in
            guard let self else { return }
            for await mode in self.component.talkMode {
                self.talkMode = mode
                self.recomputeKeepScreenOn()
            }
        }
    }

    /// Pure re-derivation of `keepScreenOn` from the two latest inputs (`talkMode`,
    /// `connection.isSpeaking`). No side effects here — ChatView applies the platform
    /// flag off the published change and owns the transition log.
    private func recomputeKeepScreenOn() {
        keepScreenOn = talkMode == .continuous || connection.isSpeaking
    }

    // ── Periodic unacked-timeout sweep ────────────────────────────────────────

    /// Drive cache.sweepTimeouts() on a ~1s tick so unacked-timeout FAILED transitions
    /// fire even with no connection events. Runs only while pending entries exist;
    /// cancelled in deinit. The cache holds the clock + timeout — we just tick it.
    private func startPeriodicSweep() {
        sweepTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.sweepIntervalNs)
                guard let self else { return }
                if !self.cache.pending.value.isEmpty {
                    self.cache.sweepTimeouts()
                }
            }
        }
    }

    // ── Cold-reconcile (existing-conversation history reload) ─────────────────

    /// An existing-conversation switch reloads authoritative history from REST. That
    /// cold snapshot carries NO pendingId, so reconcile-by-pendingId can't drop a
    /// still-pending optimistic bubble → a duplicate. On the cold-replace signal,
    /// drop every still-present optimistic entry (now in the authoritative history,
    /// or already swept to FAILED by the unacked-timeout).
    private func startColdReplaceCollecting() {
        coldReplaceTask = Task { [weak self] in
            guard let self else { return }
            for await _ in self.component.observeChat.coldHistoryReplaceSignal() {
                self.component.observeChat.onColdHistoryReplace(cache: self.cache)
            }
        }
    }

    // ── ReopenFailed one-shot notice (spec §14) ───────────────────────────────

    /// Collect the one-shot ReopenFailed signal from the component. Each emission
    /// folds a transient notice into published state, then auto-dismisses after 4 s
    /// unless the user already tapped the dismiss button. The VM owns the collection
    /// lifetime so the event is folded into durable state immediately — never dropped
    /// by a lifecycle pause.
    private func startReopenFailedCollecting() {
        reopenFailedTask = Task { [weak self] in
            guard let self else { return }
            for await _ in self.component.reopenFailed {
                self.log.info("reopen-failed.notice.show")
                self.state.reopenFailedNotice = reopenFailedNoticeCopy
                try? await Task.sleep(nanoseconds: Self.reopenFailedAutoDismissNs)
                // Auto-dismiss only if not already cleared by a tap.
                if self.state.reopenFailedNotice != nil {
                    self.log.debug("reopen-failed.notice.auto-dismiss")
                    self.state.reopenFailedNotice = nil
                }
            }
        }
    }

    // ── Permission-prompt stream collection (design spec §7.1) ────────────────

    /// Dedicated collector for the SDK's open-prompt StateFlow — a SEPARATE Task from
    /// every other collector in this file, cancelled in deinit like the rest. The SDK
    /// publishes the whole open list; at most one prompt is live per session (the
    /// SessionRuntime blocks its turn on it), so this VM renders the head.
    private func startPermissionCollecting() {
        permissionTask = Task { [weak self] in
            guard let self else { return }
            for await prompts in self.component.permissions {
                self.applyPermissionPrompts(prompts)
            }
        }
    }

    private func applyPermissionPrompts(_ prompts: [PermissionPrompt]) {
        let current = pendingPermission
        let next = prompts.first
        // Same head as we already show ⇒ this emission was about something further
        // down the list. Returning early keeps the countdown armed and the log
        // un-duplicated.
        guard next?.requestId != current?.requestId else { return }
        permissionTimeoutTask?.cancel()
        if let next {
            pendingPermission = PermissionPromptFSM.reduce(current: current, event: .requested(next))
            // toolName is a fixed MCP-route identifier, not user content. The rendered
            // description and the raw args ARE user content and are never logged.
            log.info("permission.request.shown requestId=\(next.requestId) toolName=\(next.toolName)")
            armLocalTimeoutFallback(for: next)
        } else if let current {
            // The SDK dropped it — permission.resolved arrived (allowed / denied /
            // timeout all clear identically; the outcome itself is server-side
            // bookkeeping, not something this VM branches on).
            log.info("permission.resolved requestId=\(current.requestId)")
            pendingPermission = PermissionPromptFSM.reduce(
                current: current,
                event: .resolved(requestId: current.requestId)
            )
        }
    }

    /// Defensive UI-only fallback: if neither the user's own tap nor the server's
    /// permission.resolved frame clears this prompt by its expiresAtMs, clear it
    /// locally so the dialog can never hang forever on a lost/delayed frame. Never an
    /// approval — nothing is sent to the server from this path, and the gateway has
    /// already fail-closed denied the call by the time this fires.
    private func armLocalTimeoutFallback(for prompt: PermissionPrompt) {
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let remainingMs = max(0, prompt.expiresAtMs - nowMs)
        permissionTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remainingMs) * Self.nsPerMs)
            guard let self, !Task.isCancelled else { return }
            let wasShowing = self.pendingPermission?.requestId == prompt.requestId
            self.pendingPermission = PermissionPromptFSM.reduce(
                current: self.pendingPermission,
                event: .localTimeoutFired(requestId: prompt.requestId)
            )
            if wasShowing {
                self.log.warn("permission.prompt.cleared requestId=\(prompt.requestId) reason=local-timeout-fallback")
            }
        }
    }

    /// Single teardown path for THIS VM: cancel collection tasks ONLY. The SDK /
    /// socket are owned by UserSession and MUST survive a conversation switch.
    deinit {
        chatTask?.cancel()
        connectionTask?.cancel()
        talkModeTask?.cancel()
        micLevelsTask?.cancel()
        coldReplaceTask?.cancel()
        sweepTask?.cancel()
        reopenFailedTask?.cancel()
        permissionTask?.cancel()
        permissionTimeoutTask?.cancel()
    }
}
