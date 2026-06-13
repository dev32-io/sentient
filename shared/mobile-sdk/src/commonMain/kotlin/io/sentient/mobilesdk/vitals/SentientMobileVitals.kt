package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.concurrent.Volatile

/**
 * Facade for the client diagnostic subsystem. The app calls init() once at launch,
 * keeps logging normally (the tap feeds the ring), forwards app-background to flush,
 * and lets Settings list/upload sessions. Crashes flush+mark synchronously and the
 * NEXT launch auto-uploads any session that carries a crash marker.
 */
class SentientMobileVitals {
    private val log = createLogger("vitals", "facade")
    @Volatile private var inited = false
    private lateinit var ring: VitalsRing
    private lateinit var files: VitalsFiles
    private var uploader: VitalsUploader? = null
    private var scope: CoroutineScope? = null

    /** Production entry: pass a live uploader + scope so a prior crash auto-uploads. */
    fun init(
        config: VitalsConfig,
        platform: SentientMobileVitalsPlatform,
        deviceId: String,
        userId: String?,
        nowMs: Long,
        network: String,
        uploader: VitalsUploader?,
        scope: CoroutineScope?,
    ) {
        if (inited) { log.warn("init.duplicate"); return }
        this.uploader = uploader
        this.scope = scope
        ring = VitalsRing(config.ringMaxBytes)
        files = VitalsFiles(platform, config.keepFiles, config.fileMaxBytes)
        VitalsLogTap.register { _: LogLevel, tag: String, line: String -> ring.append("$tag $line") }

        // Capture any PRIOR crashed session BEFORE rotating the new file.
        val crashed = files.listSessions().filter { it.crashed }
        val dm = platform.deviceMeta()
        val meta = SessionMeta(
            platform = dm.platform,
            device = dm.device,
            os = dm.os,
            appVersion = config.appVersion,
            build = config.build,
            sdkVersion = config.sdkVersion,
            deviceId = deviceId,
            userId = userId,
            sessionStartMs = nowMs,
            locale = dm.locale,
            network = network,
            freeMemBytes = dm.freeMemBytes,
            freeDiskBytes = dm.freeDiskBytes,
        )
        files.startSession(meta)
        runCatching { files.flush(platform.deviceSnapshot().renderBlock("@init")) }
            .onFailure { log.warn("snapshot.init-failed", mapOf("reason" to (it.message ?: "unknown"))) }
        platform.registerCrashHandler {
            // Non-blocking drain: iOS NSLock is non-reentrant; if the crashing thread
            // held the ring lock (crashed mid-append), a blocking drain() would deadlock
            // the dying process and prevent the crash marker from being written.
            files.flush(ring.drainTry())
            // Dying process: no structured logger (re-entrant lock / allocation risk). On a
            // snapshot-read failure, append a literal marker so the file shows the read FAILED
            // (vs. looking truncated). markCrash() still runs after, so the crash is always marked.
            runCatching { files.flush(platform.deviceSnapshot().renderBlock("@crash")) }
                .onFailure { runCatching { files.flush("=== STATE @crash unavailable ===\n") } }
            files.markCrash()
        }
        inited = true
        log.info("init", mapOf("crashed" to crashed.size, "userId" to (userId ?: "-")))
        for (s in crashed) autoUpload(platform, s)
    }

    /** Test entry: no scope; inject a fake/null uploader. */
    fun initForTest(
        config: VitalsConfig,
        platform: SentientMobileVitalsPlatform,
        deviceId: String,
        userId: String?,
        nowMs: Long,
        network: String,
        uploader: VitalsUploader?,
    ) = init(config, platform, deviceId, userId, nowMs, network, uploader, scope = null)

    fun onAppBackground() {
        if (inited) files.flush(ring.drain())
    }

    fun listSessions(): List<VitalsSessionInfo> {
        if (!inited) return emptyList()
        files.flush(ring.drain())
        return files.listSessions()
    }

    /** Upload one session's body; returns the server ref (or "" / null per VitalsUploader's contract). */
    suspend fun upload(fileName: String, body: String, onProgress: (Double) -> Unit): String? =
        uploader?.upload(fileName, body, onProgress)

    private fun autoUpload(platform: SentientMobileVitalsPlatform, s: VitalsSessionInfo) {
        val u = uploader ?: return
        val sc = scope ?: return
        val body = platform.readFile(s.path) ?: return
        log.info("auto-upload.fire", mapOf("path" to s.path))
        sc.launch { u.upload(s.path.substringAfterLast('/'), body) { } }
    }
}
