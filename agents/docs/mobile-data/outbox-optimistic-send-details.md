# Outbox & Optimistic Send — Details

The outbox turns "send" into an instant local mutation that heals itself once the socket is ready, and reconciles against the gateway echo by id.

## The FSM (in-memory)

```kotlin
// shared/mobile-data/.../outbox/Outbox.kt
enum class MessageStatus { QUEUED, SENT, FAILED }
data class PendingMessage(val id: String, val text: String, val status: MessageStatus = QUEUED)

class Outbox(private val send: (PendingMessage) -> Unit) {
    private val queue = LinkedHashMap<String, PendingMessage>()   // in-memory only — dies with the process

    fun enqueue(msg: PendingMessage) {
        val existing = queue[msg.id]
        if (existing != null && existing.status != QUEUED) return  // never resurrect a SENT/FAILED id
        queue[msg.id] = msg
    }
    fun onReady()  { queue.values.filter { it.status == QUEUED }.forEach { send(it); queue[it.id] = it.copy(status = SENT) } }
    fun failAll(reason: String) { queue.values.filter { it.status == QUEUED }.forEach { queue[it.id] = it.copy(status = FAILED) } }
    fun retry(id: String) { queue[id]?.takeIf { it.status == FAILED }?.let { queue[id] = it.copy(status = QUEUED) } }
}
```

## The write path in ChatRepository

```kotlin
fun send(text: String): String {                 // returns the pendingId
    val id = newId()
    outbox.enqueue(PendingMessage(id, text))      // optimistic QUEUED bubble, visible immediately
    if (connected) flush()                        // already READY → send now, don't wait for setConnected
    return id
}
fun setConnected(isConnected: Boolean) { connected = isConnected; if (isConnected) flush() }  // flush on READY
fun retry(pendingId: String)  { outbox.retry(pendingId); if (connected) flush() }
fun failOutbox(reason: String) { outbox.failAll(reason) }  // on disconnect; bubbles stay visible for retry
```

## pendingId round-trip (echo reconciliation, NOT server idempotency)

```
client send(text)
  └─ outbox QUEUED  ──flush──▶ sdk.sendText(text, pendingId)  ──▶ gateway
                                                                    │ stamps pendingId onto the
                                                                    │ committed user feed entry
  timeline emits committed user ChatMessage(pendingId = <same>) ◀───┘
  chatStream: visiblePending = pending.filter { it.id !in committedPendingIds }
  └─ optimistic bubble disappears the instant its committed twin arrives (exact id match)
```

The gateway side: `pendingId` is an optional protocol field (`shared/protocol`) threaded through `text.input` → conversation feed → the committed-user echo. Web clients that omit it are unaffected.

## Gotchas

- **Not persistent.** The queue is a `LinkedHashMap` on the session scope. Process death loses unsent messages. Do not document or rely on durable replay; if persistence is needed it is new work (DataStore/SwiftData/file), currently unimplemented.
- **No server replay / idempotency key.** `pendingId` only reconciles the optimistic bubble against the echo. The outbox never re-sends a `SENT` id, so there is no duplicate-suppression contract on the server.
- **Reconcile by id, never by text.** Two identical "ok" messages must both survive; text comparison would collapse them. The exact-id filter is the whole mechanism.
- **Flush is edge- AND level-triggered.** `setConnected(true)` flushes on the READY transition; `send` while already-connected flushes immediately. Missing either path strands a message at `QUEUED` forever (a real bug caught in review).
- Keep `pendingId` stable across `QUEUED → FAILED → retry` — per-message retry depends on it.
