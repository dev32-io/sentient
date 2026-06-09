// ---------------------------------------------------------------------------
// AudioFsmTest — KEEPER (per .claude/rules/testing.md): the audio voice-status
// FSM is a pure state machine whose every reachable transition + waiting-state
// exit is pinned here. Drives the SdkState voice-status display (listening /
// processing / speaking) consumed by both native UIs.
//
// States/inputs mirror gateway/webui/src/hooks/voice-status.ts (listening /
// processing / assistant-speaking) plus the E3 plan's state list
// (inactive → listening → user-speaking → processing → assistant-speaking →
// interrupting + back), driven by the plan's typed inputs (Activate / Deactivate
// / MicOnset / TranscriptFinal / CycleStart / CycleDone / AudioStart / AudioDone
// / Interrupt).
//
// Pure → no hardware, no clock. Feed typed inputs, assert typed outputs.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.sdk

import kotlin.test.Test
import kotlin.test.assertEquals

class AudioFsmTest {

    private fun fsm(start: AudioState = AudioState.INACTIVE) = AudioFsm(start)

    // -----------------------------------------------------------------------
    // INACTIVE — the voiceMode-off root. Only Activate leaves it.
    // -----------------------------------------------------------------------

    @Test
    fun inactive_activate_to_listening() {
        assertEquals(AudioState.LISTENING, fsm().next(AudioInput.Activate))
    }

    @Test
    fun inactive_ignores_non_activate_inputs() {
        val f = fsm()
        // Audio/cycle frames can arrive on the text path while mic is off — they
        // must NOT pull the FSM out of INACTIVE (voiceMode display stays inactive).
        assertEquals(AudioState.INACTIVE, f.next(AudioInput.MicOnset))
        assertEquals(AudioState.INACTIVE, f.next(AudioInput.CycleStart))
        assertEquals(AudioState.INACTIVE, f.next(AudioInput.AudioStart))
        assertEquals(AudioState.INACTIVE, f.next(AudioInput.AudioDone))
        assertEquals(AudioState.INACTIVE, f.next(AudioInput.Interrupt))
    }

    // -----------------------------------------------------------------------
    // LISTENING — mic active, idle. The "Listening..." display state.
    // -----------------------------------------------------------------------

    @Test
    fun listening_micOnset_to_userSpeaking() {
        assertEquals(AudioState.USER_SPEAKING, fsm(AudioState.LISTENING).next(AudioInput.MicOnset))
    }

    @Test
    fun listening_cycleStart_to_processing() {
        assertEquals(AudioState.PROCESSING, fsm(AudioState.LISTENING).next(AudioInput.CycleStart))
    }

    @Test
    fun listening_audioStart_to_assistantSpeaking() {
        // Server may emit audio before any local mic onset (e.g. a proactive
        // trigger reply) — jump straight to assistant-speaking.
        assertEquals(AudioState.ASSISTANT_SPEAKING, fsm(AudioState.LISTENING).next(AudioInput.AudioStart))
    }

    @Test
    fun listening_deactivate_to_inactive() {
        assertEquals(AudioState.INACTIVE, fsm(AudioState.LISTENING).next(AudioInput.Deactivate))
    }

    // -----------------------------------------------------------------------
    // USER_SPEAKING — local mic onset detected, awaiting server resolution.
    // Exits on TranscriptFinal / CycleStart (server processed it) or Interrupt.
    // -----------------------------------------------------------------------

    @Test
    fun userSpeaking_transcriptFinal_to_processing() {
        assertEquals(AudioState.PROCESSING, fsm(AudioState.USER_SPEAKING).next(AudioInput.TranscriptFinal))
    }

    @Test
    fun userSpeaking_cycleStart_to_processing() {
        assertEquals(AudioState.PROCESSING, fsm(AudioState.USER_SPEAKING).next(AudioInput.CycleStart))
    }

    @Test
    fun userSpeaking_interrupt_to_listening() {
        assertEquals(AudioState.LISTENING, fsm(AudioState.USER_SPEAKING).next(AudioInput.Interrupt))
    }

    @Test
    fun userSpeaking_deactivate_to_inactive() {
        assertEquals(AudioState.INACTIVE, fsm(AudioState.USER_SPEAKING).next(AudioInput.Deactivate))
    }

    // -----------------------------------------------------------------------
    // PROCESSING — server cognition active (thinking/acting). The "Thinking..."
    // display state. Exits on AudioStart (reply audio), CycleDone (no audio),
    // Interrupt, or a fresh MicOnset (barge-in before any audio played).
    // -----------------------------------------------------------------------

    @Test
    fun processing_audioStart_to_assistantSpeaking() {
        assertEquals(AudioState.ASSISTANT_SPEAKING, fsm(AudioState.PROCESSING).next(AudioInput.AudioStart))
    }

    @Test
    fun processing_cycleDone_to_listening() {
        assertEquals(AudioState.LISTENING, fsm(AudioState.PROCESSING).next(AudioInput.CycleDone))
    }

