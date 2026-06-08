// ---------------------------------------------------------------------------
// MobileSession — chat-scoped session: SDK + repositories on a coroutine scope.
//
// Centralises the wiring that was previously duplicated between Android and iOS:
//   - ChatRepository (events/timeline/send/newId)
//   - ConnectionRepository (connection StateFlow)
//   - HistoryRepository (listSessions fetch)
//   - outbox-flush collector (setConnected on READY)
//   - open/close/pause/resume lifecycle ops
//
// Android builds this via SdkSessionFactory (which constructs config+bundle+sdk
// then delegates here). iOS builds this via createMobileSession() in iosMain.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.session

import io.sentient.mobiledata.repository.ChatRepository
import io.sentient.mobiledata.repository.ConnectionRepository
import io.sentient.mobiledata.repository.HistoryRepository
import io.sentient.mobiledata.repository.SessionRowData
import io.sentient.mobilesdk.sdk.SentientSdk
import io.sentient.mobilesdk.transport.SdkStatus
import io.sentient.mobilesdk.util.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlin.random.Random
import kotlin.time.Clock as KtClock

/** Page size for the session list fetch. Matches Android's HISTORY_PAGE_LIMIT (50). */
private const val DEFAULT_HISTORY_PAGE_LIMIT = 50

/**
 * A single chat screen's SDK session: SDK + repositories on a per-session scope.
 *
 * Shared by Android and iOS so the wiring lives in one place. Platform-specific
 * factories (SdkSessionFactory on Android; createMobileSession on iOS) construct
 * the [SentientSdk] and [CoroutineScope] and hand them in here.
 *
 * Lifecycle:
 *   open()  — suspends until READY; call in background from the platform VM/init.
 *   close() — screen-exit teardown; drops WS and cancels [scope].
 *   pause() — background entry; drops WS but keeps scope alive for resume.
 *   resume() — foreground entry; re-arms reconnect loop.
 */
class MobileSession(
    val sdk: SentientSdk,
    private val scope: CoroutineScope,
    private val historyPageLimit: Int = DEFAULT_HISTORY_PAGE_LIMIT,
    clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
) {
    val chatRepo: ChatRepository = ChatRepository(
        events = sdk.events,
        timeline = sdk.timeline,
        scope = scope,
        send = { text, pendingId -> sdk.sendText(text, pendingId) },
        newId = { Random.nextLong().toString(16) },
        clock = clock,
    )

    val connectionRepo: ConnectionRepository = ConnectionRepository(connection = sdk.connection)

    val historyRepo: HistoryRepository = HistoryRepository(fetch = {
        val page = sdk.listSessions(limit = historyPageLimit, offset = 0)
        page.items.map { row ->
            SessionRowData(
                id = row.sessionId,
                title = row.title,
                updatedAtMs = row.lastActiveAt,
            )
        }
    })

    init {
        // Forward every connection-state emission to chatRepo so setConnected
        // flushes the outbox on READY and clears it on disconnect.
        scope.launch {
            sdk.connection.collect { chatRepo.setConnected(it.status == SdkStatus.READY) }
        }
    }

    /** Open the WS, authenticate, configure, reach READY. Suspends until settled. */
    suspend fun open() { sdk.connect() }

    /**
     * Background-entry disconnect: drops the WS to save battery/radio but keeps
     * the coroutine scope + session alive so [resume] can reconnect via session-resume
     * on foreground. Does NOT cancel the scope — only [close] does that.
     */
    fun pause() { sdk.disconnect(clearSession = false) }

    /**
     * Foreground-entry reconnect: re-arms the reconnect controller and drives a
     * fresh recovery loop. Idempotent — a no-op while a reconnect loop is already
     * in flight.
     */
    fun resume() { sdk.forceReconnect() }

    /**
     * Screen-exit teardown: disconnect + cancel scope. Full lifecycle end.
     * clearSession=false keeps the session pointer so re-entry can resume.
     */
    fun close() {
        sdk.disconnect(clearSession = false)
        scope.cancel()
    }
}
