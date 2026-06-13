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

import android.content.Context
import android.os.Build
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

    // TODO(next-task): replace stub with real Android battery/mem/network/thermal reads.
    override fun deviceSnapshot(): DeviceSnapshot = DeviceSnapshot(
        batteryPct = -1, isCharging = false, availMemBytes = -1, totalMemBytes = -1,
        lowMemory = false, networkType = "unknown", signalLevel = -1,
        thermalState = "unknown", freeDiskBytes = -1,
    )

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
    }
}
