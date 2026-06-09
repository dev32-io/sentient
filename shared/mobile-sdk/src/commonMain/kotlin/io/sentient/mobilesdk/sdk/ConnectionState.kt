package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
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
    // Cognition axis (THINKING/ACTING) — drives the assistant avatar "thinking" ring
    // during a text response that has no voice signal. Mirrors web-sdk CognitionState.
    val cognition: CognitionState = CognitionState.IDLE,
)
