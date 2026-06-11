// ---------------------------------------------------------------------------
// ResumeCursorStore — DURABLE persistence boundary for the in-memory [ResumeCursor].
//
// The SDK's ResumeCursor is in-memory: it dies with the process. This store persists
// it so that an IN-PROCESS reconnect (a drop/foreground probe where the conversation
// is ALREADY anchored — spec §6) can `stream.resume` on recovered:true within the
// gateway's replay-buffer TTL instead of recovered:false + full REST refetch. The
// orchestrator SEEDS the cursor from this store on resume-prep, PERSISTS the snapshot
// when the cursor advances, and CLEARS it on a non-recovered reset / conversation delete.
//
// SCOPE — NOT cold-relaunch yet: on a COLD app relaunch the SDK does NOT restore its
// session anchor on launch (the anchor is set only from a server frame), so the
// FIRST connect after launch has a null anchor and the seed cannot fire — the cursor
// stays fresh and the relaunch takes the recovered:false REST path. Surviving an app
// kill is a FOLLOW-UP (restore the SDK session anchor on launch, THEN seed). Today's
// guarantee is the in-process reconnect, which is what spec §6 frames.
//
// DEPENDENCY INVERSION: the SDK (commonMain, lowest layer) DEFINES this interface so a
// higher layer could supply a durable backing without the SDK depending on it. There is
// NO durable implementation today — mobile-data keeps the chat timeline in-memory, so it
// injects nothing and the orchestrator defaults to [NoOpResumeCursorStore]. The store is
// OPTIONAL on the orchestrator, so construction (and tests) never break; the seed/save/
// clear hooks stay unconditional and simply no-op against the default.
//
// Single-threaded contract: the orchestrator drives load/save/clear from the WS pump
// dispatcher, mirroring ResumeCursor. Implementations MUST NOT block (a quick
// key-value read/write); heavy I/O is the implementation's problem, not the caller's.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

/**
 * Durable per-conversation persistence for the resume cursor's [CursorSnapshot].
 * Keyed by the conversation id (the SDK's `currentSessionId`).
 */
interface ResumeCursorStore {
    /** The persisted snapshot for [conversationId], or null if none stored / cleared. */
    fun load(conversationId: String): CursorSnapshot?

    /** Persist [snapshot] for [conversationId], overwriting any prior value. */
    fun save(conversationId: String, snapshot: CursorSnapshot)

    /** Remove the stored snapshot for [conversationId] (non-recovered reset / delete). */
    fun clear(conversationId: String)
}

/**
 * Default no-op store: load returns null, save/clear are no-ops. Lets the SDK be
 * constructed without a durable backing (tests, or a platform that opts out) while
 * the seed/save/clear hooks stay unconditional in the orchestrator.
 */
object NoOpResumeCursorStore : ResumeCursorStore {
    override fun load(conversationId: String): CursorSnapshot? = null
    override fun save(conversationId: String, snapshot: CursorSnapshot) {}
    override fun clear(conversationId: String) {}
}
