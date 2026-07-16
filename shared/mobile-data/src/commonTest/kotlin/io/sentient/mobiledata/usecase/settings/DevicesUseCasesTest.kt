// ---------------------------------------------------------------------------
// DevicesUseCasesTest — pins the link-status poll loop invariant: it polls on the
// injected delay and STOPS on a terminal state (linked / error), never spinning
// past it. Injected delay = virtual time; no real sleeps.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeDevicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.settings.SignalLinkStatusResponse
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DevicesUseCasesTest {

    private fun status(state: String, error: String? = null) =
        SentientResult.Success(SignalLinkStatusResponse(state = state, error = error))

    @Test
    fun `poll stops when linked`() = runTest {
        val repo = FakeDevicesRepository(
            statuses = listOf(status("idle"), status("qr-scanned"), status("linked")),
        )
        val out = DevicesUseCases(repo) {}.pollLinkStatus(intervalMs = 1_000).toList()

        assertEquals(3, out.size)
        assertEquals("linked", (out.last() as SentientResult.Success).data.state)
        assertEquals(3, repo.statusCalls, "must not poll past the terminal state")
    }

    @Test
    fun `poll stops when coordinator reports an error`() = runTest {
        val repo = FakeDevicesRepository(statuses = listOf(status("idle"), status("failed", error = "timeout")))
        val out = DevicesUseCases(repo) {}.pollLinkStatus(intervalMs = 1_000).toList()

        assertEquals(2, out.size)
        assertTrue(isTerminalLinkState((out.last() as SentientResult.Success).data))
    }

    @Test
    fun `terminal-state detector`() {
        assertTrue(isTerminalLinkState(SignalLinkStatusResponse(state = "linked")))
        assertTrue(isTerminalLinkState(SignalLinkStatusResponse(state = "idle", error = "boom")))
        assertTrue(!isTerminalLinkState(SignalLinkStatusResponse(state = "idle")))
    }
}
