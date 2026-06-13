package io.sentient.mobilesdk.vitals

/**
 * Volatile runtime device state — captured at init and again at crash. Distinct from
 * [DeviceMeta]'s static facts. All non-PII (no chat, names, location). Unavailable
 * platform values use the sentinels (-1 numbers / "unknown" strings / false flags) so a
 * missing API never blocks capture.
 */
data class DeviceSnapshot(
    val batteryPct: Int,        // 0..100; -1 if unknown
    val isCharging: Boolean,
    val availMemBytes: Long,    // app-available / system-free memory; -1 if unknown
    val totalMemBytes: Long,    // -1 if unknown
    val lowMemory: Boolean,     // platform low-memory flag (false if unknown)
    val networkType: String,    // "wifi" | "cellular" | "none" | "unknown"
    val signalLevel: Int,       // 0..4 bars; -1 if unknown/unavailable (iOS is API-limited)
    val thermalState: String,   // "nominal" | "fair" | "serious" | "critical" | "unknown"
    val freeDiskBytes: Long,    // -1 if unknown
) {
    /** A labeled block appended to the rolling file. [label] is e.g. "@init" / "@crash". */
    fun renderBlock(label: String): String = buildString {
        appendLine("=== STATE $label ===")
        appendLine("batteryPct=$batteryPct")
        appendLine("isCharging=$isCharging")
        appendLine("availMemBytes=$availMemBytes")
        appendLine("totalMemBytes=$totalMemBytes")
        appendLine("lowMemory=$lowMemory")
        appendLine("networkType=$networkType")
        appendLine("signalLevel=$signalLevel")
        appendLine("thermalState=$thermalState")
        appendLine("freeDiskBytes=$freeDiskBytes")
    }
}
