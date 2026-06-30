package io.sentient.mobilesdk.voice
import kotlin.test.Test
import kotlin.test.assertEquals

class VoiceFsmTest {
    @Test fun tap_goes_through_initializing_to_listening() {
        val fsm = VoiceFsm()
        assertEquals(VoicePhase.INACTIVE, fsm.phase)
        assertEquals(VoicePhase.INITIALIZING, fsm.apply(VoiceInput.TapOn))
        assertEquals(VoicePhase.LISTENING, fsm.apply(VoiceInput.CaptureLive))
        assertEquals(VoicePhase.USER_SPEAKING, fsm.apply(VoiceInput.MicOnset))
        assertEquals(VoicePhase.INACTIVE, fsm.apply(VoiceInput.Deactivate))
    }
    @Test fun capture_failure_returns_to_inactive() {
        val fsm = VoiceFsm()
        fsm.apply(VoiceInput.TapOn)
        assertEquals(VoicePhase.INACTIVE, fsm.apply(VoiceInput.CaptureFailed))
    }
}
