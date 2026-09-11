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
         * per-device replay buffer across reconnects. The same value rides every connect.
         */
        val deviceId: String,
        /**
         * Resume request carried INSIDE configure on a RECONNECT (Slice 3 hardening).
         * Null on a fresh connect. The gateway reads it synchronously off this frame —
         * there is no separate stream.resume frame, so no send-ordering race.
         * Omitted from the wire when null ([WireJson] explicitNulls=false).
         */
        val resume: ResumeParams? = null,
        /**
         * The ACP conversation uuid the client is currently displaying, sent on a
         * RECONNECT so the gateway can re-anchor Hermes to that conversation before
         * the next user.message arrives (Task 3 — conversation continuity).
         * Null on a first connect (nothing anchored yet).
         * Omitted from the wire when null ([WireJson] explicitNulls=false) — the
         * gateway schema is `conversationId: z.string().min(1).optional()` and
         * rejects an explicit null, so wire-omit is required.
         */
        val conversationId: String? = null,
        /**
         * Chat-surface id (one app instance). Mobile sends `surfaceId = deviceId`
         * (1 app = 1 surface) — 2026-06-14 design §1. Omitted from the wire when
         * null (WireJson explicitNulls=false); the gateway schema is
         * `surfaceId: z.string().min(1).optional()` and rejects an explicit null.
         */
        val surfaceId: String? = null,
    ) : ClientMessage()

    /** Starts an identified uplink capture. New mobile clients always send an opaque
     * [captureId] and explicit `manual` or `semantic` [turnMode]. */
    @Serializable @SerialName("audio.start")
    data class AudioStart(
        val captureId: String,
        val turnMode: String,
    ) : ClientMessage()

    @Serializable @SerialName("audio.end")
    data class AudioEnd(val captureId: String) : ClientMessage()

    @Serializable @SerialName("audio.cancel")
    data class AudioCancel(val captureId: String) : ClientMessage()

    @Serializable @SerialName("text.input")
    data class TextInput(val text: String, val pendingId: String? = null) : ClientMessage()

    /** User's Allow / Deny for an open [ServerMessage.PermissionRequest] (design §7.1).
     *  Replaces the retired `tool.confirm`. Keyed by requestId, NOT toolCallId — the
     *  PDP owns the request lifetime, and one tool call can be re-prompted. */
    @Serializable @SerialName("permission.response")
    data class PermissionResponse(val requestId: String, val approved: Boolean) : ClientMessage()

    @Serializable @SerialName("ping")
    data object Ping : ClientMessage()

    /** Explicit user-initiated interrupt (UI Stop / Escape). Hard abort of the TURN: turn + TTS.
     *  It does NOT cancel background work — a delegated task outlives the turn that spawned it
     *  and its completion still arrives later, so never present Stop as cancelling it. */
    @Serializable @SerialName("interrupt")
    data object Interrupt : ClientMessage()

    @Serializable @SerialName("user.preferences.patch")
    data class UserPreferencesPatch(
        val payload: PreferencesPatchPayload,
    ) : ClientMessage()

    // ── Sessions management ──
    // Query RPCs (list/search/delete/rename) were removed from the WS protocol in
    // Task 2.1 — they are now REST (SessionsHttpClient). Only lifecycle frames remain.

    /**
     * Ask for a new chat. [intent] separates a person pressing "+" ("explicit")
     * from the app simply launching with no route id ("implicit") — this SDK
     * fires session.new on EVERY launch, twice per launch, and the gateway
     * answering both the same way would abandon the bound conversation on every
     * app open. Defaulted to "implicit" on the gateway, so omitting it is the
     * safe half.
     */
    @Serializable @SerialName("session.new")
    data class SessionNew(val requestId: String, val intent: String? = null) : ClientMessage()

    /** Replaces the retired session.switch — activates an existing session.
     *  Fire-and-forget: no requestId. The gateway strips any requestId on the
     *  wire; web-sdk sends none. */
    @Serializable @SerialName("conversation.activate")
    data class ConversationActivate(
        val sessionId: String,
    ) : ClientMessage()
}

@Serializable
data class Capabilities(val supports: List<String>)

/**
 * Resume request folded into [ClientMessage.SessionConfigure.resume] on a RECONNECT
 * (Slice 3 hardening). Requests replay of any frames missed since [lastSeq] within
 * [epoch]. Built only when lastSeq>0 (a fresh connect has nothing to resume).
 */
@Serializable
data class ResumeParams(
    val epoch: Long,
    val lastSeq: Long,
)

/** Payload body for [ClientMessage.UserPreferencesPatch]. Both fields are optional so callers
 *  can patch only what changed. Null fields are omitted from JSON by [WireJson] (explicitNulls=false). */
@Serializable
data class PreferencesPatchPayload(
    val ttsEnabled: Boolean? = null,
    val channel: String? = null,
)
