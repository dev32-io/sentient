package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel
import kotlin.concurrent.Volatile

/** Global tap: Log.emit feeds every formatted line here BEFORE the logcat-level
 *  gate, so the ring captures DEBUG+ even when logcat is INFO-only in release. */
object VitalsLogTap {
    @Volatile private var sink: ((LogLevel, String, String) -> Unit)? = null
    fun register(s: (LogLevel, String, String) -> Unit) { sink = s }
    fun capture(level: LogLevel, tag: String, line: String) { sink?.invoke(level, tag, line) }
}
