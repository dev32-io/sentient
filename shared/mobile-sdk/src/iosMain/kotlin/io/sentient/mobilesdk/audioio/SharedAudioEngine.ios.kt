// ---------------------------------------------------------------------------
// SharedAudioEngine.ios.kt — one AVAudioEngine + playAndRecord session shared by
// capture (E1 input tap) and playback (E2 player node) for full-duplex AEC.
//
// WHY SHARED (full-duplex decision): iOS voice-processing IO
// (setVoiceProcessingEnabled on the input node) only cancels the speaker echo
// when the playback path runs through the SAME engine's IO unit — that's how the
// VP unit gets the render reference. Capture and playback on separate engines
// would mean the assistant's own voice leaks into the uplink (no AEC), breaking
// barge-in. So both adapters obtain THIS shared engine + the shared
// playAndRecord/voiceChat AVAudioSession. E1's capture was refactored from its
// own private AVAudioEngine() to this holder.
//
// Lifecycle: capture and playback are independent users of the engine. The
// engine starts on first use and stays running while EITHER side is active;
// stop() from one side does NOT tear the engine down while the other holds it.
// retain()/release() reference-count the two users; the engine + session are
// stopped only when the count reaches zero.
//
// CAPTURE vs PLAYBACK USERS: callers tag their retain as CAPTURE
// (retainForCapture/releaseForCapture) or PLAYBACK (retain/release). Both feed
// the SAME total-user refcount that gates engine teardown, but capture retains
// ALSO bump a separate captureUsers counter exposed via [isCaptureActive]. The
// E2 playback adapter reads that flag at start() to decide its engine: capture
// active → attach the player HERE (shared playAndRecord, full-duplex AEC);
// capture inactive (text chat / voice off) → play on a STANDALONE .playback
// engine that needs no mic permission (see StandalonePlaybackEngine.ios.kt).
//
// NO-CRASH CONTRACT: configuration / start failures return false (never throw
// across @ObjCExport). NSError** out-params handled CF-natively via memScoped.
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
import platform.AVFAudio.AVAudioSessionCategoryOptionDefaultToSpeaker
import platform.AVFAudio.AVAudioSessionCategoryPlayAndRecord
import platform.AVFAudio.AVAudioSessionModeVoiceChat
import platform.AVFAudio.setActive
import platform.Foundation.NSError

private val log = createLogger("audioio", "engine", "ios")

/**
 * Process-wide holder for the shared [AVAudioEngine] + playAndRecord session.
 *
 * Single instance ([SharedAudioEngine.instance]); capture and playback both call
 * [retain] to obtain the running engine and [release] when they tear down. Not
 * intended for concurrent calls — the SDK drives start/stop serially on the
 * orchestrator coroutine.
 */
internal class SharedAudioEngine private constructor() {

    val engine: AVAudioEngine = AVAudioEngine()
    private var users = 0
    private var captureUsers = 0
    private var sessionConfigured = false

    /**
     * True while at least one CAPTURE user holds the shared engine (mic capture is
     * active). The E2 playback adapter reads this at start() to choose its engine:
     * true → attach the player to THIS shared playAndRecord engine (full-duplex
     * AEC); false → play on the standalone .playback engine (no mic permission).
     * Queried + mutated only on the single orchestrator coroutine, like the refcount.
     */
    val isCaptureActive: Boolean get() = captureUsers > 0

    /**
     * Ensures the session is configured + the engine is running, then returns the
     * engine. Returns null on any configuration / start failure (no throw).
     *
     * `prepare()` / `startAndReturnError` raise an uncatchable ObjC NSException on a
     * simulator with no audio I/O route ("inputNode != nullptr || outputNode !=
     * nullptr") — guarded via [enginePrepareGuarded] / [engineStartGuarded] so they
     * degrade to a null return instead of SIGABRT. `users` is bumped ONLY after a
     * clean start, so a soft-fail before the increment leaves the refcount consistent
     * (no leaked retain to release).
     */
    fun retain(): AVAudioEngine? = retainInternal(isCapture = false)

    /**
     * CAPTURE-side retain: same engine acquisition as [retain] but also bumps the
     * capture counter so [isCaptureActive] reads true while the mic holds the engine.
     * The capture counter is bumped ONLY after a clean start (with the total count),
     * so a soft-fail leaves BOTH counters consistent.
     */
    fun retainForCapture(): AVAudioEngine? = retainInternal(isCapture = true)

    private fun retainInternal(isCapture: Boolean): AVAudioEngine? {
        if (!ensureSession()) return null
        if (!engine.running) {
            if (!enginePrepareGuarded(engine) || !startEngine()) return null
        }
        users += 1
        if (isCapture) captureUsers += 1
        log.debug(
            "retain",
            mapOf("users" to users, "captureUsers" to captureUsers, "capture" to isCapture, "running" to engine.running),
        )
        return engine
    }

    /** Releases one PLAYBACK user; stops the engine + deactivates the session at zero. */
    fun release() = releaseInternal(isCapture = false)

    /** Releases one CAPTURE user; also decrements the capture counter. */
    fun releaseForCapture() = releaseInternal(isCapture = true)

    private fun releaseInternal(isCapture: Boolean) {
        if (users == 0) {
            log.debug("release-noop")
            return
        }
        users -= 1
        if (isCapture && captureUsers > 0) captureUsers -= 1
        log.debug("release", mapOf("users" to users, "captureUsers" to captureUsers, "capture" to isCapture))
        if (users > 0) return
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
        return enginePrepareGuarded(engine) && startEngine()
    }

    private fun ensureSession(): Boolean {
        if (sessionConfigured) return true
        val ok = configureSession()
        if (ok) sessionConfigured = true
        return ok
    }

    // startAndReturnError reports an init failure via its NSError out-param, but on a
    // simulator with no audio I/O route it instead raises an uncatchable ObjC
    // NSException ("inputNode != nullptr || outputNode != nullptr"). engineStartGuarded
    // wraps the call in an ObjC @try/@catch so that path degrades to a soft false
    // (logged) instead of SIGABRT.
    private fun startEngine(): Boolean = engineStartGuarded(engine)

    private fun configureSession(): Boolean = memScoped {
        val session = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        val categorySet = session.setCategory(
            AVAudioSessionCategoryPlayAndRecord,
            mode = AVAudioSessionModeVoiceChat,
            options = AVAudioSessionCategoryOptionDefaultToSpeaker,
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
        log.debug("session-configured", mapOf("category" to "playAndRecord", "mode" to "voiceChat"))
        true
    }

    companion object {
        /** Process-wide shared engine — capture + playback attach to this one. */
        val instance: SharedAudioEngine by lazy { SharedAudioEngine() }
    }
}
