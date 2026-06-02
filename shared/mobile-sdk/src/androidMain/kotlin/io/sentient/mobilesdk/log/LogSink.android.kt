package io.sentient.mobilesdk.log

import android.util.Log as AndroidLog

/**
 * Android log sink — routes to android.util.Log by level.
 * Messages are already sanitized by the time they reach this function.
 */
actual fun platformLogSink(tag: String, level: LogLevel, message: String) {
    when (level) {
        LogLevel.DEBUG -> AndroidLog.d(tag, message)
        LogLevel.INFO  -> AndroidLog.i(tag, message)
        LogLevel.WARN  -> AndroidLog.w(tag, message)
        LogLevel.ERROR -> AndroidLog.e(tag, message)
    }
}
