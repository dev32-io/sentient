package io.sentient.mobilesdk.vitals

import platform.Foundation.NSLock

actual class PlatformLock actual constructor() {
    private val delegate = NSLock()
    actual fun lock() = delegate.lock()
    actual fun unlock() = delegate.unlock()
}
