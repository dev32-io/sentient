// ---------------------------------------------------------------------------
// AudioPlaybackAdapter.android.kt — AudioTrack-backed assistant PCM playback.
//
// Streaming-mode AudioTrack on the voice-communication path
// (USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH), so the downlink pairs with
// the capture-side AEC (AcousticEchoCanceler in E1) for full-duplex barge-in.
// Mono PCM16 LE at the gateway-negotiated output rate (48000 per session.ready
// outputSampleRate, taken from start(sampleRate)).
//
// Lifecycle (mirrors web-sdk's audio-output adapter ROLE):
//   start(rate)   = configure + AudioTrack.play() (streaming mode).
//   enqueue(pcm)  = AudioTrack.write(...) the LE bytes. Non-blocking
//                   (WRITE_NON_BLOCKING): the OS owns its buffer; if the track
//                   is momentarily full the unwritten tail is queued into a
//                   pre-allocated ~2s ring (drop-oldest on overflow, like the
//                   webui 96KB worklet ring) and flushed on the next write.
//   clear()       = AudioTrack.flush() — drops queued PCM, keeps the track open
//                   (barge-in / interrupt drop-guard).
//   stop()        = stop + release.
//
// RESAMPLE: if the device output rate differs from the enqueued rate we linear-
// resample to the track rate (Pcm16Resampler from E1). Downlink is 48k; modern
// hardware accepts 48k mono natively, so this is the rare path.
//
// R2 (downlink encoding): this adapter ONLY plays PCM16 LE. The encoding gate
// (assert encoding == "pcm16", WARN+flag on opus) is wired in the E3 pipeline,
// not here — opus decode is DEFERRED.
//
// NO-CRASH CONTRACT (error-handling rule): a configure/write failure (output
// unavailable, bad rate, dead object) logs WARN/ERROR and degrades — it never
// throws (a throw across the @ObjCExport boundary would SIGABRT). enqueue/clear
// on an absent track no-op.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.audioio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import io.sentient.mobilesdk.log.createLogger
import kotlin.concurrent.Volatile

private val log = createLogger("audioio", "playback", "android")

private const val BYTES_PER_PCM16_SAMPLE = 2
private const val CHANNEL_COUNT = 1

/** Track buffer = this many seconds of audio at the output rate (OS-side jitter buffer). */
private const val TRACK_BUFFER_SECONDS = 0.5

/** Pre-allocated overflow ring = ~2s of audio (matches webui's generous worklet ring). */
private const val RING_SECONDS = 2.0

/**
 * Android [AudioPlaybackAdapter] backed by a streaming [AudioTrack].
 *
 * Single track per [start]/[stop] run. [enqueue] / [clear] are called from the
 * E3 playback pipeline; writes are non-blocking and the OS owns the render
 * thread, so no coroutine scope is needed here.
 */
class AndroidAudioPlaybackAdapter : AudioPlaybackAdapter {

    @Volatile
    private var track: AudioTrack? = null

    @Volatile
    private var trackRate: Int = 0

    /** Resampler when the enqueued rate differs from the track rate (null = pass-through). */
    @Volatile
    private var resampler: PlaybackResampler? = null

    /** Pre-allocated drop-oldest overflow ring for bytes AudioTrack couldn't accept yet. */
    private val overflow = ByteRing(0)

    private var enqueuedBytes = 0L

    override suspend fun start(sampleRate: Int) {
        if (track != null) {
            log.debug("start-already-active", mapOf("sampleRate" to sampleRate))
            return
        }
        log.info("start", mapOf("sampleRate" to sampleRate))
        val built = runCatching { buildTrack(sampleRate) }.getOrElse { e ->
            log.error("start-failed", mapOf("reason" to "build", "cause" to (e.message ?: "unknown")))
            null
        } ?: return
        track = built
        trackRate = sampleRate
        overflow.reset(ringCapacityBytes(sampleRate))
        enqueuedBytes = 0L
        runCatching { built.play() }.onFailure {
            log.error("start-play-failed", mapOf("cause" to (it.message ?: "unknown")))
            teardown(built)
            track = null
        }
        log.info("session-open", mapOf("trackRate" to sampleRate, "state" to (track?.playState ?: -1)))
    }

