package io.sentient.android.chat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull

/**
 * Pins the ReopenFailed notice state shape (spec §14).
 *
 * The VM's collection + auto-dismiss loop runs on viewModelScope (Android framework),
 * which is not testable in the JVM layer. What IS pinned here:
 *   1. The copy constant carries the spec-prescribed text.
 *   2. ChatUiState can hold/clear the notice field (the state machine shape
 *      the VM folds into is correct — the VM calls .copy(reopenFailedNotice=…)).
 */
class ReopenFailedNoticeTest {

    @Test
    fun `REOPEN_FAILED_NOTICE carries spec-prescribed copy`() {
        assertEquals(
            "Couldn't reopen that chat — started a new one.",
            REOPEN_FAILED_NOTICE,
        )
    }

    @Test
    fun `ChatUiState defaults to no notice`() {
        assertNull(ChatUiState().reopenFailedNotice)
    }

    @Test
    fun `ChatUiState carries notice when set`() {
        val state = ChatUiState(reopenFailedNotice = REOPEN_FAILED_NOTICE)
        assertNotNull(state.reopenFailedNotice)
        assertEquals(REOPEN_FAILED_NOTICE, state.reopenFailedNotice)
    }

    @Test
    fun `copy-clearing notice produces null`() {
        val withNotice = ChatUiState(reopenFailedNotice = REOPEN_FAILED_NOTICE)
        val cleared = withNotice.copy(reopenFailedNotice = null)
        assertNull(cleared.reopenFailedNotice)
    }
}
