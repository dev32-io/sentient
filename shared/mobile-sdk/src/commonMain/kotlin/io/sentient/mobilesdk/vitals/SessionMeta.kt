package io.sentient.mobilesdk.vitals

data class SessionMeta(
    val platform: String, val device: String, val os: String,
    val appVersion: String, val build: String, val sdkVersion: String,
    val deviceId: String, val userId: String?, val sessionStartMs: Long,
    val locale: String, val network: String,
    val freeMemBytes: Long, val freeDiskBytes: Long,
) {
    /** Structured header block written at the top of each rolling file. Non-PII only. */
    fun renderHeader(): String = buildString {
        appendLine("=== SENTIENT VITALS SESSION ===")
        appendLine("platform=$platform"); appendLine("device=$device"); appendLine("os=$os")
        appendLine("appVersion=$appVersion"); appendLine("build=$build"); appendLine("sdkVersion=$sdkVersion")
        appendLine("deviceId=$deviceId"); appendLine("userId=${userId ?: "-"}")
        appendLine("sessionStartMs=$sessionStartMs"); appendLine("locale=$locale"); appendLine("network=$network")
        appendLine("freeMemBytes=$freeMemBytes"); appendLine("freeDiskBytes=$freeDiskBytes")
        appendLine("=== LOG ===")
    }
}
