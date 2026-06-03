// ---------------------------------------------------------------------------
// VoiceStatus — pure mapping from the SDK's voice fields to a SentientMark
// animation mode, mirroring gateway/webui/src/hooks/voice-status.ts
// (buildVoiceStatus) + app.tsx's activeCycleMode/topbarMarkMode derivation.
//
// Precedence (identical to buildVoiceStatus): assistant audio playing wins,
// then server cognition (thinking/acting → processing), then mic-open
// (listening), else idle. CRITICAL — this is the only place the avatar's
// animation state is decided, and IDLE maps to no animation (the
// event-driven-UX rule: "constant by default is a bug").
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import io.sentient.mobilesdk.connectors.CognitionState
import io.sentient.mobilesdk.sdk.AudioState
import io.sentient.mobilesdk.sdk.SdkState

/**
 * The four avatar animation modes, mirroring the webui SentientMarkMode union.
 * Each maps to exactly one animation (or none, for [IDLE]).
 */
enum class MarkMode { IDLE, LISTENING, THINKING, SPEAKING }

/**
 * Derives the avatar animation mode from the single SDK surface. Pure — every
 * mode traces to an SDK-emitted field, so the animation is event-driven and
 * stops the instant its driving state leaves. [IDLE] ⇒ no animation.
 */
fun markModeOf(state: SdkState): MarkMode {
    val speaking = state.isSpeaking || state.audioState == AudioState.ASSISTANT_SPEAKING
    if (speaking) return MarkMode.SPEAKING
    val thinking = state.cognition != CognitionState.IDLE ||
        state.audioState == AudioState.PROCESSING
    if (thinking) return MarkMode.THINKING
    val listening = state.audioState == AudioState.LISTENING ||
        state.audioState == AudioState.USER_SPEAKING
    if (listening) return MarkMode.LISTENING
    return MarkMode.IDLE
}
