package io.sentient.mobilesdk.log

import platform.Foundation.NSLog

/**
 * iOS log sink — routes to NSLog, which is visible in `log stream` and Xcode console.
 *
 * NSLog was chosen over os_log for v1 because the os_log C-macro interop in
 * Kotlin/Native requires unsafe pointer gymnastics for the format string that is
 * fragile across KMP versions. NSLog reaches the same `log stream` output and is
 * sufficient for device debugging.  Upgrade to os_log subsystem filtering is
 * tracked as a future improvement.
 *
 * Messages are already sanitized by the time they reach this function.
 */
actual fun platformLogSink(tag: String, level: LogLevel, message: String) {
    val levelLabel = when (level) {
        LogLevel.DEBUG -> "D"
        LogLevel.INFO  -> "I"
        LogLevel.WARN  -> "W"
        LogLevel.ERROR -> "E"
    }
    NSLog("[$levelLabel] $tag: $message")
}
