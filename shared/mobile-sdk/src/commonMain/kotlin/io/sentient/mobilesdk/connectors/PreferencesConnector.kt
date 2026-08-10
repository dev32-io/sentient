// ---------------------------------------------------------------------------
// PreferencesConnector — observes server-driven audio preference changes
// (e.g. the model called update_user_settings) and lets the app push patches
// up to the gateway.
//
// Mirrors web-sdk's preferences-connector.ts VERBATIM:
//   capability = "session.preferences"  (status observer, but also sends)
//
//   session.preferences.changed → merge into current(), fire onChange ONLY when
//                                  a field actually changed (duplicate → no-op).
//   patch(p)                     → send the FIXED payload-nested
//                                  user.preferences.patch frame to the gateway.
//                                  The server echoes via preferences.changed.
//   seed(prefs)                  → set current() WITHOUT emitting any frame.
//                                  Used when the app loads a profile before the
//                                  SDK has received any server-driven update.
//
// web-sdk reaches the wire via sdk.send; mobile-sdk injects a `send` lambda so
// the orchestrator owns the transport. State (current AudioPreferences) is
// owned here; defaults to AudioPreferences.DEFAULT.
//
// Threading: single-threaded; the orchestrator routes frames + drives patch/seed
// on its own dispatcher. The mutable state is owned here.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.connectors

import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferences
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.protocol.ClientMessage
import io.sentient.mobilesdk.protocol.PreferencesPatchPayload
import io.sentient.mobilesdk.protocol.ServerMessage

class PreferencesConnector(
    private val send: (ClientMessage) -> Unit,
    private val onChange: ((AudioPreferences) -> Unit)? = null,
) : Connector {
    override val capability: String = CAPABILITY

    private val log = createLogger("connector", "preferences")

    private var state: AudioPreferences = AudioPreferences.DEFAULT

    /** Current snapshot of audio preferences. Safe to read synchronously. */
    fun current(): AudioPreferences = state

    /**
     * Seed the current state from external storage (e.g. profile) WITHOUT
     * emitting a frame. Use when the app loads the profile before the SDK has
     * received any server-driven preference update.
     *
     * Fires [onChange] when the seed actually differs, because that callback is
     * the only route into the state deriver (SdkConnectors) and therefore into
     * the UI. Setting `state` silently would fix what the connector reports and
     * leave the rendered toggle showing the DEFAULT — which is the bug this
     * seeding exists to close, not a smaller version of it.
     */
    fun seed(prefs: AudioPreferences) {
        val changed = prefs != state
        log.info(
            "seed",
            mapOf("ttsEnabled" to prefs.ttsEnabled, "channel" to prefs.channel, "applied" to changed),
        )
        state = prefs
        if (changed) onChange?.invoke(prefs)
    }

    /**
     * Send a patch to the gateway AND apply it locally, right away.
     *
     * OPTIMISTIC BY NECESSITY, not by preference. `user.preferences.patch` is
     * fire-and-forget on the wire — the gateway persists it and applies it to
     * the live session but deliberately never answers
     * (session-handlers/handle-preferences-patch.ts), so there is no ack to
     * wait on. Sending without applying left `state` frozen at whatever it was,
     * which is how the chat TTS toggle rendered permanently ON while every tap
     * computed `!true` and posted `ttsEnabled=false` again: the icon reads this
     * state, and so does the caller deriving the next value from it.
     *
     * Merging (rather than replacing) matters because a patch is partial — a
     * null field means "unchanged", so a ttsEnabled-only patch must not blank
     * the channel.
     */
    fun patch(p: AudioPreferencesPatch) {
        val next = AudioPreferences(
            ttsEnabled = p.ttsEnabled ?: state.ttsEnabled,
            channel = p.channel ?: state.channel,
        )
        val changed = next != state
        log.info(
            "patch",
            mapOf("ttsEnabled" to p.ttsEnabled, "channel" to p.channel, "applied" to changed),
        )
        state = next
        send(
            ClientMessage.UserPreferencesPatch(
                payload = PreferencesPatchPayload(ttsEnabled = p.ttsEnabled, channel = p.channel),
            ),
        )
        if (changed) onChange?.invoke(next)
    }

    override fun handle(msg: ServerMessage) {
        when (msg) {
            is ServerMessage.SessionPreferencesChanged -> onPreferencesChanged(msg)
            else -> Unit // not owned by this connector
        }
    }

    private fun onPreferencesChanged(msg: ServerMessage.SessionPreferencesChanged) {
        val next = AudioPreferences(
            ttsEnabled = msg.preferences.ttsEnabled,
            channel = msg.preferences.channel,
        )
        val changed = next != state
        log.info(
            "changed",
            mapOf(
                "ttsEnabled" to next.ttsEnabled,
                "channel" to next.channel,
                "fired" to changed,
            ),
        )
        state = next
        if (changed) onChange?.invoke(next)
    }

    companion object {
        const val CAPABILITY: String = "session.preferences"
    }
}
