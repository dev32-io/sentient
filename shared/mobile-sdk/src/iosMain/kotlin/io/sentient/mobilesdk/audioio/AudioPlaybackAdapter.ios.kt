// ---------------------------------------------------------------------------
// AudioPlaybackAdapter.ios.kt — AVAudioPlayerNode-backed assistant PCM playback.
//
// Attaches an AVAudioPlayerNode to the SHARED AVAudioEngine ([SharedAudioEngine])
// — the SAME engine E1's capture uses — so the voice-processing IO unit gets the
// speaker render reference for full-duplex AEC (see SharedAudioEngine.ios.kt).
// Connects the player → main mixer at a float32 mono format whose sample rate is
// the gateway-negotiated output rate (48000 from start(sampleRate)); the PCM16 LE
// downlink maps 1:1 to float frames (Pcm16FloatBuffer), no resample needed.
//
// Lifecycle:
//   start(rate)  = attach + connect the player to the shared engine, ensure the
//                  engine is running, play() the node.
//   enqueue(pcm) = PCM16 LE → float AVAudioPCMBuffer → scheduleBuffer (the player
//                  owns its internal queue; scheduled buffers stream in order).
//   clear()      = playerNode.stop() (flushes scheduled buffers) then play()
//                  again so the next stream resumes — barge-in drop-guard.
//   stop()       = stop + detach the player, release the shared engine.
//
// R2 (downlink encoding): this adapter ONLY plays PCM16 LE. The encoding gate
// (assert encoding == "pcm16", WARN+flag on opus) is wired in the E3 pipeline,
// not here — opus decode is DEFERRED.
//
// NO-CRASH CONTRACT (error-handling rule): attach / schedule failures log
// WARN/ERROR and degrade — never throw across @ObjCExport (which K/N traps as
// SIGABRT). enqueue/clear on an absent player no-op.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.cinterop.ExperimentalForeignApi::class)

package io.sentient.mobilesdk.audioio

import io.sentient.mobilesdk.log.createLogger
import kotlinx.cinterop.ExperimentalForeignApi
import platform.AVFAudio.AVAudioEngine
import platform.AVFAudio.AVAudioFormat
import platform.AVFAudio.AVAudioPlayerNode
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "playback", "ios")

private const val MONO_CHANNELS = 1u

/**
 * iOS [AudioPlaybackAdapter] backed by an [AVAudioPlayerNode] on the shared
 * [AVAudioEngine]. One player per [start]/[stop] run.
 */
class IosAudioPlaybackAdapter : AudioPlaybackAdapter {

    private val shared = SharedAudioEngine.instance

    @Volatile
    private var player: AVAudioPlayerNode? = null

    @Volatile
    private var playerFormat: AVAudioFormat? = null

    private var enqueuedBytes = 0L

    override suspend fun start(sampleRate: Int) {
        if (player != null) {
            log.debug("start-already-active", mapOf("sampleRate" to sampleRate))
            return
        }
        log.info("start", mapOf("sampleRate" to sampleRate))
        val engine = shared.retain() ?: run {
            log.error("start-failed", mapOf("reason" to "shared engine unavailable"))
            return
        }
        val started = runCatching { attachAndPlay(engine, sampleRate) }.getOrElse { e ->
            log.error("start-failed", mapOf("reason" to "exception", "cause" to (e.message ?: "unknown")))
            false
        }
        if (!started) shared.release()
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
        runCatching {
            node.scheduleBuffer(buffer, completionHandler = null)
            if (!node.playing) node.play()
        }.onFailure { log.error("enqueue-schedule-failed", mapOf("cause" to (it.message ?: "unknown"), "bytes" to pcm16.size)) }
    }

    override fun clear() {
        val node = player ?: run {
            log.debug("clear-noop")
            return
        }
        runCatching {
            node.stop() // flushes scheduled buffers
            if (shared.ensureRunning()) node.play() // resume for the next stream
        }.onFailure { log.warn("clear-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        log.info("clear", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    override suspend fun stop() {
        val node = player ?: run {
            log.debug("stop-noop")
            return
        }
        player = null
        playerFormat = null
        log.info("stop", mapOf("enqueuedBytes" to enqueuedBytes))
        runCatching {
            node.stop()
            shared.engine.detachNode(node)
        }.onFailure { log.warn("stop-teardown-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        shared.release()
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** Attaches + connects the player to [engine] at [sampleRate] and starts it. */
    private fun attachAndPlay(engine: AVAudioEngine, sampleRate: Int): Boolean {
        val format = AVAudioFormat(
            standardFormatWithSampleRate = sampleRate.toDouble(),
            channels = MONO_CHANNELS,
        )
        val node = AVAudioPlayerNode()
        engine.attachNode(node)
        engine.connect(node, to = engine.mainMixerNode, format = format)
        if (!shared.ensureRunning()) {
            engine.detachNode(node)
            log.error("start-failed", mapOf("reason" to "engine not running after connect"))
            return false
        }
        node.play()
        player = node
        playerFormat = format
        enqueuedBytes = 0L
        log.info("session-open", mapOf("playerRate" to sampleRate, "playing" to node.playing))
        return true
    }
}
