// ---------------------------------------------------------------------------
// VoiceAudioPlayback.android.kt — the AudioTrack half of [AndroidVoiceAudio].
//
// Split out of VoiceAudio.android.kt to stay under the 300-line file cap. Lifts
// the proven AudioTrack snippets from AudioPlaybackAdapter.android.kt verbatim:
// streaming track build (USAGE_VOICE_COMMUNICATION + CONTENT_TYPE_SPEECH, mono
// PCM16, WRITE_NON_BLOCKING), drop-oldest [ByteRing] overflow, [PlaybackResampler]
// when the device rate differs, head-position idle check, flush() = track.flush()
// + ring clear. No-throw: typed Boolean start result, runCatching on every platform
// call. Owned by [AndroidVoiceAudio] — never used standalone.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.voice.io

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import io.sentient.mobilesdk.audioio.ByteRing
import io.sentient.mobilesdk.audioio.PlaybackResampler
import io.sentient.mobilesdk.log.createLogger
import kotlin.concurrent.Volatile

private const val BYTES_PER_PCM16_SAMPLE = 2
private const val CHANNEL_COUNT = 1

/** Track buffer = this many seconds of audio at the output rate (OS-side jitter buffer). */
private const val TRACK_BUFFER_SECONDS = 0.5

/** Pre-allocated overflow ring = ~2s of audio (matches webui's worklet ring). */
private const val RING_SECONDS = 2.0

/**
 * The AudioTrack half of [AndroidVoiceAudio]. ONE track per start/stop run; [enqueue]
 * is non-blocking and the OS owns the render thread, so no coroutine scope is needed.
 * Typed [start] result so [AndroidVoiceAudio.configure] can surface [VoiceAudioState.Phase.Error]
 * on a failed open (T4 lesson — never silent Ready).
 */
internal class VoiceAudioPlayback {
    private val log = createLogger("voice", "engine", "android", "playback")

    @Volatile private var track: AudioTrack? = null
    @Volatile private var resampler: PlaybackResampler? = null
    private val overflow = ByteRing(0)
    @Volatile private var enqueuedBytes = 0L

    /** Returns true on success; false on build/play failure (proven no-throw pattern). */
    fun start(rate: Int): Boolean {
        val built =
            runCatching { buildTrack(rate) }.getOrElse { e ->
                log.error("track-build-failed", mapOf("cause" to (e.message ?: "unknown")))
                return false
            }
        track = built
        overflow.reset(ringCapacityBytes(rate))
        enqueuedBytes = 0L
        runCatching { built.play() }.onFailure {
            log.error("track-play-failed", mapOf("cause" to (it.message ?: "unknown")))
            teardown(built)
            track = null
            return false
        }
        log.info("track-open", mapOf("trackRate" to rate, "state" to (track?.playState ?: -1)))
        return true
    }

    fun stop() {
        val active = track ?: return
        track = null
        log.info("track-stop", mapOf("enqueuedBytes" to enqueuedBytes))
        overflow.clear()
        teardown(active)
    }

    /** Downlink sink: resample (if needed) → non-blocking write → unaccepted tail to ring. */
    fun enqueue(pcm16: ByteArray) {
        val active = track ?: return
        val bytes = resampler?.resampleLe(pcm16) ?: pcm16
        enqueuedBytes += bytes.size
        runCatching { writeToTrack(active, bytes) }.onFailure {
            log.error("play-frame-failed", mapOf("cause" to (it.message ?: "unknown"), "bytes" to bytes.size))
        }
    }

    /** Flush queued playback (barge-in / interrupt drop-guard). */
    fun clear() {
        val active = track
        overflow.clear()
        if (active == null) {
            log.debug("flush-noop")
            return
        }
        runCatching { active.flush() }
            .onFailure { log.warn("flush-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        enqueuedBytes = 0L
        log.info("flush-playback", mapOf("reason" to "barge-in/interrupt drop-guard"))
    }

    /**
     * Idle when no track, nothing in the overflow ring, AND the playback head has caught
     * up to every frame written. `flush()` ([clear]) resets both the head and [enqueuedBytes]
     * to keep the comparison consistent across barge-ins. A teardown race on
     * `playbackHeadPosition` degrades to "idle" (no-crash contract).
     */
    val isIdle: Boolean
        get() {
            val active = track ?: return true
            if (!overflow.isEmpty()) return false
            val framesWritten = enqueuedBytes / (BYTES_PER_PCM16_SAMPLE * CHANNEL_COUNT)
            val head =
                runCatching { active.playbackHeadPosition.toLong() and 0xFFFFFFFFL }
                    .getOrElse { return true }
            return head >= framesWritten
        }

    // --- Internals (lifted verbatim from AudioPlaybackAdapter.android.kt) ---

    /** Flushes any pending overflow, then writes [bytes]; unaccepted tail spills to the ring. */
    private fun writeToTrack(active: AudioTrack, bytes: ByteArray) {
        drainOverflow(active)
        val written = active.write(bytes, 0, bytes.size, AudioTrack.WRITE_NON_BLOCKING)
        if (written in 0 until bytes.size) {
            val spilled = bytes.size - written
            overflow.push(bytes, written, spilled)
            log.debug(
                "playback-spill",
                mapOf("written" to written, "spilled" to spilled, "ringDepth" to overflow.size()),
            )
        } else if (written < 0) {
            log.warn("playback-write-error", mapOf("code" to written))
        }
    }

    /** Tries to push queued overflow back into the track (front of stream). */
    private fun drainOverflow(active: AudioTrack) {
        if (overflow.isEmpty()) return
        val pending = overflow.drainAll()
        val written = active.write(pending, 0, pending.size, AudioTrack.WRITE_NON_BLOCKING)
        if (written in 0 until pending.size) overflow.push(pending, written, pending.size - written)
    }

    private fun ringCapacityBytes(rate: Int): Int =
        (rate * RING_SECONDS).toInt() * CHANNEL_COUNT * BYTES_PER_PCM16_SAMPLE

    private fun buildTrack(sampleRate: Int): AudioTrack {
        val minBuffer =
            AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        require(minBuffer > 0) { "getMinBufferSize rejected rate=$sampleRate (err=$minBuffer)" }
        val bufferBytes =
            maxOf(minBuffer, (sampleRate * TRACK_BUFFER_SECONDS).toInt() * BYTES_PER_PCM16_SAMPLE)
        val attributes = buildAudioAttributes()
        val format = buildAudioFormat(sampleRate)
        val built =
            AudioTrack(
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
        resampler =
            if (built.sampleRate != sampleRate) {
                log.warn("rate-mismatch", mapOf("requested" to sampleRate, "trackRate" to built.sampleRate))
                PlaybackResampler(sampleRate, built.sampleRate)
            } else {
                null
            }
        return built
    }

    /** Voice-comms usage + speech content type — the AEC-friendly attribute pair. */
    private fun buildAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    /** Mono PCM16 at [sampleRate] — the track's data format. */
    private fun buildAudioFormat(sampleRate: Int): AudioFormat =
        AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()

    private fun teardown(active: AudioTrack) {
        runCatching { active.stop() }
            .onFailure { log.warn("track-stop-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        runCatching { active.release() }
            .onFailure { log.warn("track-release-failed", mapOf("cause" to (it.message ?: "unknown"))) }
        resampler = null
    }
}
