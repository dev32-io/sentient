// ---------------------------------------------------------------------------
// AudioPlaybackAdapter.ios.kt — AVAudioPlayerNode-backed assistant PCM playback.
//
// TWO ENGINE PATHS, chosen at start() by whether mic capture is active
// (SharedAudioEngine.isCaptureActive):
//   • CAPTURE ACTIVE (VOICE MODE) → attach the player to the SHARED AVAudioEngine
//     ([SharedAudioEngine], .playAndRecord/voiceChat) — the SAME engine E1's
//     capture uses — so the voice-processing IO unit gets the speaker render
//     reference for full-duplex AEC. Unchanged behavior; barge-in/echo-gate intact.
//   • CAPTURE INACTIVE (TEXT CHAT / voice off) → play on a STANDALONE .playback
//     engine ([StandalonePlaybackEngine]). .playback needs NO mic permission, so
//     TTS is audible on a text chat that never prompted for the mic. (The real
//     device bug: routing text-chat TTS through the shared playAndRecord engine
//     fails prepare() with "no audio I/O route" → every frame dropped → silent.)
//
// Connects the player → main mixer at a float32 mono format whose sample rate is
// the gateway-negotiated output rate (from start(sampleRate)); the PCM16 LE
// downlink maps 1:1 to float frames (Pcm16FloatBuffer), no resample needed.
//
// Lifecycle:
//   start(rate)  = pick the backend, attach + connect the player, ensure the
//                  engine is running, play() the node.
//   enqueue(pcm) = PCM16 LE → float AVAudioPCMBuffer → scheduleBuffer (the player
//                  owns its internal queue; scheduled buffers stream in order).
//   clear()      = playerNode.stop() (flushes scheduled buffers) then play()
//                  again so the next stream resumes — barge-in drop-guard.
//   stop()       = stop + detach the player, release the chosen engine.
//
// MID-TTS MIC EDGE (straddle): the backend is latched at start() and NEVER migrated
// mid-stream. If text-chat TTS is playing on the standalone engine and the user then
// starts the mic, the in-flight TTS stays on the standalone engine (no migration).
// AVAudioSession.sharedInstance() is ONE process-wide singleton, NOT two coexisting
// sessions — so when the standalone TTS later release()s, it DEFERS setActive(false)
// to the shared engine while capture is active (skips deactivation when
// SharedAudioEngine.isCaptureActive). The shared engine, in turn, re-asserts
// setActive(true) on every retain, so the needing path always re-activates the
// session even after an external deactivation. The NEXT downlink cycle re-decides and
// (with capture now active) takes the shared AEC path. Simple + no crash; brief AEC
// absence only on the tail of the one straddling utterance.
//
// R2 (downlink encoding): this adapter ONLY plays PCM16 LE. The encoding gate
// (assert encoding == "pcm16", WARN+flag on opus) is wired in the E3 pipeline,
// not here — opus decode is DEFERRED.
//
// NO-CRASH CONTRACT (error-handling rule): both engines' prepare()/start() use
// the SAME ObjC @try/@catch guards (enginePrepareGuarded/engineStartGuarded);
// attach / schedule failures log WARN/ERROR and degrade — never throw across
// @ObjCExport (which K/N traps as SIGABRT). enqueue/clear on an absent player no-op.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPlayerNode
import kotlin.concurrent.AtomicInt
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "playback", "ios")

private const val MONO_CHANNELS = 1u

private const val PATH_SHARED = "shared"
private const val PATH_STANDALONE = "standalone"

/**
 * iOS [AudioPlaybackAdapter] backed by an [AVAudioPlayerNode]. The host engine is
 * selected per [start] run: the shared playAndRecord engine when mic capture is
 * active (voice mode, full-duplex AEC) or a standalone .playback engine when it is
 * not (text chat, no mic permission). One player per [start]/[stop] run.
 */
class IosAudioPlaybackAdapter : AudioPlaybackAdapter {

    private val shared = SharedAudioEngine.instance
    private val standalone = StandalonePlaybackEngine.instance

    @Volatile
    private var player: AVAudioPlayerNode? = null

    @Volatile
    private var playerFormat: AVAudioFormat? = null

    // Which backend the active player is attached to ("shared" | "standalone").
    // Latched at start(), read by ensureRunning()/teardown so enqueue/clear/stop
    // route to the SAME engine the player was attached to (no mid-stream migration).
    @Volatile
    private var backend: String? = null

    private var enqueuedBytes = 0L

    // Outstanding scheduled buffers that have NOT yet finished playing. Incremented
    // per enqueue, decremented in each buffer's completion handler (fires when the
    // player has consumed/played that buffer). `isPlaybackIdle` reads this so the
    // pipeline can hold "speaking" until the speaker tail physically drains.
    // The completion handler runs on an audio render thread, so the counter is atomic.
    private val outstanding = AtomicInt(0)

    // Generation guard: bumped on start/clear/stop. A buffer's completion only
    // decrements if its capture-time epoch still matches, so flushed (barge-in) or
    // torn-down buffers can't underflow the count for a fresh stream.
    private val playbackEpoch = AtomicInt(0)

    /** Idle when there is no player, or every scheduled buffer has finished playing. */
    override val isPlaybackIdle: Boolean
        get() = player == null || outstanding.value == 0

    /** Bump the generation + zero the in-flight count (new stream / flush / teardown). */
    private fun resetPlaybackCount() {
        playbackEpoch.incrementAndGet()
        outstanding.value = 0
    }

