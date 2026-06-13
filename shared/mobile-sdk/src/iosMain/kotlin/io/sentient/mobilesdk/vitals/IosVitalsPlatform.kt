// ---------------------------------------------------------------------------
// IosVitalsPlatform — the iOS actual of SentientMobileVitalsPlatform.
//
// File ops live in an app-private Caches subdir (vitals/). Crash capture wires
// BOTH Kotlin/Native's terminal hook AND an ObjC NSException bridge: the Swift
// app sets NSSetUncaughtExceptionHandler { IosCrashBridge.onCrash?() } so an
// uncaught ObjC NSException also flushes+marks before the process dies. Mirrors
// AndroidVitalsPlatform (which chains the JVM uncaught handler).
//
// NON-GOAL (per spec): native POSIX SIGNAL crashes (SIGSEGV / SIGABRT / SIGBUS)
// are NOT captured here — only Kotlin/Native unhandled throws + ObjC NSException.
// A signal-handler crash reporter is out of scope for v1.
// ---------------------------------------------------------------------------
@file:OptIn(ExperimentalForeignApi::class, ExperimentalNativeApi::class, BetaInteropApi::class)

package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.createLogger
import kotlin.concurrent.Volatile
import kotlin.experimental.ExperimentalNativeApi
import kotlin.native.setUnhandledExceptionHook
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import platform.Foundation.NSCachesDirectory
import platform.Foundation.NSData
import platform.Foundation.NSFileHandle
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileSystemFreeSize
import platform.Foundation.NSHomeDirectory
import platform.Foundation.NSLocale
import platform.Foundation.NSNumber
import platform.Foundation.NSProcessInfo
import platform.Foundation.NSProcessInfoThermalState
import platform.Foundation.NSSearchPathForDirectoriesInDomains
import platform.Foundation.thermalState
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.NSUserDomainMask
import platform.Foundation.closeFile
import platform.Foundation.create
import platform.Foundation.currentLocale
import platform.Foundation.dataUsingEncoding
import platform.Foundation.fileHandleForWritingAtPath
import platform.Foundation.localeIdentifier
import platform.Foundation.seekToEndOfFile
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeData
import platform.Foundation.writeToFile
import platform.UIKit.UIDevice
import platform.UIKit.UIDeviceBatteryState

private const val PLATFORM_IOS = "ios"
private const val VITALS_SUBDIR = "vitals"

// Thermal state strings (shared with DeviceSnapshot contract)
private const val THERMAL_NOMINAL = "nominal"
private const val THERMAL_FAIR = "fair"
private const val THERMAL_SERIOUS = "serious"
private const val THERMAL_CRITICAL = "critical"
private const val THERMAL_UNKNOWN = "unknown"

// Network type sentinel (synchronous read not available on iOS)
private const val NET_UNKNOWN = "unknown"

private const val SIGNAL_UNKNOWN = -1

/** iOS actual of [SentientMobileVitalsPlatform]. File ops over Caches/vitals. */
class IosVitalsPlatform : SentientMobileVitalsPlatform {
    private val log = createLogger("vitals", "platform", "ios")
    private val fm = NSFileManager.defaultManager

    init {
        // Battery monitoring must be enabled once before batteryLevel / batteryState
        // return real values; enabling it is idempotent and cheap.
        UIDevice.currentDevice.batteryMonitoringEnabled = true
    }

