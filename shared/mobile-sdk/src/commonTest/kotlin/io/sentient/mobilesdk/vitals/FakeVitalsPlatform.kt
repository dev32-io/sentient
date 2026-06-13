package io.sentient.mobilesdk.vitals

class FakeVitalsPlatform(
    private val meta: DeviceMeta = DeviceMeta("android", "Pixel", "Android 14", "en", 1, 2),
    private val snapshot: DeviceSnapshot = DeviceSnapshot(
        batteryPct = 80, isCharging = false, availMemBytes = 100, totalMemBytes = 200,
        lowMemory = false, networkType = DeviceSnapshot.NET_WIFI, signalLevel = 3,
        thermalState = DeviceSnapshot.THERMAL_NOMINAL, freeDiskBytes = 500,
    ),
) : SentientMobileVitalsPlatform {
    val files = LinkedHashMap<String, String>()
    var crashHook: (() -> Unit)? = null
    override fun logsDir() = "/vitals"
    override fun writeFile(path: String, content: String) { files[path] = content }
    override fun appendFile(path: String, content: String) { files[path] = (files[path] ?: "") + content }
    override fun readFile(path: String) = files[path]
    override fun listFiles(dir: String) = files.keys.filter { it.startsWith("$dir/") }.toList()
    override fun deleteFile(path: String) { files.remove(path) }
    override fun registerCrashHandler(onCrash: () -> Unit) { crashHook = onCrash }
    override fun deviceMeta() = meta
    override fun deviceSnapshot(): DeviceSnapshot = snapshot
}
