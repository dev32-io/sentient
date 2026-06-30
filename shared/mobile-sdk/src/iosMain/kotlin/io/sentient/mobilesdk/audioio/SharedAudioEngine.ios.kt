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
// Lifecycle: capture and playback are independent users of the engine. retain()
// configures+activates the session but does NOT start the engine — the caller
// attaches its node (input tap / player) then calls ensureRunning(), which is the
// single prepare/start path (a prepare on an EMPTY graph throws on a real device).
// The engine stays running while EITHER side is active; stop() from one side does
// NOT tear the engine down while the other holds it.
// retain()/release() reference-count the two users; the engine + session are
// stopped only when the count reaches zero. The .playAndRecord category is set
// once, but setActive(true) is RE-ASSERTED on every retain so an external
// deactivation (e.g. an in-flight standalone playback engine releasing during the
// straddle) can never permanently short-circuit the shared engine's activation.
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
import platform.AVFAudio.AVAudioSessionPortOverrideSpeaker
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

    // Category is set once; SESSION-ACTIVE is re-asserted on every retain. Splitting
    // the two means an external setActive(false) — e.g. an in-flight standalone
    // playback engine releasing during the straddle — can never permanently short-
    // circuit the shared engine: the next retain idempotently re-activates the session.
    private var categoryConfigured = false

    /**
     * True while at least one CAPTURE user holds the shared engine (mic capture is
     * active). The E2 playback adapter reads this at start() to choose its engine:
     * true → attach the player to THIS shared playAndRecord engine (full-duplex
     * AEC); false → play on the standalone .playback engine (no mic permission).
     * Queried + mutated only on the single orchestrator coroutine, like the refcount.
     */
    val isCaptureActive: Boolean get() = captureUsers > 0

    /**
     * Configures + activates the shared session and returns the engine WITHOUT
     * preparing/starting it — the render graph is EMPTY at retain (see [retainInternal]).
     * The caller attaches its node (player) then calls [ensureRunning], the single
     * prepare/start path on a non-empty graph. Returns null only on session-config
     * failure (no throw).
     */
    fun retain(): AVAudioEngine? = retainInternal(isCapture = false)

    /**
     * CAPTURE-side retain: same engine acquisition as [retain] but also bumps the
     * capture counter so [isCaptureActive] reads true while the mic holds the engine.
     * Both counters bump only after [ensureSession] succeeds (no eager start), so a
     * session-config soft-fail leaves BOTH counters consistent. The capture adapter
     * installs its input tap, then calls [ensureRunning] to prepare/start the graph.
     */
    fun retainForCapture(): AVAudioEngine? = retainInternal(isCapture = true)

    private fun retainInternal(isCapture: Boolean): AVAudioEngine? {
        if (!ensureSession()) return null
        // DO NOT prepare()/start() here. The render graph is still EMPTY at retain — the
        // input tap (capture) / player node (playback) is attached by the caller AFTER
        // this returns. prepare()/start() on an empty graph trips the AVAudioEngine
        // precondition on a REAL device → an NSException the ObjC guard swallows → the
        // shared engine silently never runs → mic dead / TTS silent. Both callers invoke
        // [ensureRunning] after attaching their node (tap install / player connect), which
        // is the single prepare/start path on a NON-empty graph — mirroring
        // [StandalonePlaybackEngine.acquire]. (Same NSException the E5 sim fix guarded;
        // the real-device empty-graph case was the live mic-not-capturing bug.)
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
        // Category stays configured; the next retain re-asserts setActive(true).
        log.info("engine-stopped")
    }

    /** Restarts the engine if a render-graph change (attach/connect) stopped it. */
    fun ensureRunning(): Boolean {
        if (engine.running) return true
        return enginePrepareGuarded(engine) && startEngine()
    }

    /**
     * Sets the playAndRecord category once, then ALWAYS re-asserts setActive(true).
     * Re-activation is idempotent on iOS and recovers the session after an external
     * deactivation (e.g. a straddling standalone-playback release) — a failed
     * re-activate degrades to false (logged warn), never a throw.
     */
    private fun ensureSession(): Boolean = configureSession()

    // startAndReturnError reports an init failure via its NSError out-param, but on a
    // simulator with no audio I/O route it instead raises an uncatchable ObjC
    // NSException ("inputNode != nullptr || outputNode != nullptr"). engineStartGuarded
    // wraps the call in an ObjC @try/@catch so that path degrades to a soft false
    // (logged) instead of SIGABRT.
    private fun startEngine(): Boolean = engineStartGuarded(engine)

    private fun configureSession(): Boolean = memScoped {
        val session = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        if (!categoryConfigured) {
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
            categoryConfigured = true
            log.debug("session-category-set", mapOf("category" to "playAndRecord", "mode" to "voiceChat"))
        }
        val activated = session.setActive(true, errVar.ptr)
        if (!activated) {
            log.warn("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        // Force the LOUD bottom speaker. The .voiceChat mode otherwise routes to the
        // earpiece/receiver (and overrides the defaultToSpeaker option) — this is the
        // canonical speakerphone toggle and keeps the voice-processing AEC intact, so
        // barge-in still works. Re-asserted on every retain so a route change after an
        // interruption re-forces the speaker. Non-fatal if it fails (stays on receiver).
        val routed = session.overrideOutputAudioPort(AVAudioSessionPortOverrideSpeaker, errVar.ptr)
        if (!routed) {
            log.warn("session-speaker-override-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
        }
        log.debug("session-active", mapOf("category" to "playAndRecord", "override" to "speaker", "reasserted" to true))
        true
    }

    companion object {
        /** Process-wide shared engine — capture + playback attach to this one. */
        val instance: SharedAudioEngine by lazy { SharedAudioEngine() }
    }
}
