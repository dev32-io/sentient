package io.sentient.mobilesdk.vitals

import java.util.concurrent.locks.ReentrantLock as JvmReentrantLock

actual class PlatformLock actual constructor() {
    private val delegate = JvmReentrantLock()
    actual fun lock() = delegate.lock()
    actual fun unlock() = delegate.unlock()
    actual fun tryLock(): Boolean = delegate.tryLock()
}
