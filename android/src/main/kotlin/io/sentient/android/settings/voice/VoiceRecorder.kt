// ---------------------------------------------------------------------------
// VoiceRecorder — in-app reference-clip capture for Add Voice (record mode).
//
// AudioRecord → 16-bit PCM mono @ 44.1kHz, accumulated in memory, then wrapped in a
// proper RIFF/WAVE header on stop() (the local-tts service decodes wav/mp3/ogg/flac
// via libsndfile and resamples internally, so a plain 44.1k mono WAV is accepted).
// The caller MUST have RECORD_AUDIO granted before start() (permission is requested
// at point of use by the Add Voice screen). Never throws across start()/stop() —
// every failure branch releases the record and returns false/null. Logs byte
// counts + sizes only, never audio content.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import io.sentient.mobilesdk.log.createLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

/** Records a mono 16-bit PCM clip and encodes it as WAV bytes. Drive from one scope. */
class VoiceRecorder {
    private val log = createLogger("android", "settings", "voice-recorder")
    private var record: AudioRecord? = null
    private var job: Job? = null
    private val pcm = ByteArrayOutputStream()

    @Volatile
    private var recording = false

    /** True between a successful [start] and [stop]/[cancel]. */
    val isRecording: Boolean get() = recording

    /**
     * Open AudioRecord and begin reading into memory on [scope] (IO). Returns false
     * (no state changed) if the device rejects the config. Caller ensures permission.
     */
    @Suppress("MissingPermission") // RECORD_AUDIO ensured by the Add Voice screen before this call
    fun start(scope: CoroutineScope): Boolean {
        if (recording) return true
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, channelMask, encoding)
        if (minBuffer <= 0) {
            log.warn("min-buffer", mapOf("size" to minBuffer))
            return false
        }
        val bufferBytes = maxOf(minBuffer, SAMPLE_RATE * BYTES_PER_SAMPLE) // ~1s of headroom
        val rec = runCatching { AudioRecord(source, SAMPLE_RATE, channelMask, encoding, bufferBytes) }
            .getOrElse { e ->
                log.error("construct", mapOf("cause" to (e.message ?: "unknown")))
                return false
            }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            log.warn("init-state", mapOf("state" to rec.state))
            return false
        }
        pcm.reset()
        rec.startRecording()
        if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            rec.release()
            log.warn("record-state", mapOf("state" to rec.recordingState))
            return false
        }
        record = rec
        recording = true
        log.info("start", mapOf("sampleRate" to SAMPLE_RATE))
        job = scope.launch(Dispatchers.IO) { readLoop(rec, bufferBytes) }
        return true
    }

    private fun CoroutineScope.readLoop(rec: AudioRecord, bufferBytes: Int) {
        val buf = ByteArray(bufferBytes)
        while (isActive && recording) {
            val n = rec.read(buf, 0, buf.size)
            if (n > 0) synchronized(pcm) { pcm.write(buf, 0, n) }
        }
    }

    /** Stop capture and return the encoded WAV bytes (null if nothing was captured). */
    fun stop(): ByteArray? {
        if (!recording) return null
        recording = false
        job?.cancel()
        job = null
        val rec = record
        record = null
        runCatching { rec?.stop() }
        rec?.release()
        val pcmBytes = synchronized(pcm) { pcm.toByteArray() }
        log.info("stop", mapOf("pcmBytes" to pcmBytes.size))
        if (pcmBytes.isEmpty()) return null
        return wavFromPcm16(pcmBytes, SAMPLE_RATE, CHANNELS)
    }

    /** Abort capture, discard the buffer. Safe to call when idle. */
    fun cancel() {
        recording = false
        job?.cancel()
        job = null
        record?.let {
            runCatching { it.stop() }
            it.release()
        }
        record = null
        synchronized(pcm) { pcm.reset() }
        log.info("cancel")
    }

    private companion object {
        const val SAMPLE_RATE = 44_100
        const val CHANNELS = 1
        const val BYTES_PER_SAMPLE = 2
        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val source = MediaRecorder.AudioSource.VOICE_RECOGNITION // mic-only capture, no echo to cancel
    }
}

private const val WAV_HEADER_BYTES = 44
private const val PCM_FMT_CHUNK_SIZE = 16
private const val PCM_FORMAT_TAG = 1
private const val BITS_PER_SAMPLE = 16

/** Wrap raw 16-bit little-endian PCM in a canonical 44-byte RIFF/WAVE header. */
private fun wavFromPcm16(pcm: ByteArray, sampleRate: Int, channels: Int): ByteArray {
    val byteRate = sampleRate * channels * (BITS_PER_SAMPLE / 8)
    val blockAlign = channels * (BITS_PER_SAMPLE / 8)
    val out = ByteArrayOutputStream(WAV_HEADER_BYTES + pcm.size)
    fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
    fun le32(v: Int) {
        out.write(v and 0xFF); out.write((v shr 8) and 0xFF); out.write((v shr 16) and 0xFF); out.write((v shr 24) and 0xFF)
    }
    fun le16(v: Int) {
        out.write(v and 0xFF); out.write((v shr 8) and 0xFF)
    }
    ascii("RIFF"); le32(WAV_HEADER_BYTES - 8 + pcm.size); ascii("WAVE")
    ascii("fmt "); le32(PCM_FMT_CHUNK_SIZE); le16(PCM_FORMAT_TAG); le16(channels)
    le32(sampleRate); le32(byteRate); le16(blockAlign); le16(BITS_PER_SAMPLE)
    ascii("data"); le32(pcm.size); out.write(pcm)
    return out.toByteArray()
}
