package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Client → gateway wire frames.
 * SerialName values mirror the wire "type" strings from shared/protocol/src/messages.ts
 * and shared/protocol/src/sessions.ts exactly.
 */
@Serializable
sealed class ClientMessage {
    /** First message on every WS connection — carries the PASETO session token. */
    @Serializable @SerialName("auth")
    data class Auth(val token: String) : ClientMessage()

    /** Declares client capabilities and language preference. clientType MUST be "mobile". */
    @Serializable @SerialName("session.configure")
    data class SessionConfigure(
        val language: String = "en",
        val capabilities: Capabilities,
        /** R1: "mobile" extends the gateway enum ["webui","cube"] → ["webui","cube","mobile"]. */
        val clientType: String,
        /**
         * Stable per-install device id (Task 3.10). REQUIRED by the gateway — keys the
         * per-device replay buffer across reconnects. The same value rides every connect
         * and the `stream.resume` frame.
         */
        val deviceId: String,
    ) : ClientMessage()

    @Serializable @SerialName("audio.start")
    data object AudioStart : ClientMessage()

    @Serializable @SerialName("audio.end")
    data object AudioEnd : ClientMessage()

    @Serializable @SerialName("text.input")
    data class TextInput(val text: String, val pendingId: String? = null) : ClientMessage()

    @Serializable @SerialName("tool.confirm")
    data class ToolConfirm(val toolCallId: String, val approved: Boolean) : ClientMessage()

    @Serializable @SerialName("session.end")
    data object SessionEnd : ClientMessage()

    @Serializable @SerialName("ping")
    data object Ping : ClientMessage()

    /** Explicit user-initiated interrupt (UI Stop / Escape). Hard abort: cycle + TTS + interruptable tasks. */
    @Serializable @SerialName("interrupt")
    data object Interrupt : ClientMessage()

    @Serializable @SerialName("user.preferences.patch")
    data class UserPreferencesPatch(
        val payload: PreferencesPatchPayload,
    ) : ClientMessage()

    // ── Sessions management ──
    // Query RPCs (list/search/delete/rename) were removed from the WS protocol in
    // Task 2.1 — they are now REST (SessionsHttpClient). Only lifecycle frames remain.

    @Serializable @SerialName("session.new")
    data class SessionNew(val requestId: String) : ClientMessage()

    /** Replaces the retired session.switch — activates an existing session.
     *  Fire-and-forget: no requestId. The gateway strips any requestId on the
     *  wire; web-sdk sends none. */
    @Serializable @SerialName("conversation.activate")
    data class ConversationActivate(
        val sessionId: String,
    ) : ClientMessage()

    /**
     * Resume handshake (Task 3.10) — sent after `session.configure` on a RECONNECT
     * to request replay of any frames the client missed since [lastSeq] within
     * [epoch]. Only fired when lastSeq>0 (a fresh connect has nothing to resume).
     * Carries the same stable [deviceId] as session.configure so the gateway can
     * key the per-device replay buffer.
     */
    @Serializable @SerialName("stream.resume")
    data class StreamResume(
        val epoch: Long,
        val lastSeq: Long,
        val deviceId: String,
    ) : ClientMessage()
}

@Serializable
data class Capabilities(val supports: List<String>)

/** Payload body for [ClientMessage.UserPreferencesPatch]. Both fields are optional so callers
 *  can patch only what changed. Null fields are omitted from JSON by [WireJson] (explicitNulls=false). */
@Serializable
data class PreferencesPatchPayload(
    val ttsEnabled: Boolean? = null,
    val channel: String? = null,
)
