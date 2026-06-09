package io.sentient.mobilesdk.protocol

import kotlinx.serialization.Serializable

/** Persisted audio output preferences for the session (TTS on/off, channel). */
@Serializable
data class AudioPreferences(
    val ttsEnabled: Boolean = true,
    val channel: String = "voice",
) {
    companion object {
        val DEFAULT = AudioPreferences(ttsEnabled = true, channel = "voice")
    }
}

/** Partial patch — null fields are not changed on the server. */
data class AudioPreferencesPatch(
    val ttsEnabled: Boolean? = null,
    val channel: String? = null,
)
