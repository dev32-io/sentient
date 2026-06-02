// ---------------------------------------------------------------------------
// SessionIdStore — boundary interface for session-resume ID persistence.
//
// Stores the last-known gateway session ID so the transport layer can
// attempt a session-resume handshake on reconnect (C2 transport pattern).
//
// Intentionally co-located with SecureTokenStore: both are small KV
// persistence boundaries that the transport / orchestrator layers inject.
// Unlike SecureTokenStore the session ID is not a credential — it is
// ephemeral enough that plain (non-encrypted) storage is acceptable,
// though platform implementations may reuse the same encrypted store.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

/**
 * Persistent storage for the WebSocket session resume ID.
 *
 * The transport layer (C2) reads this on connect to include in the auth
 * frame for session continuation. It writes the ID on session.ready and
 * clears it on intentional disconnect or session expiry.
 */
interface SessionIdStore {
    /**
     * Returns the persisted session ID, or `null` if none is stored.
     */
    fun get(): String?

    /**
     * Persists [id], overwriting any previous value.
     */
    fun set(id: String)

    /**
     * Removes the stored session ID. Subsequent [get] calls return `null`.
     */
    fun clear()
}
