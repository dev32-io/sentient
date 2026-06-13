package io.sentient.mobilesdk.vitals

/**
 * Structured, non-sensitive session header written at the top of each rolling
 * vitals file and carried with uploads. Excludes chat content, display names,
 * location, and contacts. Includes an opaque [userId] purely for correlating an
 * uploaded log to the authed account.
 *
 * Wire format: one `key=value` per line; values are sanitized to be single-line
 * (no `\r`/`\n`) so they can never inject a sentinel. Parse by splitting on the
 * FIRST `=` only — a value may legitimately contain `=` (e.g. a locale string).
 */
data class SessionMeta(
    val platform: String,
    val device: String,
    val os: String,
    val appVersion: String,
    val build: String,
    val sdkVersion: String,
    val deviceId: String,
    val userId: String?,
    val sessionStartMs: Long,
    val locale: String,
    val network: String,   // e.g. "wifi" | "cellular" | "none" | "unknown"
    val freeMemBytes: Long,
    val freeDiskBytes: Long,
) {
    fun renderHeader(): String = buildString {
        appendLine(HEADER_START)
        appendLine("platform=${oneLine(platform)}")
        appendLine("device=${oneLine(device)}")
        appendLine("os=${oneLine(os)}")
        appendLine("appVersion=${oneLine(appVersion)}")
        appendLine("build=${oneLine(build)}")
        appendLine("sdkVersion=${oneLine(sdkVersion)}")
        appendLine("deviceId=${oneLine(deviceId)}")
        appendLine("userId=${oneLine(userId ?: "-")}")
        appendLine("sessionStartMs=$sessionStartMs")
        appendLine("locale=${oneLine(locale)}")
        appendLine("network=${oneLine(network)}")
        appendLine("freeMemBytes=$freeMemBytes")
        appendLine("freeDiskBytes=$freeDiskBytes")
        appendLine(HEADER_END)
    }

    private companion object {
        const val HEADER_START = "=== SENTIENT VITALS SESSION ==="
        const val HEADER_END = "=== LOG ==="
        /** Collapse CR/LF to spaces so a platform string can't inject a sentinel line. */
        fun oneLine(v: String): String = v.replace('\r', ' ').replace('\n', ' ')
    }
}
