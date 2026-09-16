package io.sentient.mobilesdk.sdk

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.transport.SdkStatus

enum class AssistantActivityPhase {
    IDLE,
    THINKING,
    RESPONDING,
}

/**
 * Identity-addressed assistant presentation state.
 *
 * Selection rules:
 * - newest active cognition turn wins over older audio;
 * - speaking is eligible only for newest assistant turn;
 * - audio has only turnId, so replyId is latest non-cutoff assistant reply observed in that turn;
 * - unknown/ambiguous replyId stays null. Consumers must never fall back to an unrelated row.
 */
data class AssistantActivityState(
    val phase: AssistantActivityPhase = AssistantActivityPhase.IDLE,
    val turnId: String? = null,
    val replyId: String? = null,
)

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
