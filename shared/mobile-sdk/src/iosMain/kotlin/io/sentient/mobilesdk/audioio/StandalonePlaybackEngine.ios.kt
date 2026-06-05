// ---------------------------------------------------------------------------
// StandalonePlaybackEngine.ios.kt — a private AVAudioEngine + .playback session
// for assistant TTS when the mic is NOT in use (text chat / voice mode off).
//
// WHY SEPARATE FROM THE SHARED ENGINE: the shared engine (SharedAudioEngine) runs
// a .playAndRecord / voiceChat session whose voice-processing IO unit needs a mic
// route to initialize. A TEXT chat never prompts for mic permission, so on a real
// device prepare()/start() on that engine raises "no audio I/O route" and every
// TTS frame is dropped — the assistant plays silent. The .playback category needs
// NO mic permission, so TTS plays even with mic permission undetermined/denied.
// E2 routes here whenever SharedAudioEngine.isCaptureActive is false. Full-duplex
// AEC is irrelevant on the text path (no uplink), so a separate engine is correct.
//
// Lifecycle: one [acquire] per playback run returns the running engine; [release]
// stops it + deactivates the .playback session. Single-user (only E2 playback uses
// it) — no refcount needed. Driven serially on the orchestrator coroutine.
//
// NO-CRASH CONTRACT: prepare()/start() go through the SAME ObjC @try/@catch shims
// as the shared engine ([enginePrepareGuarded]/[engineStartGuarded]) so a missing
// audio route (e.g. a sim with no output) degrades to a logged null/false instead
// of an NSException → SIGABRT. configureSession's NSError** is handled via memScoped.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioSession
import platform.AVFAudio.AVAudioSessionCategoryPlayback
import platform.AVFAudio.AVAudioSessionModeDefault
import platform.AVFAudio.setActive
import platform.Foundation.NSError

private val log = createLogger("audioio", "standalone-playback", "ios")

// AVAudioSessionCategoryOptions (NSUInteger → ULong) — no options for plain playback.
private const val NO_CATEGORY_OPTIONS: ULong = 0uL

/**
 * Process-wide holder for a private playback-only [AVAudioEngine] + .playback
 * [AVAudioSession]. Used by E2 playback when capture is inactive (text path).
 *
 * Not intended for concurrent calls — the SDK drives start/stop serially on the
 * orchestrator coroutine. Single user (only the playback adapter), so no refcount.
 */
internal class StandalonePlaybackEngine private constructor() {

    val engine: AVAudioEngine = AVAudioEngine()
    private var sessionConfigured = false
    private var active = false

    /**
     * Configures the .playback session + starts the engine, then returns it.
     * Returns null on any configuration / start failure (no throw). prepare()/start()
     * are guarded against the AVAudioEngine "no audio I/O route" NSException exactly
     * like the shared engine, degrading to a null return instead of SIGABRT.
     */
    fun acquire(): AVAudioEngine? {
        if (!ensureSession()) return null
        if (!engine.running) {
            if (!enginePrepareGuarded(engine) || !engineStartGuarded(engine)) return null
        }
        active = true
        log.debug("acquire", mapOf("running" to engine.running))
        return engine
    }

    /** Stops the engine + deactivates the .playback session. Idempotent. */
    fun release() {
        if (!active) {
            log.debug("release-noop")
            return
        }
        active = false
        runCatching {
            if (engine.running) engine.stop()
            AVAudioSession.sharedInstance().setActive(false, null)
        }.onFailure { log.warn("teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        sessionConfigured = false
        log.info("engine-stopped")
    }

    /** Restarts the engine if a render-graph change (attach/connect) stopped it. */
    fun ensureRunning(): Boolean {
        if (engine.running) return true
        return enginePrepareGuarded(engine) && engineStartGuarded(engine)
    }

    private fun ensureSession(): Boolean {
        if (sessionConfigured) return true
        val ok = configureSession()
        if (ok) sessionConfigured = true
        return ok
    }

    private fun configureSession(): Boolean = memScoped {
        val session = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = session.setCategory(
            AVAudioSessionCategoryPlayback,
            mode = AVAudioSessionModeDefault,
            options = NO_CATEGORY_OPTIONS,
            error = errVar.ptr,
        )
        if (!categorySet) {
            log.error("session-category-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        val activated = session.setActive(true, errVar.ptr)
        if (!activated) {
            log.error("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        log.debug("session-configured", mapOf("category" to "playback", "mode" to "default"))
        true
    }

    companion object {
        /** Process-wide standalone playback engine — E2 uses this when mic is inactive. */
        val instance: StandalonePlaybackEngine by lazy { StandalonePlaybackEngine() }
    }
}
