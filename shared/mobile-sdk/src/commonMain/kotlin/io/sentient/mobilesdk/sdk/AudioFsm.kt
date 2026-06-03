// ---------------------------------------------------------------------------
// AudioFsm — the pure voice-status state machine (R5).
//
// Drives the SdkState voice-status display (listening / processing / speaking)
// consumed by BOTH native UIs. Mirrors gateway/webui/src/hooks/voice-status.ts
// buildVoiceStatus (listening / processing / assistant-speaking) plus the E3
// plan's full state list:
//
//   inactive → listening → user-speaking → processing → assistant-speaking
//                                                              → interrupting
//
// Driven by TYPED inputs (no hardware, no clock): Activate / Deactivate /
// MicOnset / TranscriptFinal / CycleStart / CycleDone / AudioStart / AudioDone /
// Interrupt. The AudioPipeline feeds these from the capture/gate/connector
// events; the orchestrator maps the resulting AudioState onto SdkState via
// StateDeriver. Pure typed transitions — no logging here (the pipeline logs
// every transition with prev→new+input, per .claude/rules/logging.md).
//
// Transition table (every row pinned in AudioFsmTest):
//   INACTIVE           Activate        → LISTENING        (else: stay INACTIVE)
//   LISTENING          MicOnset        → USER_SPEAKING
//   LISTENING          CycleStart      → PROCESSING
//   LISTENING          AudioStart      → ASSISTANT_SPEAKING
//   USER_SPEAKING      TranscriptFinal → PROCESSING
//   USER_SPEAKING      CycleStart      → PROCESSING
//   USER_SPEAKING      Interrupt       → LISTENING
//   PROCESSING         AudioStart      → ASSISTANT_SPEAKING
//   PROCESSING         CycleDone       → LISTENING
//   PROCESSING         MicOnset        → USER_SPEAKING    (barge-in pre-audio)
//   PROCESSING         Interrupt       → INTERRUPTING
//   ASSISTANT_SPEAKING AudioDone       → LISTENING
//   ASSISTANT_SPEAKING MicOnset        → INTERRUPTING     (barge-in)
//   ASSISTANT_SPEAKING Interrupt       → INTERRUPTING
//   ASSISTANT_SPEAKING CycleDone       → ASSISTANT_SPEAKING (audio still draining)
//   INTERRUPTING       AudioDone       → LISTENING
//   INTERRUPTING       CycleDone       → LISTENING
//   INTERRUPTING       AudioStart      → ASSISTANT_SPEAKING (next cycle resumes)
//   <any>              Deactivate      → INACTIVE
// Unlisted (state, input) pairs are no-ops (stay in the current state).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

/**
 * Voice-status FSM states. The four "display" states map onto voice-status.ts:
 * [LISTENING] → "listening", [PROCESSING] → "processing",
 * [ASSISTANT_SPEAKING] → "assistant-speaking". [USER_SPEAKING] and
 * [INTERRUPTING] are local transients the SdkState derivation collapses for
 * display (user-speaking still reads as listening-active; interrupting reads as
 * speaking until playback.stop settles) — kept distinct here so the pipeline can
 * drive gate/connector side effects precisely.
 */
enum class AudioState {
    /** voiceMode off (text path) — the root. */
    INACTIVE,

    /** Mic active, idle. "Listening..." display. */
    LISTENING,

    /** Local mic onset detected; awaiting server resolution (transcript / cycle). */
    USER_SPEAKING,

    /** Server cognition active (thinking / acting). "Thinking..." display. */
    PROCESSING,

    /** Assistant TTS playing. "Speaking..." display. */
    ASSISTANT_SPEAKING,

    /** Transient settle after barge-in / UI stop, until playback.stop lands. */
    INTERRUPTING,
}

/**
 * Typed inputs that drive [AudioFsm]. A flat sealed hierarchy → SKIE exposes an
 * exhaustive Swift enum. No payloads: the pipeline carries ids (cycleId /
 * utteranceId) in its log trail, not through the FSM transition.
 */
