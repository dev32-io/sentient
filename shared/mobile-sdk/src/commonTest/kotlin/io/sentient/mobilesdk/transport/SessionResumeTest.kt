// ---------------------------------------------------------------------------
// SessionResumeTest — ports the resume / stale-resume wire-contract cases from
// web-sdk sdk-reconnect.test.ts. The connect URL IS the wire (gateway reads
// `?session_id=` at WS upgrade), so this is a wire-protocol boundary worth
// pinning per .claude/rules/testing.md.
//
// Differs from the TS port in storage backend only: the KMP SDK persists the
// per-device "current session" pointer through an injected SessionIdStore
// (InMemorySessionIdStore in tests), NOT sessionStorage. Stale-resume timing
// is driven by an injected Clock instead of a real setTimeout.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.transport

import io.sentient.mobilesdk.fakes.FixedClock
import io.sentient.mobilesdk.fakes.InMemorySessionIdStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionResumeTest {
    private val gateway = "wss://example.test/api/v1/ws"

    private fun newResume(clock: FixedClock = FixedClock(0L)): Pair<SessionResume, InMemorySessionIdStore> {
        val store = InMemorySessionIdStore()
        return SessionResume(store, clock) to store
    }

    // ── buildConnectUrl — stored id → ?session_id= ──

    @Test
    fun buildConnectUrl_appends_session_id_when_stored() {
        val (resume, store) = newResume()
        store.set("sess-abc")
        val url = resume.buildConnectUrl(gateway)
        assertTrue(url.contains("session_id=sess-abc"), "url=$url")
        assertTrue(resume.hasPendingResume())
    }

    @Test
    fun buildConnectUrl_omits_session_id_when_no_stored_id() {
        val (resume, _) = newResume()
        val url = resume.buildConnectUrl(gateway)
        assertFalse(url.contains("session_id="), "url=$url")
        assertFalse(resume.hasPendingResume())
    }

    @Test
    fun buildConnectUrl_omits_session_id_when_stored_empty_string() {
        val (resume, store) = newResume()
        store.set("")
        val url = resume.buildConnectUrl(gateway)
        assertFalse(url.contains("session_id="), "url=$url")
        assertFalse(resume.hasPendingResume())
    }

    @Test
    fun buildConnectUrl_preserves_existing_query_params() {
        val (resume, store) = newResume()
        store.set("sess-xyz")
        val url = resume.buildConnectUrl("$gateway?token=abc")
        assertTrue(url.contains("token=abc"), "url=$url")
        assertTrue(url.contains("session_id=sess-xyz"), "url=$url")
    }

    // ── setCurrentSessionId — pointer transitions ──

    @Test
    fun setCurrentSessionId_persists_and_clears_pending_resume() {
        val (resume, store) = newResume()
        store.set("old-id")
        resume.buildConnectUrl(gateway)
        assertTrue(resume.hasPendingResume())

        resume.setCurrentSessionId("new-id")
        assertEquals("new-id", store.get())
        assertFalse(resume.hasPendingResume())
    }

    @Test
    fun setCurrentSessionId_is_noop_for_empty_id() {
        val (resume, store) = newResume()
        store.set("old-id")
        resume.setCurrentSessionId("")
        assertEquals("old-id", store.get())
    }

    // ── stale-resume detection ──

    @Test
    fun onSnapshot_then_check_after_window_clears_stale_id_when_resume_pending() {
        val clock = FixedClock(1_000L)
        val (resume, store) = newResume(clock)
        store.set("stale-id")
        resume.buildConnectUrl(gateway) // arms pendingResume

        resume.onSnapshot() // snapshot with no preceding switched
        clock.advance(STALE_RESUME_CHECK_MS) // window elapses
        resume.checkStaleResume()

        assertNull(store.get())
        assertFalse(resume.hasPendingResume())
    }

    @Test
    fun onSnapshot_does_not_clear_before_window_elapses() {
        val clock = FixedClock(1_000L)
        val (resume, store) = newResume(clock)
        store.set("stale-id")
        resume.buildConnectUrl(gateway)

        resume.onSnapshot()
        clock.advance(STALE_RESUME_CHECK_MS - 1) // still inside the window
        resume.checkStaleResume()

        assertEquals("stale-id", store.get())
        assertTrue(resume.hasPendingResume())
    }

    @Test
    fun switched_before_snapshot_disarms_stale_timer() {
        // Successful resume: gateway sends session.switched BEFORE snapshot.
        val clock = FixedClock(1_000L)
        val (resume, store) = newResume(clock)
        store.set("old-id")
        resume.buildConnectUrl(gateway)

        resume.setCurrentSessionId("resumed-id") // switched clears pendingResume
        resume.onSnapshot() // snapshot sees no pending resume → no arm
        clock.advance(STALE_RESUME_CHECK_MS + 10)
        resume.checkStaleResume()

        assertEquals("resumed-id", store.get())
        assertFalse(resume.hasPendingResume())
    }

    @Test
    fun checkStaleResume_is_noop_when_no_resume_pending() {
        val (resume, store) = newResume()
        store.set("fresh-id")
        // never call buildConnectUrl → pendingResume stays null
        resume.checkStaleResume()
        assertEquals("fresh-id", store.get())
    }
}
