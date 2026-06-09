package io.sentient.mobilesdk

/**
 * Backward-compatibility shims — Phase 0 callers used this package.
 * New code should import directly from io.sentient.mobilesdk.log.
 */
typealias Log = io.sentient.mobilesdk.log.Log

fun loggerTag(vararg tags: String): String =
    io.sentient.mobilesdk.log.loggerTag(*tags)
