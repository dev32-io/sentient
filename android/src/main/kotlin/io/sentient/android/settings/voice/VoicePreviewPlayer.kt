// ---------------------------------------------------------------------------
// VoicePreviewPlayer — one-at-a-time audio preview playback for the Voice settings
// cluster. Plays either raw WAV bytes (voice-pack live-synth previews, written to a
// temp file in the cache dir) or a remote URL (Fish Audio sample clips, streamed
// directly — the gateway does NOT proxy Fish samples, so MediaPlayer hits the
// external previewAudioUrl, exactly as the webui `new Audio(url)` path does).
//
// Starting a new play stops any current one; release() / stop() free the player and
// delete the temp file. NEVER logs audio bytes — sizes / lengths only.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import android.content.Context
import android.media.MediaPlayer
import io.sentient.mobilesdk.log.createLogger
import java.io.File

private const val TEMP_PREFIX = "voice-preview"
private const val TEMP_SUFFIX = ".wav"

/** Single-stream preview player over Android [MediaPlayer]. Not thread-safe: drive from one scope. */
class VoicePreviewPlayer(private val appContext: Context) {
    private val log = createLogger("android", "settings", "voice-preview-player")
    private var player: MediaPlayer? = null
    private var tempFile: File? = null

    /** Play live-synth WAV [bytes]; [onComplete] fires on natural end, error, or abort. */
    fun playBytes(bytes: ByteArray, onComplete: () -> Unit) {
        stop()
        val file = runCatching {
            File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, appContext.cacheDir).apply { writeBytes(bytes) }
        }.getOrElse { e ->
            log.warn("bytes.temp-failed", mapOf("cause" to (e.message ?: "unknown")))
            onComplete()
            return
        }
        tempFile = file
        log.info("play.bytes", mapOf("bytes" to bytes.size))
        start(file.absolutePath, onComplete)
    }

    /** Stream a remote sample [url] (Fish previewAudioUrl); [onComplete] on end/error/abort. */
    fun playUrl(url: String, onComplete: () -> Unit) {
        stop()
        log.info("play.url", mapOf("urlLen" to url.length))
        start(url, onComplete)
    }

    private fun start(source: String, onComplete: () -> Unit) {
        val mp = MediaPlayer()
        player = mp
        runCatching {
            mp.setDataSource(source)
            mp.setOnPreparedListener { it.start() }
            mp.setOnCompletionListener {
                stop()
                onComplete()
            }
            mp.setOnErrorListener { _, what, extra ->
                log.warn("play.error", mapOf("what" to what, "extra" to extra))
                stop()
                onComplete()
                true
            }
            mp.prepareAsync()
        }.onFailure { e ->
            log.warn("play.start-failed", mapOf("cause" to (e.message ?: "unknown")))
            stop()
            onComplete()
        }
    }

    /** Stop + release the current player and drop the temp file. Safe to call when idle. */
    fun stop() {
        player?.let { mp -> runCatching { mp.reset(); mp.release() } }
        player = null
        tempFile?.let { runCatching { it.delete() } }
        tempFile = null
    }

    /** Release on dispose — same teardown as [stop]. */
    fun release() = stop()
}
