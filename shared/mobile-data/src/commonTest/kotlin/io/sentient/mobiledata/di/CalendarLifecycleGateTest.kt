package io.sentient.mobiledata.di

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class CalendarLifecycleGateTest {
    @Test
    fun `logout while paused before publish closes unpublished runtime`() = runBlocking {
        exerciseInvalidation("logout")
    }

    @Test
    fun `auth expiry while paused before publish closes unpublished runtime`() = runBlocking {
        exerciseInvalidation("auth-expiry")
    }

    @Test
    fun `account switch while paused before publish closes unpublished runtime`() = runBlocking {
        exerciseInvalidation("account-switch")
    }

    @Test
    fun `backend switch while paused before publish closes unpublished runtime`() = runBlocking {
        exerciseInvalidation("backend-switch")
    }

    @Test
    fun `successor creation cannot inherit a predecessor runtime`() = runBlocking {
        exerciseInvalidation("successor-creation")
    }

    private suspend fun exerciseInvalidation(reason: String) = coroutineScope {
        val gate = CalendarLifecycleGate<TestRuntime>()
        var visible: TestRuntime? = null
        var invalidation: String? = null
        val generation = gate.begin { visible = null }
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val lateRuntime = TestRuntime("predecessor")

        val initializer = async(Dispatchers.Default) {
            entered.complete(Unit)
            release.await()
            val published = gate.publish(generation, lateRuntime) {
                visible = lateRuntime
                true
            }
            if (!published) lateRuntime.close()
        }

        withTimeout(1_000L) { entered.await() }
        val captured = gate.close {
            invalidation = reason
            visible = null
        }
        captured?.close()
        release.complete(Unit)
        withTimeout(1_000L) { initializer.await() }

        assertEquals(reason, invalidation)
        assertTrue(lateRuntime.closed)
        assertNull(visible)

        val successor = TestRuntime("successor")
        val successorGeneration = gate.begin { visible = null }
        assertTrue(
            gate.publish(successorGeneration, successor) {
                visible = successor
                true
            },
        )
        assertSame(successor, visible)
        assertFalse(successor.closed)
        gate.close { visible = null }?.close()
        assertNull(visible)
        assertTrue(successor.closed)
    }

    private class TestRuntime(val name: String) {
        var closed: Boolean = false

        fun close() {
            closed = true
        }
    }
}
