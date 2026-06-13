package io.sentient.mobilesdk.vitals

/** Minimal cross-platform mutex for non-suspend critical sections.
 *  JVM actual: java.util.concurrent.locks.ReentrantLock
 *  iOS/Native actual: platform.Foundation.NSLock */
expect class PlatformLock() {
    fun lock()
    fun unlock()
    /** Non-blocking attempt. Returns true if the lock was acquired, false if already held. */
    fun tryLock(): Boolean
}

inline fun <T> PlatformLock.withLock(block: () -> T): T {
    lock()
    try {
        return block()
    } finally {
        unlock()
    }
}
