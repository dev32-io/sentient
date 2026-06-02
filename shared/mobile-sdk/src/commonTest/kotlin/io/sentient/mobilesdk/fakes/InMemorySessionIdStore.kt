// ---------------------------------------------------------------------------
// InMemorySessionIdStore — SessionIdStore test double backed by a simple var.
//
// Lets C2 transport and orchestrator tests drive session-resume scenarios
// (no prior session, existing session ID, cleared on disconnect) without
// any platform or persistence dependency.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.fakes

import io.sentient.mobilesdk.secure.SessionIdStore

/**
 * In-memory [SessionIdStore] double for use in commonTest.
 *
 * Thread safety: not thread-safe — use from a single coroutine/thread in tests.
 */
class InMemorySessionIdStore : SessionIdStore {

    private var stored: String? = null

    override fun get(): String? = stored

    override fun set(id: String) {
        stored = id
    }

    override fun clear() {
        stored = null
    }
}