sealed interface AudioInput {
    /** Mic uplink started (startMic / voiceMode ACTIVE). */
    data object Activate : AudioInput

    /** Mic uplink stopped (stopMic / voiceMode OFF) or session torn down. */
    data object Deactivate : AudioInput

    /** Local speech-onset detected (SpeechGate opened / loud barge-in frame). */
    data object MicOnset : AudioInput

    /** Server finalized the utterance (connector.transcript.final). */
    data object TranscriptFinal : AudioInput

    /** A cognitive cycle began (cycle.started / cognition → thinking). */
    data object CycleStart : AudioInput

    /** The cognitive cycle finished (cycle.done / cognition → idle). */
    data object CycleDone : AudioInput

    /** Assistant audio began playing (connector.audio.start). */
    data object AudioStart : AudioInput

    /** Assistant audio finished / drained (connector.audio.done). */
    data object AudioDone : AudioInput

    /** Hard interrupt or playback.stop (UI Stop / barge-in cancel). */
    data object Interrupt : AudioInput
}

/**
 * Mutable holder advancing through [AudioState] on typed [AudioInput].
 *
 * [next] is the pure transition (no mutation) used directly in tests; [handle]
 * advances the instance and returns the new state. Pure: no clock, no platform,
 * no logging — the pipeline owns the integration trail.
 *
 * @param state The current state. Defaults to [AudioState.INACTIVE].
 */
class AudioFsm(var state: AudioState = AudioState.INACTIVE) {

    /**
     * Pure transition: the next state for [input] from the current [state].
     * Does NOT mutate. Unlisted pairs stay in the current state.
     */
    fun next(input: AudioInput): AudioState {
        if (input is AudioInput.Deactivate) return AudioState.INACTIVE
        return when (state) {
            AudioState.INACTIVE -> if (input is AudioInput.Activate) AudioState.LISTENING else state
            AudioState.LISTENING -> fromListening(input)
            AudioState.USER_SPEAKING -> fromUserSpeaking(input)
            AudioState.PROCESSING -> fromProcessing(input)
            AudioState.ASSISTANT_SPEAKING -> fromAssistantSpeaking(input)
            AudioState.INTERRUPTING -> fromInterrupting(input)
        }
    }

    /** Advance the instance to [next] of [input] and return the new state. */
    fun handle(input: AudioInput): AudioState {
        state = next(input)
        return state
    }

    private fun fromListening(input: AudioInput): AudioState = when (input) {
        is AudioInput.MicOnset -> AudioState.USER_SPEAKING
        is AudioInput.CycleStart -> AudioState.PROCESSING
        is AudioInput.AudioStart -> AudioState.ASSISTANT_SPEAKING
        else -> state
    }

    private fun fromUserSpeaking(input: AudioInput): AudioState = when (input) {
        is AudioInput.TranscriptFinal -> AudioState.PROCESSING
        is AudioInput.CycleStart -> AudioState.PROCESSING
        is AudioInput.Interrupt -> AudioState.LISTENING
        else -> state
    }

    private fun fromProcessing(input: AudioInput): AudioState = when (input) {
        is AudioInput.AudioStart -> AudioState.ASSISTANT_SPEAKING
        is AudioInput.CycleDone -> AudioState.LISTENING
        is AudioInput.MicOnset -> AudioState.USER_SPEAKING
        is AudioInput.Interrupt -> AudioState.INTERRUPTING
        else -> state
    }

    private fun fromAssistantSpeaking(input: AudioInput): AudioState = when (input) {
        is AudioInput.AudioDone -> AudioState.LISTENING
        is AudioInput.MicOnset -> AudioState.INTERRUPTING
        is AudioInput.Interrupt -> AudioState.INTERRUPTING
        else -> state // CycleDone stays: audio still physically draining.
    }

    private fun fromInterrupting(input: AudioInput): AudioState = when (input) {
        is AudioInput.AudioDone -> AudioState.LISTENING
        is AudioInput.CycleDone -> AudioState.LISTENING
        is AudioInput.AudioStart -> AudioState.ASSISTANT_SPEAKING
        else -> state
    }
}
