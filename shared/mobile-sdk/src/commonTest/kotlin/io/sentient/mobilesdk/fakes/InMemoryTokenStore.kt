// ---------------------------------------------------------------------------
// InMemoryTokenStore — SecureTokenStore test double backed by a simple var.
//
// No encryption, no platform dependency. Lets commonTest drive auth-token
// scenarios (missing token, saved token, cleared token) deterministically.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.secure.SecureTokenStore

/**
 * In-memory [SecureTokenStore] double for use in commonTest.
 *
 * Thread safety: not thread-safe — use from a single coroutine/thread in tests.
 */
class InMemoryTokenStore : SecureTokenStore {

    private var stored: String? = null

    override fun save(token: String) {
        stored = token
    }

    override fun load(): String? = stored

    override fun clear() {
        stored = null
    }
}
