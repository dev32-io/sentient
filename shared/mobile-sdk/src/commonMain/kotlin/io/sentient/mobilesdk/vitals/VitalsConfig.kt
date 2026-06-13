package io.sentient.mobilesdk.vitals

data class VitalsConfig(
    val appVersion: String,
    val build: String,
    val sdkVersion: String = "0.1.2",
    val ringMaxBytes: Int = 2 * 1024 * 1024,    // in-memory write buffer
    val fileMaxBytes: Long = 50L * 1024 * 1024, // per-launch file ceiling
    val keepFiles: Int = 5,
)
