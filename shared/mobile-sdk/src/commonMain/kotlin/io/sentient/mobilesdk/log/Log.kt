package io.sentient.mobilesdk.log

/**
 * Tagged structured logger — mirrors web-sdk createLogger shape.
 *
 * Tags are hierarchical: the root prefix ["sentient", "mobile-sdk"] is always
 * prepended by [loggerTag]. Additional segments narrow to the component.
 *
 * All messages are sanitized through [sanitizeLog] and props are preview-truncated
 * before reaching the platform sink, so callers need not scrub manually.
 *
 * Usage:
 *   private val log = createLogger("transport", "websocket")
 *   log.info("connected", mapOf("url" to url, "sessionId" to id))
 */
interface Log {
    fun debug(message: String, props: Map<String, Any?> = emptyMap())
    fun info(message: String, props: Map<String, Any?> = emptyMap())
    fun warn(message: String, props: Map<String, Any?> = emptyMap())
    fun error(message: String, props: Map<String, Any?> = emptyMap())
}

/**
 * Builds the dot-separated tag string with the required root prefix.
 * Example: loggerTag("transport", "ws") → "sentient.mobile-sdk.transport.ws"
 */
fun loggerTag(vararg tags: String): String =
    (listOf("sentient", "mobile-sdk") + tags.toList()).joinToString(".")

/**
 * Creates a [Log] instance bound to the given tag segments.
 * The logger sanitizes every message and truncates prop values before emission.
 */
fun createLogger(vararg tags: String): Log {
    val tag = loggerTag(*tags)
    return object : Log {
        private fun emit(level: LogLevel, message: String, props: Map<String, Any?>) {
            val propsStr = if (props.isEmpty()) {
                ""
            } else {
                " " + props.entries.joinToString(" ") { (k, v) ->
                    "$k=${truncatePreview(v.toString())}"
                }
            }
            platformLogSink(tag, level, sanitizeLog(message + propsStr))
        }

        override fun debug(message: String, props: Map<String, Any?>) =
            emit(LogLevel.DEBUG, message, props)

        override fun info(message: String, props: Map<String, Any?>) =
            emit(LogLevel.INFO, message, props)

        override fun warn(message: String, props: Map<String, Any?>) =
            emit(LogLevel.WARN, message, props)

        override fun error(message: String, props: Map<String, Any?>) =
            emit(LogLevel.ERROR, message, props)
    }
}