    override suspend fun start(sampleRate: Int) {
        if (player != null) {
            log.debug("start-already-active", mapOf("sampleRate" to sampleRate))
            return
        }
        // Decide the engine by whether mic capture currently holds the shared engine.
        // Voice mode starts the mic BEFORE TTS, so capture is active here → shared
        // AEC path. Text chat never starts the mic → standalone .playback path.
        val useShared = shared.isCaptureActive
        val path = if (useShared) PATH_SHARED else PATH_STANDALONE
        log.info(
            "start",
            mapOf("sampleRate" to sampleRate, "path" to path, "category" to sessionCategoryFor(useShared)),
        )
        val engine = acquireEngine(useShared) ?: run {
            log.error("start-failed", mapOf("reason" to "engine unavailable", "path" to path))
            return
        }
        val started = runCatching { attachAndPlay(engine, sampleRate, useShared) }.getOrElse { e ->
            log.error("start-failed", mapOf("reason" to "exception", "path" to path, "cause" to (e.message ?: "unknown")))
            false
        }
        if (started) {
            backend = path
            resetPlaybackCount() // fresh stream — zero the in-flight buffer count
        } else {
            releaseBackend(useShared)
        }
    }

    override fun enqueue(pcm16: ByteArray) {
        val node = player
        val format = playerFormat
        if (node == null || format == null) {
            log.warn("enqueue-no-player", mapOf("reason" to "start() not called or failed", "bytes" to pcm16.size))
            return
        }
        val buffer = pcm16ToFloatBuffer(pcm16, format)
        if (buffer == null) {
            log.warn("enqueue-empty", mapOf("bytes" to pcm16.size))
            return
        }
        enqueuedBytes += pcm16.size
        val epochAtSchedule = playbackEpoch.value
        outstanding.incrementAndGet()
        runCatching {
            node.scheduleBuffer(buffer, completionHandler = {
                // Fired when the player finished with this buffer. Ignore completions
                // from a flushed/torn-down generation so a stale buffer can't underflow
                // the count for a fresh stream.
                if (playbackEpoch.value == epochAtSchedule) outstanding.decrementAndGet()
            })
            if (!node.playing) node.play()
        }.onFailure {
            if (playbackEpoch.value == epochAtSchedule) outstanding.decrementAndGet() // undo: never scheduled
            log.error("enqueue-schedule-failed", mapOf("cause" to (it.message ?: "unknown"), "bytes" to pcm16.size))
        }
    }

    override fun clear() {
        val node = player ?: run {
            log.debug("clear-noop")
            return
        }
        // backend nulled by a concurrent/prior stop() means teardown is in flight —
        // bail before ensureRunning() can prepare()/start() the engine back to life.
        if (backend == null) {
            log.debug("clear-noop", mapOf("reason" to "backend already released (teardown in flight)"))
            return
        }
        resetPlaybackCount() // flushed → no buffers in flight; ignore the flushed completions
        runCatching {
            node.stop() // flushes scheduled buffers
            if (ensureRunning()) node.play() // resume for the next stream
        }.onFailure { log.warn("clear-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        log.info("clear", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    override suspend fun stop() {
        val node = player ?: run {
            log.debug("stop-noop")
            return
        }
        val onShared = backend == PATH_SHARED
        player = null
        playerFormat = null
        backend = null
        resetPlaybackCount() // teardown — drop any in-flight count (player is detached)
        log.info("stop", mapOf("enqueuedBytes" to enqueuedBytes, "path" to if (onShared) PATH_SHARED else PATH_STANDALONE))
        runCatching {
            node.stop()
            engineFor(onShared).detachNode(node)
        }.onFailure { log.warn("stop-teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        releaseBackend(onShared)
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** Attaches + connects the player to [engine] at [sampleRate] and starts it. */
    private fun attachAndPlay(engine: AVAudioEngine, sampleRate: Int, useShared: Boolean): Boolean {
        val format = AVAudioFormat(
            standardFormatWithSampleRate = sampleRate.toDouble(),
            channels = MONO_CHANNELS,
        )
        val node = AVAudioPlayerNode()
        engine.attachNode(node)
        engine.connect(node, to = engine.mainMixerNode, format = format)
        // Attaching/connecting can stop the render graph; restart on the SAME engine.
        if (!ensureRunningOn(useShared)) {
            engine.detachNode(node)
            log.error(
                "start-failed",
                mapOf("reason" to "engine not running after connect", "path" to if (useShared) PATH_SHARED else PATH_STANDALONE),
            )
            return false
        }
        node.play()
        player = node
        playerFormat = format
        enqueuedBytes = 0L
        log.info("session-open", mapOf("playerRate" to sampleRate, "playing" to node.playing, "path" to if (useShared) PATH_SHARED else PATH_STANDALONE))
        return true
    }

    /** Acquires the chosen backend engine (retain shared, or acquire standalone). */
    private fun acquireEngine(useShared: Boolean): AVAudioEngine? =
        if (useShared) shared.retain() else standalone.acquire()

    /** Releases the chosen backend engine (mirrors [acquireEngine]). */
    private fun releaseBackend(useShared: Boolean) {
        if (useShared) shared.release() else standalone.release()
    }

    /** The AVAudioEngine for the chosen backend. */
    private fun engineFor(useShared: Boolean): AVAudioEngine =
        if (useShared) shared.engine else standalone.engine

    /** Restarts the active backend's engine if a graph change stopped it. */
    private fun ensureRunning(): Boolean = ensureRunningOn(backend == PATH_SHARED)

    private fun ensureRunningOn(useShared: Boolean): Boolean =
        if (useShared) shared.ensureRunning() else standalone.ensureRunning()

    /** Log-only label for the session category each backend opens. */
    private fun sessionCategoryFor(useShared: Boolean): String =
        if (useShared) "playAndRecord" else "playback"
}
