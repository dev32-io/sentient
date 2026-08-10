// ---------------------------------------------------------------------------
// PreferencesConnectorTest — ported VERBATIM from web-sdk
// preferences-connector.test.ts. Pins the wire/protocol contract at the
// gateway↔SDK boundary (the outbound payload-nested user.preferences.patch
// frame) + the patch-vs-seed distinction. → keeper per .claude/rules/testing.md.
//
// web-sdk surfaces send via sdk.send; mobile-sdk injects a `send` lambda. The
// TS A1 protocol fix nests patch fields under `payload`; this test asserts the
// payload-nested shape (NOT flat fields).
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.PreferencesPatchPayload
import io.sentient.mobilesdk.protocol.ServerMessage
import kotlin.test.Test
import kotlin.test.assertEquals

class PreferencesConnectorTest {

    private fun recorder(): Pair<MutableList<ClientMessage>, (ClientMessage) -> Unit> {
        val sent = mutableListOf<ClientMessage>()
        return sent to { msg -> sent += msg }
    }

    @Test
    fun has_capability_session_preferences() {
        val (_, send) = recorder()
        assertEquals("session.preferences", PreferencesConnector(send).capability)
    }

    @Test
    fun starts_at_default_ttsEnabled_true_channel_voice() {
        val (_, send) = recorder()
        assertEquals(AudioPreferences.DEFAULT, PreferencesConnector(send).current())
    }

    @Test
    fun updates_state_on_session_preferences_changed() {
        val (_, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        c.handle(
            ServerMessage.SessionPreferencesChanged(
                preferences = AudioPreferences(ttsEnabled = false, channel = "text"),
            ),
        )

        assertEquals(AudioPreferences(ttsEnabled = false, channel = "text"), c.current())
        assertEquals(listOf(AudioPreferences(ttsEnabled = false, channel = "text")), changes)
    }

    @Test
    fun does_not_fire_onChange_for_duplicate_preferences() {
        val (_, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        // Default is ttsEnabled=true/channel=voice; echoing it must not fire.
        c.handle(ServerMessage.SessionPreferencesChanged(preferences = AudioPreferences.DEFAULT))

        assertEquals(emptyList(), changes)
    }

    @Test
    fun emits_payload_nested_patch_on_patch() {
        val (sent, send) = recorder()
        val c = PreferencesConnector(send)

        c.patch(AudioPreferencesPatch(ttsEnabled = false))

        assertEquals(
            listOf<ClientMessage>(
                ClientMessage.UserPreferencesPatch(PreferencesPatchPayload(ttsEnabled = false)),
            ),
            sent,
        )
    }

    @Test
    fun seed_sets_current_without_sending() {
        val (sent, send) = recorder()
        val c = PreferencesConnector(send)

        c.seed(AudioPreferences(ttsEnabled = false, channel = "voice"))

        assertEquals(AudioPreferences(ttsEnabled = false, channel = "voice"), c.current())
        assertEquals(emptyList(), sent)
    }

    // -----------------------------------------------------------------------
    // Local application. `user.preferences.patch` is fire-and-forget — the
    // gateway persists and live-applies it but deliberately never answers, and
    // `session.preferences.changed` is not in gatewayMessageSchema at all, so
    // NOTHING can ever correct this state from the server. Sending without
    // applying left `current()` pinned at DEFAULT: the chat TTS icon rendered
    // permanently ON while every tap re-derived `!true` and posted
    // ttsEnabled=false again. These pin both halves of the local update.
    // -----------------------------------------------------------------------

    @Test
    fun patch_applies_locally_and_fires_onChange() {
        val (_, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        c.patch(AudioPreferencesPatch(ttsEnabled = false))

        assertEquals(false, c.current().ttsEnabled)
        assertEquals(listOf(AudioPreferences(ttsEnabled = false, channel = "voice")), changes)
    }

    @Test
    fun patch_toggles_back_and_forth_from_its_own_state() {
        val (_, send) = recorder()
        val c = PreferencesConnector(send)

        c.patch(AudioPreferencesPatch(ttsEnabled = !c.current().ttsEnabled))
        assertEquals(false, c.current().ttsEnabled)

        // The regression: a caller deriving the next value from current() must
        // get `true` here. Against the un-applied state it computed `!true`
        // forever and the toggle could never turn TTS back on.
        c.patch(AudioPreferencesPatch(ttsEnabled = !c.current().ttsEnabled))
        assertEquals(true, c.current().ttsEnabled)
    }

    @Test
    fun patch_leaves_unset_fields_untouched() {
        val (_, send) = recorder()
        val c = PreferencesConnector(send)
        c.seed(AudioPreferences(ttsEnabled = true, channel = "text"))

        c.patch(AudioPreferencesPatch(ttsEnabled = false))

        // A null field means "unchanged" on the wire; merging locally has to agree.
        assertEquals(AudioPreferences(ttsEnabled = false, channel = "text"), c.current())
    }

    /** onChange is the only route into the state deriver, so a silent seed
     *  would fix what the connector reports and leave the UI on the DEFAULT. */
    @Test
    fun seed_fires_onChange_when_it_differs() {
        val (_, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        c.seed(AudioPreferences(ttsEnabled = false, channel = "voice"))

        assertEquals(listOf(AudioPreferences(ttsEnabled = false, channel = "voice")), changes)
    }

    @Test
    fun seed_of_an_identical_value_fires_nothing() {
        val (_, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        c.seed(AudioPreferences.DEFAULT)

        assertEquals(emptyList(), changes)
    }

    @Test
    fun ignores_unowned_frames() {
        val (sent, send) = recorder()
        val changes = mutableListOf<AudioPreferences>()
        val c = PreferencesConnector(send, onChange = { changes += it })

        c.handle(ServerMessage.Pong)

        assertEquals(emptyList(), changes)
        assertEquals(emptyList(), sent)
        assertEquals(AudioPreferences.DEFAULT, c.current())
    }
}
