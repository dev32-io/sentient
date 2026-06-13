package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel
import kotlin.concurrent.Volatile

/** Global tap: Log.emit feeds every formatted line here BEFORE the logcat-level
 *  gate, so the ring captures DEBUG+ even when logcat is INFO-only in release.
 *  No-op until vitals registers a sink. Sink exceptions are swallowed — the ring
 *  must never break the SDK's logging path. */
object VitalsLogTap {
    @Volatile private var sink: ((LogLevel, String, String) -> Unit)? = null

    fun register(s: (LogLevel, String, String) -> Unit) { sink = s }
    fun clear() { sink = null }
    fun hasSink(): Boolean = sink != null

    fun capture(level: LogLevel, tag: String, line: String) {
        try {
            sink?.invoke(level, tag, line)
        } catch (_: Throwable) {
            // the ring must never break logging
        }
    }
}
