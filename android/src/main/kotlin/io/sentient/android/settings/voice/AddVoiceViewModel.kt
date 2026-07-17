// ---------------------------------------------------------------------------
// AddVoiceViewModel — thin state-holder for the Add Voice sub-page. Two capture
// modes (record in-app via VoiceRecorder, or pick an audio file via SAF), a
// playback check, and the name/description/tags/language form, then a multipart
// create. Mirrors the webui AddVoiceModal record/upload flow.
//
// The captured/uploaded WAV bytes live in a private field (kept OUT of the StateFlow
// so the render state stays value-comparable + Compose-stable); the UI reads
// `hasAudio`. Every field cap is client-side cosmetic (the gateway truncates over-cap
// metadata). Audio bytes are never logged.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.sentient.mobiledata.result.SentientResult
import io.sentient.mobiledata.usecase.settings.VoicesUseCases
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.settings.VoiceFieldCaps
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Service reference-clip floor is >5s — enforce a soft minimum before "Use recording". */
const val MIN_RECORDING_MS: Long = 6_000L
private const val TICK_MS: Long = 100L

enum class AddVoiceMode { RECORD, UPLOAD }

/** Render state for Add Voice. `hasAudio` gates submit; the raw bytes are VM-private. */
data class AddVoiceUiState(
    val mode: AddVoiceMode = AddVoiceMode.RECORD,
    val recording: Boolean = false,
    val elapsedMs: Long = 0,
    val hasAudio: Boolean = false,
    val audioDurationMs: Long? = null,
    val previewPlaying: Boolean = false,
    val micDenied: Boolean = false,
    val name: String = "",
    val description: String = "",
    val tags: List<String> = emptyList(),
    val language: String = "",
    val submitting: Boolean = false,
    val errorMessage: String? = null,
    val done: Boolean = false,
)

class AddVoiceViewModel(
    private val voices: VoicesUseCases,
    private val recorder: VoiceRecorder,
    private val player: VoicePreviewPlayer,
) : ViewModel() {
    private val log = createLogger("android", "settings", "add-voice-vm")

    private val _state = MutableStateFlow(AddVoiceUiState())
    val state: StateFlow<AddVoiceUiState> = _state.asStateFlow()

    private var audioWav: ByteArray? = null
    private var tickJob: Job? = null
    private var recStartedAt = 0L

    fun setMode(mode: AddVoiceMode) {
        if (mode == _state.value.mode) return
        cancelRecording()
        stopPreview()
        clearAudio()
        _state.update { it.copy(mode = mode, errorMessage = null) }
    }

    fun setName(name: String) = _state.update { it.copy(name = cap(name, VoiceFieldCaps.NAME_MAX_LEN)) }

    fun setDescription(text: String) =
        _state.update { it.copy(description = cap(text, VoiceFieldCaps.DESCRIPTION_MAX_LEN)) }

    fun setLanguage(language: String) = _state.update { it.copy(language = language) }

    fun addTag(raw: String) {
        val tag = cap(raw.trim(), VoiceFieldCaps.TAG_MAX_LEN)
        _state.update { s ->
            if (tag.isEmpty() || tag in s.tags || s.tags.size >= VoiceFieldCaps.MAX_TAGS) s
            else s.copy(tags = s.tags + tag)
        }
    }

    fun removeTag(tag: String) = _state.update { it.copy(tags = it.tags - tag) }

    /** Begin in-app recording (caller ensures RECORD_AUDIO granted). */
    fun startRecording() {
        if (!recorder.start(viewModelScope)) {
            log.warn("record.start-failed")
            _state.update { it.copy(errorMessage = "Couldn't start recording — try Upload instead.") }
            return
        }
        recStartedAt = SystemClock.elapsedRealtime()
        _state.update { it.copy(recording = true, elapsedMs = 0, micDenied = false, errorMessage = null) }
        startTicker()
    }

    /** Stop recording; keep the encoded clip for the playback check + submit. */
    fun stopRecording() {
        tickJob?.cancel()
        val elapsed = _state.value.elapsedMs
        val wav = recorder.stop()
        if (wav == null) {
            log.warn("record.empty")
            _state.update { it.copy(recording = false, errorMessage = "Recording failed — try again.") }
            return
        }
        audioWav = wav
        log.info("record.captured", mapOf("bytes" to wav.size, "durationMs" to elapsed))
        _state.update { it.copy(recording = false, hasAudio = true, audioDurationMs = elapsed) }
    }

    fun cancelRecording() {
        tickJob?.cancel()
        recorder.cancel()
        _state.update { it.copy(recording = false, elapsedMs = 0) }
    }

    fun onMicDenied() = _state.update { it.copy(micDenied = true) }

    /** Accept SAF-picked audio [bytes] as the clip (the service decodes wav/mp3/ogg/flac). */
    fun onUpload(bytes: ByteArray) {
        audioWav = bytes
        log.info("upload.received", mapOf("bytes" to bytes.size))
        _state.update { it.copy(hasAudio = true, audioDurationMs = null, errorMessage = null) }
    }

    fun togglePlayback() {
        if (_state.value.previewPlaying) {
            stopPreview()
            return
        }
        val bytes = audioWav ?: return
        player.playBytes(bytes) { onPlaybackEnded() }
        _state.update { it.copy(previewPlaying = true) }
    }

    private fun onPlaybackEnded() = _state.update { it.copy(previewPlaying = false) }

    fun reRecord() {
        stopPreview()
        clearAudio()
    }

    /** Create the voice pack from the captured clip + form fields. */
    fun submit() {
        val bytes = audioWav ?: return
        val name = _state.value.name.trim()
        if (name.isEmpty()) return
        val s = _state.value
        _state.update { it.copy(submitting = true, errorMessage = null) }
        viewModelScope.launch {
            when (val r = voices.create(name, bytes, s.description.trim(), s.tags, s.language)) {
                is SentientResult.Success -> {
                    log.info("create.ok", mapOf("warning" to (r.data.warning ?: "none")))
                    _state.update { it.copy(submitting = false, done = true) }
                }
                is SentientResult.Failure -> {
                    log.warn("create.failed", mapOf("kind" to r.error.kind))
                    _state.update { it.copy(submitting = false, errorMessage = r.error.userMessage) }
                }
                is SentientResult.Loading -> Unit
            }
        }
    }

    fun clearError() = _state.update { it.copy(errorMessage = null) }

    private fun startTicker() {
        tickJob?.cancel()
        tickJob = viewModelScope.launch {
            while (isActive && _state.value.recording) {
                _state.update { it.copy(elapsedMs = SystemClock.elapsedRealtime() - recStartedAt) }
                delay(TICK_MS)
            }
        }
    }

    private fun stopPreview() {
        if (!_state.value.previewPlaying) return
        player.stop()
        _state.update { it.copy(previewPlaying = false) }
    }

    private fun clearAudio() {
        audioWav = null
        _state.update { it.copy(hasAudio = false, audioDurationMs = null) }
    }

    override fun onCleared() {
        recorder.cancel()
        player.release()
    }
}

private fun cap(value: String, max: Int): String = if (value.length > max) value.take(max) else value