    @Test
    fun processing_interrupt_to_interrupting() {
        assertEquals(AudioState.INTERRUPTING, fsm(AudioState.PROCESSING).next(AudioInput.Interrupt))
    }

    @Test
    fun processing_micOnset_to_userSpeaking() {
        // Barge-in before any audio: a new local onset supersedes the in-flight cycle.
        assertEquals(AudioState.USER_SPEAKING, fsm(AudioState.PROCESSING).next(AudioInput.MicOnset))
    }

    @Test
    fun processing_deactivate_to_inactive() {
        assertEquals(AudioState.INACTIVE, fsm(AudioState.PROCESSING).next(AudioInput.Deactivate))
    }

    // -----------------------------------------------------------------------
    // ASSISTANT_SPEAKING — TTS playing. The "Speaking..." display state.
    // Exits on AudioDone (clean), MicOnset (barge-in), or Interrupt.
    // -----------------------------------------------------------------------

    @Test
    fun assistantSpeaking_audioDone_to_listening() {
        assertEquals(AudioState.LISTENING, fsm(AudioState.ASSISTANT_SPEAKING).next(AudioInput.AudioDone))
    }

    @Test
    fun assistantSpeaking_micOnset_to_interrupting() {
        // Barge-in: a loud local onset during TTS routes through INTERRUPTING so
        // playback.stop + clear can settle before returning to LISTENING.
        assertEquals(AudioState.INTERRUPTING, fsm(AudioState.ASSISTANT_SPEAKING).next(AudioInput.MicOnset))
    }

    @Test
    fun assistantSpeaking_interrupt_to_interrupting() {
        assertEquals(AudioState.INTERRUPTING, fsm(AudioState.ASSISTANT_SPEAKING).next(AudioInput.Interrupt))
    }

    @Test
    fun assistantSpeaking_cycleDone_stays_speaking() {
        // cycle.done can arrive while audio is still physically draining — the
        // display stays "Speaking..." until AudioDone / playback-stop.
        assertEquals(AudioState.ASSISTANT_SPEAKING, fsm(AudioState.ASSISTANT_SPEAKING).next(AudioInput.CycleDone))
    }

    @Test
    fun assistantSpeaking_deactivate_to_inactive() {
        assertEquals(AudioState.INACTIVE, fsm(AudioState.ASSISTANT_SPEAKING).next(AudioInput.Deactivate))
    }

    // -----------------------------------------------------------------------
    // INTERRUPTING — transient settle state after barge-in / UI stop. Exits on
    // AudioDone (playback.stop landed) or CycleDone, back to LISTENING.
    // -----------------------------------------------------------------------

    @Test
    fun interrupting_audioDone_to_listening() {
        assertEquals(AudioState.LISTENING, fsm(AudioState.INTERRUPTING).next(AudioInput.AudioDone))
    }

    @Test
    fun interrupting_cycleDone_to_listening() {
        assertEquals(AudioState.LISTENING, fsm(AudioState.INTERRUPTING).next(AudioInput.CycleDone))
    }

    @Test
    fun interrupting_audioStart_to_assistantSpeaking() {
        // The next cycle's audio can start while interrupting — resume speaking.
        assertEquals(AudioState.ASSISTANT_SPEAKING, fsm(AudioState.INTERRUPTING).next(AudioInput.AudioStart))
    }

    @Test
    fun interrupting_deactivate_to_inactive() {
        assertEquals(AudioState.INACTIVE, fsm(AudioState.INTERRUPTING).next(AudioInput.Deactivate))
    }

    // -----------------------------------------------------------------------
    // Exhaustiveness — every non-INACTIVE state has Deactivate → INACTIVE so the
    // mic-off path always lands at the root regardless of the active state.
    // -----------------------------------------------------------------------

    @Test
    fun every_active_state_deactivates_to_inactive() {
        for (s in AudioState.entries) {
            assertEquals(AudioState.INACTIVE, fsm(s).next(AudioInput.Deactivate), "deactivate from $s")
        }
    }

    // -----------------------------------------------------------------------
    // Mutating handle() advances the instance + reports the new state.
    // -----------------------------------------------------------------------

    @Test
    fun handle_advances_and_reports_state() {
        val f = fsm()
        assertEquals(AudioState.LISTENING, f.handle(AudioInput.Activate))
        assertEquals(AudioState.LISTENING, f.state)
        assertEquals(AudioState.USER_SPEAKING, f.handle(AudioInput.MicOnset))
        assertEquals(AudioState.USER_SPEAKING, f.state)
    }

    @Test
    fun full_happy_path_voice_turn() {
        val f = fsm()
        f.handle(AudioInput.Activate)          // inactive → listening
        f.handle(AudioInput.MicOnset)           // listening → user-speaking
        f.handle(AudioInput.TranscriptFinal)    // user-speaking → processing
        f.handle(AudioInput.AudioStart)         // processing → assistant-speaking
        f.handle(AudioInput.AudioDone)          // assistant-speaking → listening
        assertEquals(AudioState.LISTENING, f.state)
        f.handle(AudioInput.Deactivate)         // listening → inactive
        assertEquals(AudioState.INACTIVE, f.state)
    }
}
