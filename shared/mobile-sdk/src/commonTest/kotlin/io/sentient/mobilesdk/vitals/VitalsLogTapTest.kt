package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogConfig
import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.log.createLogger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

class VitalsLogTapTest {
    @AfterTest fun reset() {
        VitalsLogTap.register { _, _, _ -> }
        LogConfig.minLevel = LogLevel.DEBUG
    }

    @Test fun captures_debug_even_when_logcat_is_info() {
        LogConfig.minLevel = LogLevel.INFO
        val captured = mutableListOf<Pair<LogLevel, String>>()
        VitalsLogTap.register { lvl, _, line -> captured += lvl to line }
        createLogger("t").debug("hello", mapOf("k" to "v"))
        assertTrue(captured.any { it.first == LogLevel.DEBUG && it.second.contains("hello") })
    }
}
