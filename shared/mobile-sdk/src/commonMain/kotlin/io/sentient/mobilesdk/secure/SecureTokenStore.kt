// ---------------------------------------------------------------------------
// SecureTokenStore — boundary interface for encrypted credential persistence.
//
// Production implementations use platform keychain / keystore APIs.
// commonTest uses InMemoryTokenStore for deterministic testing.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.secure

/**
 * Persistent, encrypted storage for the session authentication token.
 *
 * Platform implementations: Android Keystore-backed EncryptedSharedPreferences;
 * iOS Keychain. Neither platform type leaks into commonMain.
 *
 * Thread/coroutine safety: implementations MUST be safe to call from any
 * coroutine dispatcher (no UI-thread requirement).
 */
interface SecureTokenStore {
    /** Persists [token] to encrypted storage, overwriting any previous value. */
    fun save(token: String)

    /**
     * Reads the stored token.
     *
     * @return The stored token, or `null` if none has been saved or it was cleared.
     */
    fun load(): String?

    /** Removes the stored token. Subsequent [load] calls return `null`. */
    fun clear()
}
