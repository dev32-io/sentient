// ---------------------------------------------------------------------------
// DevicesUseCasesTest — pins the link-status poll loop invariant: it polls on the
// injected delay and STOPS on a terminal state (linked / error), never spinning
// past it. Injected delay = virtual time; no real sleeps.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.usecase.settings

import io.sentient.mobiledata.data.settings.FakeDevicesRepository
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobilesdk.result.SentientError
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
    fun `transient failure keeps polling then terminal success stops`() = runTest {
        val transient = SentientResult.Failure(SentientError.Connection("offline"))
        val repo = FakeDevicesRepository(statuses = listOf(transient, transient, status("linked")))
        val out = DevicesUseCases(repo) {}.pollLinkStatus(intervalMs = 1_000).toList()

        assertEquals(3, out.size, "transient failures must not stop the poll")
        assertTrue(out[0] is SentientResult.Failure)
        assertTrue(out[1] is SentientResult.Failure)
        assertEquals("linked", (out.last() as SentientResult.Success).data.state)
        assertEquals(3, repo.statusCalls, "must not poll past the terminal state")
    }

    @Test
    fun `non-recoverable failure is emitted once and stops the loop`() = runTest {
        val terminal = SentientResult.Failure(SentientError.Auth("session expired", terminal = true))
        val repo = FakeDevicesRepository(statuses = listOf(terminal))
        val out = DevicesUseCases(repo) {}.pollLinkStatus(intervalMs = 1_000).toList()

        assertEquals(1, out.size, "a non-recoverable failure must stop the loop, never spin forever")
        assertTrue(!(out[0] as SentientResult.Failure).error.recoverable)
        assertEquals(1, repo.statusCalls)
    }

    @Test
    fun `terminal-state detector`() {
        assertTrue(isTerminalLinkState(SignalLinkStatusResponse(state = "linked")))
        assertTrue(isTerminalLinkState(SignalLinkStatusResponse(state = "idle", error = "boom")))
        assertTrue(!isTerminalLinkState(SignalLinkStatusResponse(state = "idle")))
    }
}
