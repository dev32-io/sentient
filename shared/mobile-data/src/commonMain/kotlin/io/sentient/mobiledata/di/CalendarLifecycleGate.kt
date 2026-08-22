@file:OptIn(kotlin.concurrent.atomics.ExperimentalAtomicApi::class)

package io.sentient.mobiledata.di

import kotlin.concurrent.atomics.AtomicBoolean

/**
 * Short, non-suspending lifecycle critical section shared by mobile session
 * owners. Database work must stay outside this gate; only generation fencing,
 * dependency publication, and resource capture may run under it.
 */
internal class CalendarLifecycleLock {
    private val held = AtomicBoolean(false)

    fun <T> withLock(block: () -> T): T {
        while (!held.compareAndSet(false, true)) {
            // Lifecycle critical sections contain no suspension or I/O.
        }
        return try {
            block()
        } finally {
            held.store(false)
        }
    }
}

class CalendarLifecycleGate<Resource> {
    private val lock = CalendarLifecycleLock()
    private var generation: Long = 0L
    private var open: Boolean = false
    private var activeResource: Resource? = null

    /** Starts a new authenticated generation. */
    fun begin(onStarted: () -> Unit = {}): Long = withLock {
        generation += 1L
        open = true
        activeResource = null
        onStarted()
        generation
    }

    /**
     * Invalidates the generation before capturing the active resource. The
     * callback runs while the same critical section is held, so publication and
     * close cannot observe one another halfway through.
     */
    fun close(onClosed: () -> Unit = {}): Resource? = withLock {
        generation += 1L
        open = false
        val resource = activeResource
        activeResource = null
        onClosed()
        resource
    }

    /**
     * Attempts the sole ownership-transfer point. [commit] must only update
     * session-visible state and return true after every dependency reference has
     * been installed. A false result leaves [resource] locally owned by the
     * initializer, which is then responsible for closing/purging it.
     */
    fun publish(
        generation: Long,
        resource: Resource,
        commit: () -> Boolean,
    ): Boolean = withLock {
        if (!open || this.generation != generation) return@withLock false
        val committed = runCatching { commit() }.getOrDefault(false)
        if (!committed) return@withLock false
        activeResource = resource
        true
    }

    /** Runs a short state transition only if the generation is still current. */
    fun ifCurrent(generation: Long, block: () -> Unit): Boolean = withLock {
        if (!open || this.generation != generation) return@withLock false
        block()
        true
    }

    /** Reads the active resource through the lifecycle synchronization. */
    fun active(): Resource? = withLock { activeResource }

    private fun <T> withLock(block: () -> T): T = lock.withLock(block)
}
