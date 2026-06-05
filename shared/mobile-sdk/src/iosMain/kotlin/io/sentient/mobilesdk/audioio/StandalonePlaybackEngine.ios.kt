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
// stops it + (when no shared capture holds the session) deactivates the .playback
// session. Single-user (only E2 playback uses it) — no refcount needed. Driven
// serially on the orchestrator coroutine.
//
// PROCESS-WIDE SESSION (straddle): AVAudioSession.sharedInstance() is ONE singleton
// shared with [SharedAudioEngine]. If text-chat TTS runs here and the user then
// opens the mic, the shared playAndRecord engine owns capture on that same session.
// [release] then STOPS this engine but DEFERS setActive(false) to the shared engine
// (skip while [SharedAudioEngine.isCaptureActive]). The category is set once but
// setActive(true) is RE-ASSERTED on every [acquire], so an external deactivation can
// never permanently short-circuit the next playback run.
//
// NO-CRASH CONTRACT: prepare()/start() are DEFERRED to [ensureRunning] AFTER the
// adapter connects the player to mainMixerNode; the same ObjC @try/@catch shims
// ([enginePrepareGuarded]/[engineStartGuarded]) guard them there, so a missing route
// on a non-empty graph degrades to a logged false instead of SIGABRT. Calling
// prepare()/start() on an empty graph (no nodes) trips the AVAudioEngine precondition
// on a real device → NSException (swallowed) → silent TTS, so we do NOT do it in
// [acquire]. ensureSession's NSError** is handled via memScoped.
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

    // Category is set once; SESSION-ACTIVE is re-asserted on every acquire. Splitting
    // the two means an external setActive(false) (e.g. the shared capture engine's
    // release, or any straddle teardown) can never permanently short-circuit us — the
    // next acquire idempotently re-activates the session via [ensureSession].
    private var categoryConfigured = false
    private var active = false

    /**
     * Configures the .playback session and returns the engine WITHOUT preparing or
     * starting it. Calling prepare()/start() on an empty graph (no nodes attached)
     * trips the AVAudioEngine precondition on a real device — the resulting NSException
     * is swallowed by the ObjC @try/@catch shim but the engine is left in a broken
     * state, causing every TTS frame to be silently dropped.
     *
     * The adapter connects the player node to mainMixerNode AFTER this call, then
     * invokes [ensureRunning] to prepare+start the non-empty graph. [ensureRunning] is
     * the single prepare/start path — its ObjC shims guard against a missing route on
     * a real device, degrading to a logged false instead of SIGABRT.
     *
     * Returns null only on session-config failure (category set or setActive failed).
     */
    fun acquire(): AVAudioEngine? {
        if (!ensureSession()) return null
        active = true
        log.debug("acquire", mapOf("running" to engine.running, "deferredStart" to true))
        return engine
    }

    /**
     * Stops the engine + (when no shared capture holds the process-wide session)
     * deactivates the .playback session. Idempotent.
     *
     * STRADDLE GUARD: [AVAudioSession.sharedInstance] is ONE process-wide singleton.
     * If text-chat TTS started on this standalone engine and the user then opened the
     * mic, the shared playAndRecord engine now owns capture on that same session. A
     * `setActive(false)` here would deactivate the session out from under the active
     * shared engine. So when [SharedAudioEngine.isCaptureActive] is true, we STOP this
     * engine but DEFER session deactivation to the shared engine's own release.
     */
    fun release() {
        if (!active) {
            log.debug("release-noop")
            return
        }
        active = false
        val captureActive = SharedAudioEngine.instance.isCaptureActive
        runCatching {
            if (engine.running) engine.stop()
            if (captureActive) {
                log.info(
                    "session-deactivate-skipped",
                    mapOf("reason" to "shared capture owns process-wide session", "captureActive" to true),
                )
            } else {
                AVAudioSession.sharedInstance().setActive(false, null)
            }
        }.onFailure { log.warn("teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        // Category stays configured; the next acquire re-asserts setActive(true) so an
        // external deactivation never permanently short-circuits us.
        log.info("engine-stopped", mapOf("sessionDeactivated" to !captureActive))
    }

    /** Restarts the engine if a render-graph change (attach/connect) stopped it. */
    fun ensureRunning(): Boolean {
        if (engine.running) return true
        return enginePrepareGuarded(engine) && engineStartGuarded(engine)
    }

    /**
     * Sets the .playback category once, then ALWAYS re-asserts setActive(true).
     * Re-activation is idempotent on iOS and recovers from an external deactivation
     * (the straddle case) without crashing — a failed re-activate degrades to false.
     */
    private fun ensureSession(): Boolean = memScoped {
        val session = AVAudioSession.sharedInstance()
        val errVar = alloc<kotlinx.cinterop.ObjCObjectVar<NSError?>>()
        if (!categoryConfigured) {
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
            categoryConfigured = true
            log.debug("session-category-set", mapOf("category" to "playback", "mode" to "default"))
        }
        val activated = session.setActive(true, errVar.ptr)
        if (!activated) {
            log.warn("session-activate-failed", mapOf("error" to (errVar.value?.localizedDescription ?: "unknown")))
            return@memScoped false
        }
        log.debug("session-active", mapOf("category" to "playback", "reasserted" to true))
        true
    }

    companion object {
        /** Process-wide standalone playback engine — E2 uses this when mic is inactive. */
        val instance: StandalonePlaybackEngine by lazy { StandalonePlaybackEngine() }
    }
}
