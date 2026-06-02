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
    ) : ClientMessage()

    @Serializable @SerialName("audio.start")
    data object AudioStart : ClientMessage()

    @Serializable @SerialName("audio.end")
    data object AudioEnd : ClientMessage()

    @Serializable @SerialName("text.input")
    data class TextInput(val text: String) : ClientMessage()

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
        val ttsEnabled: Boolean? = null,
        val channel: String? = null,
    ) : ClientMessage()

    // ── Sessions management (mirrors sessions.ts) ──

    @Serializable @SerialName("sessions.list")
    data class SessionsList(
        val requestId: String,
        val limit: Int,
        val offset: Int,
    ) : ClientMessage()

    @Serializable @SerialName("sessions.search")
    data class SessionsSearch(
        val requestId: String,
        val q: String,
        val limit: Int,
    ) : ClientMessage()

    @Serializable @SerialName("sessions.delete")
    data class SessionsDelete(
        val requestId: String,
        val sessionId: String,
    ) : ClientMessage()

    @Serializable @SerialName("sessions.rename")
    data class SessionsRename(
        val requestId: String,
        val sessionId: String,
        val title: String,
    ) : ClientMessage()

    @Serializable @SerialName("session.new")
    data class SessionNew(val requestId: String) : ClientMessage()

    @Serializable @SerialName("session.switch")
    data class SessionSwitch(
        val requestId: String,
        val sessionId: String,
    ) : ClientMessage()
}

@Serializable
data class Capabilities(val supports: List<String>)
