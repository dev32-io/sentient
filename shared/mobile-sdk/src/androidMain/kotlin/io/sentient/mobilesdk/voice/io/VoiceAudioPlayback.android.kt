// ---------------------------------------------------------------------------
// VoiceAudioPlayback.android.kt — the AudioTrack half of [AndroidVoiceAudio].
//
// Split out of VoiceAudio.android.kt to stay under the 300-line file cap. Lifts
// the proven AudioTrack snippets from the retired Android playback adapter verbatim:
// streaming track build, mono PCM16, WRITE_NON_BLOCKING, drop-oldest [ByteRing]
// overflow, [PlaybackResampler] when the device rate differs, head-position idle
// check, flush() = track.flush() + ring clear. No-throw: typed Boolean start result,
// runCatching on every platform call. Owned by [AndroidVoiceAudio] — never used
// standalone.
//
// AudioAttributes usage is per-[VoiceAudioPath] (S5): [VoiceAudioPath.Manual]
// (hold/idle replies) uses USAGE_ASSISTANT — the media volume stream, loud and
// rocker-controlled; [VoiceAudioPath.Duplex] (continuous) keeps today's
// USAGE_VOICE_COMMUNICATION, unchanged. CONTENT_TYPE_SPEECH is unchanged on both.
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

// Software playback makeup gain — the Android twin of iOS's PLAYBACK_MAKEUP_GAIN.
// Applies uniformly to BOTH paths (S5, spec §7.2 user decision): the Duplex track runs
// USAGE_VOICE_COMMUNICATION (→ STREAM_VOICE_CALL), so the media volume rocker doesn't
// move it and it reads quiet even at max; the Manual track runs USAGE_ASSISTANT on the
// loud media route where ×5.0 will hard-clip loud peaks (accepted for the tuning phase).
// A fixed PCM-domain gain lifts the floor so the device's OWN volume control is
// meaningful. Peaks hard-clamp to Int16. Do NOT normalize per-voice — quiet voices are
// character; this only offsets the route. Was ×3.0; uniform ×5.0 starting point (tune
// on device).
private const val PLAYBACK_MAKEUP_GAIN = 5.0f

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
    fun start(rate: Int, path: VoiceAudioPath): Boolean {
        val built =
            runCatching { buildTrack(rate, path) }.getOrElse { e ->
                log.error("track-build-failed", mapOf("code" to "operation-failure"))
                return false
            }
        track = built
        overflow.reset(ringCapacityBytes(rate))
        enqueuedBytes = 0L
        runCatching { built.play() }.onFailure {
            log.error("track-play-failed", mapOf("code" to "operation-failure"))
            teardown(built)
            track = null
            return false
        }
        log.info(
            "track-open",
            mapOf("trackRate" to rate, "path" to path.name, "usage" to usageFor(path), "state" to (track?.playState ?: -1)),
        )
        return true
    }

    fun stop() {
        val active = track ?: return
        track = null
        log.info("track-stop", mapOf("enqueuedBytes" to enqueuedBytes))
        overflow.clear()
        teardown(active)
    }

    /** Downlink sink: resample (if needed) → makeup gain → non-blocking write → tail to ring. */
    fun enqueue(pcm16: ByteArray) {
        val active = track ?: return
        val rs = resampler
        // resampleLe returns a FRESH array; when null (native-rate, no resample) copy
        // before gain so the makeup multiply never mutates the caller's downlink frame.
        var bytes = rs?.resampleLe(pcm16) ?: pcm16
        if (PLAYBACK_MAKEUP_GAIN != 1.0f) {
            if (rs == null) bytes = pcm16.copyOf()
            applyMakeupGainInPlace(bytes)
        }
        enqueuedBytes += bytes.size
        runCatching { writeToTrack(active, bytes) }.onFailure {
            log.error("play-frame-failed", mapOf("code" to "audio-frame-failure", "bytes" to bytes.size))
        }
    }

    /** Scale each LE PCM16 sample by [PLAYBACK_MAKEUP_GAIN] in place, clamped to Int16. */
    private fun applyMakeupGainInPlace(bytes: ByteArray) {
        var i = 0
        while (i + 1 < bytes.size) {
            val sample = ((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xFF)).toShort()
            val boosted = (sample * PLAYBACK_MAKEUP_GAIN).toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            bytes[i] = (boosted and 0xFF).toByte()
            bytes[i + 1] = ((boosted shr 8) and 0xFF).toByte()
            i += 2
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
            .onFailure { log.warn("flush-failed", mapOf("code" to "operation-failure")) }
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

    // --- Internals (lifted verbatim from the retired Android playback adapter) ---

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

    private fun buildTrack(sampleRate: Int, path: VoiceAudioPath): AudioTrack {
        val minBuffer =
            AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
        require(minBuffer > 0) { "getMinBufferSize rejected rate=$sampleRate (err=$minBuffer)" }
        val bufferBytes =
            maxOf(minBuffer, (sampleRate * TRACK_BUFFER_SECONDS).toInt() * BYTES_PER_PCM16_SAMPLE)
        val attributes = buildAudioAttributes(path)
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

    /**
     * Attrs by [VoiceAudioPath] (S5, spec §7.1): [VoiceAudioPath.Manual] (hold/idle replies)
     * runs USAGE_ASSISTANT on the media volume stream — loud, rocker-controlled at any time.
     * [VoiceAudioPath.Duplex] (continuous) keeps today's USAGE_VOICE_COMMUNICATION, the
     * AEC-friendly voice-call route, unchanged. CONTENT_TYPE_SPEECH is unchanged on both.
     */
    private fun buildAudioAttributes(path: VoiceAudioPath): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(usageFor(path))
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    /** The AudioAttributes usage constant selected by [path] — see [buildAudioAttributes]. */
    private fun usageFor(path: VoiceAudioPath): Int =
        if (path == VoiceAudioPath.Manual) AudioAttributes.USAGE_ASSISTANT else AudioAttributes.USAGE_VOICE_COMMUNICATION

    /** Mono PCM16 at [sampleRate] — the track's data format. */
    private fun buildAudioFormat(sampleRate: Int): AudioFormat =
        AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()

    private fun teardown(active: AudioTrack) {
        runCatching { active.stop() }
            .onFailure { log.warn("track-stop-failed", mapOf("code" to "operation-failure")) }
        runCatching { active.release() }
            .onFailure { log.warn("track-release-failed", mapOf("code" to "operation-failure")) }
        resampler = null
    }
}