    override fun enqueue(pcm16: ByteArray) {
        val active = track
        if (active == null) {
            log.warn("enqueue-no-track", mapOf("reason" to "start() not called or failed", "bytes" to pcm16.size))
            return
        }
        val bytes = resampler?.resampleLe(pcm16) ?: pcm16
        enqueuedBytes += bytes.size
        runCatching { writeToTrack(active, bytes) }.onFailure {
            log.error("enqueue-write-failed", mapOf("cause" to (it.message ?: "unknown"), "bytes" to bytes.size))
        }
    }

    override fun clear() {
        val active = track ?: run {
            log.debug("clear-noop")
            return
        }
        overflow.clear()
        runCatching { active.flush() }.onFailure { log.warn("clear-flush-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        log.info("clear", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    override suspend fun stop() {
        val active = track ?: run {
            log.debug("stop-noop")
            return
        }
        track = null
        log.info("stop", mapOf("enqueuedBytes" to enqueuedBytes))
        overflow.clear()
        teardown(active)
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /** Flushes any pending overflow, then writes [bytes]; unaccepted tail spills to the ring. */
    private fun writeToTrack(active: AudioTrack, bytes: ByteArray) {
        drainOverflow(active)
        val written = writeNonBlocking(active, bytes, 0, bytes.size)
        if (written in 0 until bytes.size) {
            val spilled = bytes.size - written
            overflow.push(bytes, written, spilled)
            log.debug("enqueue-spill", mapOf("written" to written, "spilled" to spilled, "ringDepth" to overflow.size()))
        } else if (written < 0) {
            log.warn("enqueue-write-error", mapOf("code" to written))
        }
    }

    /** Tries to push queued overflow back into the track (front of stream). */
    private fun drainOverflow(active: AudioTrack) {
        if (overflow.isEmpty()) return
        val pending = overflow.drainAll()
        val written = writeNonBlocking(active, pending, 0, pending.size)
        if (written in 0 until pending.size) overflow.push(pending, written, pending.size - written)
    }

    private fun writeNonBlocking(active: AudioTrack, src: ByteArray, offset: Int, count: Int): Int =
        active.write(src, offset, count, AudioTrack.WRITE_NON_BLOCKING)

    private fun ringCapacityBytes(rate: Int): Int =
        (rate * RING_SECONDS).toInt() * CHANNEL_COUNT * BYTES_PER_PCM16_SAMPLE

    private fun buildTrack(sampleRate: Int): AudioTrack {
        val minBuffer = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minBuffer > 0) { "getMinBufferSize rejected rate=$sampleRate (err=$minBuffer)" }
        val bufferBytes = maxOf(minBuffer, (sampleRate * TRACK_BUFFER_SECONDS).toInt() * BYTES_PER_PCM16_SAMPLE)

        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val format = AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()

        val built = AudioTrack(
            attributes,
            format,
            bufferBytes,
            AudioTrack.MODE_STREAM,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
        if (built.state != AudioTrack.STATE_INITIALIZED) {
            built.release()
            error("AudioTrack failed to initialise (state=${built.state}, rate=$sampleRate)")
        }
        resampler = if (built.sampleRate != sampleRate) {
            log.warn("rate-mismatch", mapOf("requested" to sampleRate, "trackRate" to built.sampleRate))
            PlaybackResampler(sampleRate, built.sampleRate)
        } else {
            null
        }
        return built
    }

    private fun teardown(active: AudioTrack) {
        runCatching { active.stop() }.onFailure { log.warn("stop-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        runCatching { active.release() }.onFailure { log.warn("release-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        resampler = null
        log.debug("released")
    }
}