    // Caches (not Documents): diagnostics are reproducible, OS-evictable artifacts,
    // not user data to back up. Created on first access.
    private val dir: String by lazy {
        val caches = (
            NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, true)
                .firstOrNull() as? String
            ) ?: "."
        val d = "$caches/$VITALS_SUBDIR"
        fm.createDirectoryAtPath(d, withIntermediateDirectories = true, attributes = null, error = null)
        log.info("logs-dir", mapOf("dir" to d))
        d
    }

    override fun logsDir(): String = dir

    override fun writeFile(path: String, content: String) {
        // A Kotlin String does NOT bridge to NSString via `as`; build the NSString
        // explicitly (NSString.create), then write its UTF-8 NSData atomically.
        val data = utf8Data(content) ?: return
        data.writeToFile(path, atomically = true)
    }

    override fun appendFile(path: String, content: String) {
        val data = utf8Data(content) ?: return
        val handle = NSFileHandle.fileHandleForWritingAtPath(path)
        if (handle == null) {
            // No file yet (or unopenable): fall back to a fresh write.
            data.writeToFile(path, atomically = true)
            return
        }
        handle.seekToEndOfFile()
        handle.writeData(data)
        handle.closeFile()
    }

    override fun readFile(path: String): String? =
        NSString.stringWithContentsOfFile(path, encoding = NSUTF8StringEncoding, error = null)

    /** Bridge a Kotlin [String] to its UTF-8 [NSData] via NSString.create. */
    private fun utf8Data(content: String): NSData? =
        NSString.create(string = content).dataUsingEncoding(NSUTF8StringEncoding)

    override fun listFiles(dir: String): List<String> {
        @Suppress("UNCHECKED_CAST")
        val names = (fm.contentsOfDirectoryAtPath(dir, error = null) as? List<String>) ?: emptyList()
        return names.map { "$dir/$it" }
    }

    override fun deleteFile(path: String) {
        fm.removeItemAtPath(path, error = null)
    }

    override fun registerCrashHandler(onCrash: () -> Unit) {
        // Kotlin/Native unhandled throw → terminal hook (return value = prior hook, ignored).
        setUnhandledExceptionHook { _ -> onCrash() }
        // ObjC NSException → set by Swift's NSSetUncaughtExceptionHandler, which invokes this.
        IosCrashBridge.onCrash = onCrash
        log.info("crash-handler.registered")
    }

    override fun deviceSnapshot(): DeviceSnapshot {
        val batteryPct = readBatteryPct()
        val isCharging = readIsCharging()
        val totalMem = readTotalMemBytes()
        val freeDisk = readFreeDiskBytes()
        val thermal = readThermalState()
        log.debug(
            "device-snapshot",
            mapOf(
                "batteryPct" to batteryPct,
                "isCharging" to isCharging,
                "totalMemMb" to if (totalMem >= 0) totalMem / 1_048_576 else -1,
                "thermalState" to thermal,
                "freeDiskMb" to if (freeDisk >= 0) freeDisk / 1_048_576 else -1,
            ),
        )
        return DeviceSnapshot(
            batteryPct = batteryPct,
            isCharging = isCharging,
            availMemBytes = -1L,       // os_proc_available_memory not in K/N platform bindings
            totalMemBytes = totalMem,
            lowMemory = false,         // no synchronous iOS flag
            networkType = NET_UNKNOWN, // NWPathMonitor is async-only; real network logged elsewhere
            signalLevel = SIGNAL_UNKNOWN,
            thermalState = thermal,
            freeDiskBytes = freeDisk,
        )
    }

    // --- battery ---------------------------------------------------------------

    private fun readBatteryPct(): Int = runCatching {
        val level = UIDevice.currentDevice.batteryLevel
        if (level < 0f) -1 else (level * 100).toInt()
    }.getOrDefault(-1)

    private fun readIsCharging(): Boolean = runCatching {
        val state = UIDevice.currentDevice.batteryState
        state == UIDeviceBatteryState.UIDeviceBatteryStateCharging ||
            state == UIDeviceBatteryState.UIDeviceBatteryStateFull
    }.getOrDefault(false)

    // --- thermal state ---------------------------------------------------------

    private fun readThermalState(): String = runCatching {
        when (NSProcessInfo.processInfo.thermalState) {
            NSProcessInfoThermalState.NSProcessInfoThermalStateNominal -> THERMAL_NOMINAL
            NSProcessInfoThermalState.NSProcessInfoThermalStateFair -> THERMAL_FAIR
            NSProcessInfoThermalState.NSProcessInfoThermalStateSerious -> THERMAL_SERIOUS
            NSProcessInfoThermalState.NSProcessInfoThermalStateCritical -> THERMAL_CRITICAL
        }
    }.getOrDefault(THERMAL_UNKNOWN)

    // --- memory ----------------------------------------------------------------

    private fun readTotalMemBytes(): Long = runCatching {
        NSProcessInfo.processInfo.physicalMemory.toLong()
    }.getOrDefault(-1L)

    // --- free disk -------------------------------------------------------------

    private fun readFreeDiskBytes(): Long = runCatching {
        val attrs = fm.attributesOfFileSystemForPath(
            NSHomeDirectory(),
            error = null,
        ) ?: return@runCatching -1L
        (attrs[NSFileSystemFreeSize] as? NSNumber)?.longLongValue() ?: -1L
    }.getOrDefault(-1L)

    override fun deviceMeta(): DeviceMeta {
        val d = UIDevice.currentDevice
        return DeviceMeta(
            platform = PLATFORM_IOS,
            device = d.model,
            os = "${d.systemName} ${d.systemVersion}",
            locale = NSLocale.currentLocale.localeIdentifier,
            // Precise iOS free-mem / free-disk needs more API surface than the v1
            // header carries value for; 0 is the agreed sentinel (see task spec).
            freeMemBytes = 0L,
            freeDiskBytes = 0L,
        )
    }
}

/**
 * Bridge for the ObjC NSException crash path. Swift's
 * `NSSetUncaughtExceptionHandler { _ in IosCrashBridge.shared.onCrash?() }`
 * reads [onCrash] (set by [IosVitalsPlatform.registerCrashHandler]) to flush+mark
 * a vitals session synchronously in the dying process. A plain object with a
 * nullable var is sufficient — the handler runs on the crashing thread.
 */
object IosCrashBridge {
    @Volatile var onCrash: (() -> Unit)? = null
}
