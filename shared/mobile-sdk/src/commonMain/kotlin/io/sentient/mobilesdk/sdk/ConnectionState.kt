package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.transport.SdkStatus

data class ConnectionState(
    val status: SdkStatus = SdkStatus.DISCONNECTED,
    val hasSession: Boolean = false,
    val connectionLost: Boolean = false,
    val authExpired: Boolean = false,
    val prefs: AudioPreferences = AudioPreferences.DEFAULT,
    val voiceMode: VoiceMode = VoiceMode.OFF,
    val isSpeaking: Boolean = false,
    val audioState: AudioState = AudioState.INACTIVE,
)
