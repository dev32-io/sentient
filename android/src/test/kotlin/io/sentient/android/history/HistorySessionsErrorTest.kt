package io.sentient.android.history

import io.sentient.mobilesdk.protocol.SessionRow
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pins the sessions-error affordance derivations on HistoryUiState (parity with
 * iOS HistorySidePanel.showsErrorEmpty / showsStaleBanner). Empty-error replaces
 * the list with a Retry; stale-error sits above still-rendered rows.
 */
class HistorySessionsErrorTest {
    private fun row(id: String, title: String) = SessionRow(
        sessionId = id,
        title = title,
        startedAt = 0L,
        lastActiveAt = 0L,
        messageCount = 0,
        isActive = false,
    )

    @Test fun `error with no rows and not loading shows empty-error`() {
        val s = HistoryUiState(sessions = emptyList(), error = "boom", loading = false)
        assertTrue(s.showsErrorEmpty)
        assertFalse(s.showsStaleBanner)
    }

    @Test fun `error while still loading suppresses empty-error`() {
        // The in-flight spinner case isn't pre-empted by a stale error.
        val s = HistoryUiState(sessions = emptyList(), error = "boom", loading = true)
        assertFalse(s.showsErrorEmpty)
    }

    @Test fun `error with rows present shows stale banner not empty-error`() {
        val s = HistoryUiState(sessions = listOf(row("a", "Chat A")), error = "boom")
        assertTrue(s.showsStaleBanner)
        assertFalse(s.showsErrorEmpty)
    }

    @Test fun `no error shows neither affordance`() {
        val s = HistoryUiState(sessions = listOf(row("a", "Chat A")), error = null)
        assertFalse(s.showsErrorEmpty)
        assertFalse(s.showsStaleBanner)
    }

    @Test fun `error with rows hidden by search filter shows empty-error`() {
        // `visible` (post-filter) is empty even though raw sessions is non-empty,
        // so the error surface mirrors what the user actually sees.
        val s = HistoryUiState(
            sessions = listOf(row("a", "Chat A")),
            query = "zzz",
            error = "boom",
            loading = false,
        )
        assertTrue(s.visible.isEmpty())
        assertTrue(s.showsErrorEmpty)
        assertFalse(s.showsStaleBanner)
    }
}
