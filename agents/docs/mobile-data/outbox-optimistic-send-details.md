# Outbox & Optimistic Send — Details

The outbox turns "send" into an instant local mutation that heals itself once the socket is ready, and reconciles against the gateway echo by id.

## The FSM (in-memory)

There is NO `SENT` state. The visible states are `QUEUED` and `FAILED`; `flushed` is an internal guard on the entry.

```kotlin
// shared/mobile-data/.../outbox/OutboundCache.kt
enum class MessageStatus { QUEUED, FAILED }
data class PendingMessage(
    val id: String,
    val text: String,
    val status: MessageStatus = MessageStatus.QUEUED,
    val flushed: Boolean = false,   // set when handed to the transport; cleared on retry
)

class OutboundCache {
    // QUEUED: awaiting flush or awaiting committed echo (if flushed=true)
    // FAILED: disconnect before flush — safe to retry (flushed=false guaranteed)
    fun queued(): List<PendingMessage> = queue.values.filter { it.status == QUEUED && !it.flushed }
    fun markFlushed(id: String) = ...     // sets flushed=true; entry stays QUEUED for display
    fun markFailed(id: String) = ...      // QUEUED && !flushed → FAILED; flushed entries are untouched
    fun retry(id: String) = ...           // FAILED → QUEUED, flushed=false
    fun remove(id: String) = ...          // drop on committed echo
}
```

**FSM transitions:**
- `enqueue` → QUEUED (ignored if already flushed or FAILED)
- `markFlushed` → QUEUED (flushed=true); still visible; echo removes it
- `markFailed` → FAILED **only if** QUEUED **and** !flushed; a flushed entry stays QUEUED (it may already be committed at the gateway — marking it FAILED risks a double-send on retry)
- `retry` → QUEUED (flushed=false); next flush re-sends
- `remove` (echo reconcile) → dropped

## The write path in ChatRepository

```kotlin
fun send(text: String): String {                    // returns the pendingId
    val id = newId()
    cache.enqueue(id, text)                         // optimistic QUEUED bubble, visible immediately
    if (connected) flush()                          // already READY → send now, don't wait for setConnected
    return id
}
fun setConnected(isConnected: Boolean) { connected = isConnected; if (isConnected) flush() }  // flush on READY
fun retry(pendingId: String)  { cache.retry(pendingId); if (connected) flush() }
fun failOutbox(reason: String) {                    // on disconnect; bubbles stay visible for retry
    cache.queued().map { it.id }.forEach { cache.markFailed(it) }
    // Note: flushed (in-flight) entries are not failed — markFailed no-ops on them.
}
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
- **No SENT state.** The `flushed` guard (not a status) marks an entry as handed to the transport. A flushed entry stays QUEUED for display and is never re-sent (guarded by `markFailed` no-op + `queued()` filter). `pendingId` only reconciles the optimistic bubble against the echo — there is no duplicate-suppression contract on the server.
- **Reconcile by id, never by text.** Two identical "ok" messages must both survive; text comparison would collapse them. The exact-id filter is the whole mechanism.
- **Flush is edge- AND level-triggered.** `setConnected(true)` flushes on the READY transition; `send` while already-connected flushes immediately. Missing either path strands a message at `QUEUED` forever (a real bug caught in review).
- Keep `pendingId` stable across `QUEUED → FAILED → retry` — per-message retry depends on it.
