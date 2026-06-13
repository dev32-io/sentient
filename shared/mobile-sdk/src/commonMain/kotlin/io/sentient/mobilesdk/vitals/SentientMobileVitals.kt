package io.sentient.mobilesdk.vitals

import io.sentient.mobilesdk.log.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Facade for the client diagnostic subsystem. The app calls init() once at launch,
 * keeps logging normally (the tap feeds the ring), forwards app-background to flush,
 * and lets Settings list/upload sessions. Crashes flush+mark synchronously and the
 * NEXT launch auto-uploads any session that carries a crash marker.
 */
class SentientMobileVitals {
    private var inited = false
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
        platform.registerCrashHandler {
            files.flush(ring.drain())
            files.markCrash()
        }
        inited = true
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
        sc.launch { u.upload(s.path.substringAfterLast('/'), body) { } }
    }
}
