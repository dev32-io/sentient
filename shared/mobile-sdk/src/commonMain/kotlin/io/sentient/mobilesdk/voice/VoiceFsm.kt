package io.sentient.mobilesdk.voice

enum class VoicePhase { INACTIVE, INITIALIZING, LISTENING, USER_SPEAKING, PROCESSING, ASSISTANT_SPEAKING, INTERRUPTING }

sealed interface VoiceInput {
    data object TapOn : VoiceInput
    data object CaptureLive : VoiceInput
    data object CaptureFailed : VoiceInput
    data object MicOnset : VoiceInput
    data object Deactivate : VoiceInput
}

/** Uplink-phase state machine. Pure; single-thread (pipeline dispatcher). */
class VoiceFsm {
    var phase: VoicePhase = VoicePhase.INACTIVE
        private set

    fun apply(input: VoiceInput): VoicePhase {
        phase = when (input) {
            VoiceInput.TapOn -> if (phase == VoicePhase.INACTIVE) VoicePhase.INITIALIZING else phase
            VoiceInput.CaptureLive -> if (phase == VoicePhase.INITIALIZING) VoicePhase.LISTENING else phase
            VoiceInput.CaptureFailed -> VoicePhase.INACTIVE
            VoiceInput.MicOnset -> if (phase == VoicePhase.LISTENING) VoicePhase.USER_SPEAKING else phase
            VoiceInput.Deactivate -> VoicePhase.INACTIVE
        }
        return phase
    }
}
