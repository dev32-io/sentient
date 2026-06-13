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

    companion object {
        const val NET_WIFI = "wifi"
        const val NET_CELLULAR = "cellular"
        const val NET_NONE = "none"
        const val NET_UNKNOWN = "unknown"
        const val THERMAL_NOMINAL = "nominal"
        const val THERMAL_FAIR = "fair"
        const val THERMAL_SERIOUS = "serious"
        const val THERMAL_CRITICAL = "critical"
        const val THERMAL_UNKNOWN = "unknown"
        const val UNKNOWN_INT = -1        // battery / signal sentinel
        const val UNKNOWN_LONG = -1L      // mem / disk sentinel
    }
}
