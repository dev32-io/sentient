package io.sentient.mobilesdk

/** Mirrors web-sdk createLogger shape; sink is platform-actual later. */
interface Log {
    fun debug(message: String, props: Map<String, Any?> = emptyMap())
    fun info(message: String, props: Map<String, Any?> = emptyMap())
    fun warn(message: String, props: Map<String, Any?> = emptyMap())
    fun error(message: String, props: Map<String, Any?> = emptyMap())
}

fun loggerTag(vararg tags: String): String = (listOf("sentient", "mobile-sdk") + tags).joinToString(".")
