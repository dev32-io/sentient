# Outbox & Optimistic Send — Details

The outbox turns "send" into an instant local mutation that heals itself once the socket is ready, and reconciles against the gateway echo by id.

## The FSM (in-memory)

There is NO `SENT` state and NO `flushed` guard. The visible states are `QUEUED` and `FAILED`; `sentAtMs` is an internal timestamp used only by the unacked-timeout sweep.

```kotlin
// shared/mobile-data/.../outbox/Outbox.kt + OutboundCache.kt
enum class MessageStatus { QUEUED, FAILED }
data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
    val sentAtMs: Long? = null,   // set by markSent via injected Clock; null until sent; cleared on retry
)

class OutboundCache(
    private val clock: Clock = Clock { KtClock.System.now().toEpochMilliseconds() },
    private val unackedTimeoutMs: Long = DEFAULT_UNACKED_TIMEOUT_MS,   // default 10 s
) {
    // All QUEUED entries — resendable on reconnect (gateway dedups by pendingId)
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == QUEUED }
    fun markSent(id: String) = ...        // records sentAtMs via clock; entry stays QUEUED
    fun markFailed(id: String) = ...      // any QUEUED entry (sent or unsent) → FAILED
    fun failAll() = ...                   // fail all QUEUED entries (disconnect path)
    fun sweepTimeouts() = ...             // QUEUED && sentAtMs > unackedTimeoutMs → FAILED
    fun retry(id: String) = ...           // FAILED → QUEUED, sentAtMs = null
    fun remove(id: String) = ...          // drop on committed echo
}
```

**FSM transitions:**
- `enqueue` → QUEUED (no-op if id already exists — QUEUED or FAILED; no resurrection)
- `markSent` → sentAtMs set, stays QUEUED; still visible; echo removes it
- `markFailed` → FAILED for any QUEUED entry, whether sent or unsent (resend is safe — gateway dedups)
- `sweepTimeouts` → FAILED for any QUEUED entry whose sentAtMs is older than `unackedTimeoutMs`; prevents forever-"Sending" after an unacked send
- `retry` → QUEUED, sentAtMs cleared; next flush re-sends
- `remove` (echo reconcile) → dropped

## The write path in ChatRepository / ChatViewModel

```kotlin
fun send(text: String): String {                    // returns the pendingId
    val id = newId()
    cache.enqueue(id, text)                         // optimistic QUEUED bubble, visible immediately
    if (isReady) flush()                            // already READY → send now, don't wait for setConnected
    return id
}
// On connection READY: flush all QUEUED entries (sent or unsent — gateway dedups)
fun onReady() { flush() }
fun retry(pendingId: String) { cache.retry(pendingId); if (isReady) flush() }
fun failOutbox(reason: String) {                    // on disconnect; bubbles stay visible for retry
    cache.queued().map { it.id }.forEach { cache.markFailed(it) }
    // Any QUEUED entry (sent or unsent) is failed — a reconnect re-send is safe (gateway dedups by pendingId)
}
// Periodic or connection-event driven sweep:
fun onTick() { cache.sweepTimeouts() }
```

## pendingId round-trip (echo reconciliation, NOT server idempotency)

```
client send(text)
  └─ outbox QUEUED  ──flush──▶ sdk.sendText(text, pendingId)  ──▶ gateway
                                                                    │ stamps pendingId onto the
                                                                    │ committed user feed entry
  LIVE timeline emits committed ChatMessage(pendingId = <same>) ◀───┘
  ChatModel.reconciledPendingIds accumulates echoed ids from the LIVE stream
  └─ VM calls cache.remove(id) for each newly reconciled id (idempotent)
  └─ optimistic bubble disappears the instant its committed twin arrives (exact id match)
```

The gateway side: `pendingId` is an optional protocol field (`shared/protocol`) threaded through `text.input` → conversation feed → the committed-user echo. Web clients that omit it are unaffected.

**Slice-4 gotcha:** The DB mirror strips `pendingId` before persisting (it is a transient client field). Reconcile therefore uses `reconciledPendingIds` accumulated from the LIVE `conversation.snapshot` / `conversation.append` echo — NOT the pendingId-stripping DB timeline. `ChatModel.reconciledPendingIds` is an accumulating set; `cache.remove` is idempotent, so duplicate echoes are harmless.

## Gotchas

- **Not persistent.** The queue is a `LinkedHashMap` on the session scope. Process death loses unsent messages. Do not document or rely on durable replay; if persistence is needed it is new work (DataStore/SwiftData/file), currently unimplemented.
- **No SENT state, no flushed guard.** `sentAtMs` records when an entry was handed to the transport, but it does NOT gate re-sends. On reconnect, ALL QUEUED entries (including sent-but-unechoed ones) are re-sent. The gateway dedups by `pendingId` — no double-dispatch results. `pendingId` only reconciles the optimistic bubble against the echo; there is no duplicate-suppression contract at the send site.
- **Reconnect re-sends are safe because the gateway dedups.** Previously a `flushed` guard blocked reconnect re-sends; that guard is gone. If you see a message sent twice, the bug is missing gateway `pendingId` dedup, not a missing client guard.
- **sweepTimeouts prevents forever-"Sending".** If a sent entry never gets an echo (e.g. the socket drops silently after send, before the echo), `sweepTimeouts` moves it to FAILED after `unackedTimeoutMs` (default 10 s). Call it periodically or on connection events from the VM.
- **Reconcile by id, never by text.** Two identical "ok" messages must both survive; text comparison would collapse them. The exact-id filter is the whole mechanism.
- **Flush is edge- AND level-triggered.** `onReady` flushes on the READY transition; `send` while already-connected flushes immediately. Missing either path strands a message at `QUEUED` forever (a real bug caught in review). Flush also requires the conversation id to be attached — the gate checks both.
- Keep `pendingId` stable across `QUEUED → FAILED → retry` — per-message retry depends on it.
