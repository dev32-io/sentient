// ---------------------------------------------------------------------------
// AndroidVitalsPlatform — the androidMain actual for SentientMobileVitalsPlatform.
//
// Path-in / bytes-out file ops over the app-private filesDir/vitals directory,
// plus the device-meta snapshot from Build + Runtime and an unhandled-crash hook
// that CHAINS the prior default handler (flush+mark synchronously, then rethrow
// to whoever was installed before us — never swallow the crash).
//
// androidMain may use android.* / java.*; commonMain stays pure (see the
// commonMain-purity rule). This file adapts platform → the commonMain interface.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.vitals

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import io.sentient.mobilesdk.log.createLogger
import java.io.File
import java.util.Locale

/** Android capability surface for the vitals subsystem. App-private file storage. */
class AndroidVitalsPlatform(private val context: Context) : SentientMobileVitalsPlatform {
    private val log = createLogger("vitals", "platform", "android")
    private val dir by lazy { File(context.filesDir, VITALS_DIR).apply { mkdirs() } }

    override fun logsDir(): String = dir.absolutePath

    override fun writeFile(path: String, content: String) {
        File(path).writeText(content)
    }

    override fun appendFile(path: String, content: String) {
        File(path).appendText(content)
    }

    override fun readFile(path: String): String? =
        File(path).let { if (it.exists()) it.readText() else null }

    override fun listFiles(dir: String): List<String> =
        File(dir).listFiles()?.map { it.absolutePath } ?: emptyList()

    override fun deleteFile(path: String) {
        File(path).delete()
    }

    override fun registerCrashHandler(onCrash: () -> Unit) {
        val prior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            // onCrash flushes + marks SYNCHRONOUSLY in the dying process; never network.
            // Always chain the prior handler so the OS crash dialog / reporters still fire.
            try {
                onCrash()
            } finally {
                prior?.uncaughtException(t, e)
            }
        }
        log.info("crash-handler.registered", mapOf("chainedPrior" to (prior != null)))
    }

    override fun deviceSnapshot(): DeviceSnapshot {
        val battery = readBattery()
        val mem = readMemory()
        val net = readNetworkType()
        val signal = readSignalLevel(net)
        val thermal = readThermalState()
        val disk = readFreeDisk()
        log.debug(
            "device-snapshot",
            mapOf(
                "batteryPct" to battery.pct,
                "isCharging" to battery.isCharging,
                "availMemMb" to if (mem.first >= 0) mem.first / 1_048_576 else -1,
                "lowMemory" to mem.third,
                "networkType" to net,
                "signalLevel" to signal,
                "thermalState" to thermal,
                "freeDiskMb" to if (disk >= 0) disk / 1_048_576 else -1,
            ),
        )
        return DeviceSnapshot(
            batteryPct = battery.pct,
            isCharging = battery.isCharging,
            availMemBytes = mem.first,
            totalMemBytes = mem.second,
            lowMemory = mem.third,
            networkType = net,
            signalLevel = signal,
            thermalState = thermal,
            freeDiskBytes = disk,
        )
    }

    // --- battery (sticky broadcast, no permission) ---------------------------

    private data class BatteryReading(val pct: Int, val isCharging: Boolean)

    private fun readBattery(): BatteryReading = runCatching {
        val intent = context.registerReceiver(
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED),
        )
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
        val plugged = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = plugged != 0 ||
            status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        BatteryReading(pct, charging)
    }.getOrDefault(BatteryReading(-1, false))

    // --- memory (ActivityManager, no permission) -----------------------------

    private fun readMemory(): Triple<Long, Long, Boolean> = runCatching {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        Triple(info.availMem, info.totalMem, info.lowMemory)
    }.getOrDefault(Triple(-1L, -1L, false))

    // --- network type (ACCESS_NETWORK_STATE, already declared) ---------------

    private fun readNetworkType(): String = runCatching {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = cm.activeNetwork ?: return@runCatching NET_NONE
        val caps = cm.getNetworkCapabilities(net) ?: return@runCatching NET_NONE
        when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NET_WIFI
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> NET_CELLULAR
            else -> NET_UNKNOWN
        }
    }.getOrDefault(NET_UNKNOWN)

    // --- signal level (ACCESS_WIFI_STATE, normal — wifi only) ----------------

    private fun readSignalLevel(networkType: String): Int = runCatching {
        if (networkType != NET_WIFI) return@runCatching SIGNAL_UNKNOWN
        val wm = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager
            ?: return@runCatching SIGNAL_UNKNOWN
        @Suppress("DEPRECATION")
        val rssi = wm.connectionInfo?.rssi ?: return@runCatching SIGNAL_UNKNOWN
        if (rssi == 0 || rssi == Int.MIN_VALUE) return@runCatching SIGNAL_UNKNOWN
        @Suppress("DEPRECATION")
        WifiManager.calculateSignalLevel(rssi, SIGNAL_BARS)
    }.getOrDefault(SIGNAL_UNKNOWN)

    // --- thermal state (PowerManager API 29+) --------------------------------

    private fun readThermalState(): String = runCatching {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return@runCatching THERMAL_UNKNOWN
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        when (pm.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE,
            PowerManager.THERMAL_STATUS_LIGHT -> THERMAL_NOMINAL
            PowerManager.THERMAL_STATUS_MODERATE -> THERMAL_FAIR
            PowerManager.THERMAL_STATUS_SEVERE -> THERMAL_SERIOUS
            PowerManager.THERMAL_STATUS_CRITICAL,
            PowerManager.THERMAL_STATUS_EMERGENCY,
            PowerManager.THERMAL_STATUS_SHUTDOWN -> THERMAL_CRITICAL
            else -> THERMAL_UNKNOWN
        }
    }.getOrDefault(THERMAL_UNKNOWN)

    // --- free disk (filesDir partition) --------------------------------------

    private fun readFreeDisk(): Long = runCatching {
        context.filesDir.usableSpace
    }.getOrDefault(-1L)

    override fun deviceMeta(): DeviceMeta = DeviceMeta(
        platform = PLATFORM_ANDROID,
        device = "${Build.MANUFACTURER} ${Build.MODEL}",
        os = "Android ${Build.VERSION.RELEASE}",
        locale = Locale.getDefault().toString(),
        freeMemBytes = Runtime.getRuntime().freeMemory(),
        freeDiskBytes = context.filesDir.usableSpace,
    )

    private companion object {
        const val VITALS_DIR = "vitals"
        const val PLATFORM_ANDROID = "android"

        // network type strings
        const val NET_WIFI = "wifi"
        const val NET_CELLULAR = "cellular"
        const val NET_NONE = "none"
        const val NET_UNKNOWN = "unknown"

        // signal
        const val SIGNAL_BARS = 5       // WifiManager.calculateSignalLevel range (0..4)
        const val SIGNAL_UNKNOWN = -1

        // thermal state strings
        const val THERMAL_NOMINAL = "nominal"
        const val THERMAL_FAIR = "fair"
        const val THERMAL_SERIOUS = "serious"
        const val THERMAL_CRITICAL = "critical"
        const val THERMAL_UNKNOWN = "unknown"
    }
}
