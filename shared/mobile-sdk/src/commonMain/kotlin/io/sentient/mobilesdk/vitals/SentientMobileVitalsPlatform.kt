package io.sentient.mobilesdk.vitals

/** Non-PII device facts captured at init (UIDevice / Build). */
data class DeviceMeta(
    val platform: String,   // "ios" | "android"
    val device: String,     // model
    val os: String,         // name + version, e.g. "iOS 26.5"
    val locale: String,
    val freeMemBytes: Long,
    val freeDiskBytes: Long,
)

/**
 * The ONE platform capability surface SentientMobileVitals needs. Impls live in
 * androidMain / iosMain; the app constructs one and passes it to init().
 * File ops are path-in / bytes-out — no platform types cross this boundary.
 */
interface SentientMobileVitalsPlatform {
    /** Absolute dir for vitals files (app-private). Created if missing. */
    fun logsDir(): String
    fun writeFile(path: String, content: String)
    fun appendFile(path: String, content: String)
    fun readFile(path: String): String?
    fun listFiles(dir: String): List<String>   // absolute paths
    fun deleteFile(path: String)

    /** Register an unhandled-crash hook. onCrash runs SYNCHRONOUSLY in the dying
     *  process — it must only flush+mark locally, never network. */
    fun registerCrashHandler(onCrash: () -> Unit)

    fun deviceMeta(): DeviceMeta

    /** Volatile runtime state (battery / memory / network / thermal). Read at init
     *  and at crash; MUST be cheap + synchronous + non-throwing (it runs in the dying
     *  process at crash time). Return sentinel values for anything unavailable. */
    fun deviceSnapshot(): DeviceSnapshot
}
