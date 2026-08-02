package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Gateway → client wire frames. Mirrors shared/protocol/src/messages.ts +
 * shared/protocol/src/sessions.ts gatewayMessageSchema.
 *
 * SerialName values are the exact wire "type" strings.
 * ServerMessage.Unknown is registered as the polymorphic default in WireJson
 * so any unrecognised frame decodes gracefully without throwing.
 */
@Serializable
sealed class ServerMessage {

    // ── Auth ──

    /**
     * Sent after a valid auth frame. Carries the authenticated user object.
     * Wire: { type:"auth.ok", user:{userId,displayName,isAdmin,avatarTint} }
     * — now the shape gatewayMessageSchema declares AND the one ws-auth-gate.ts
     * sends through it. (It used to be neither: the schema carried a
     * {sessionId, role} stub nobody sent, and the gate hand-serialized this
     * frame past validation.)
     */
    @Serializable @SerialName("auth.ok")
    data class AuthOk(val user: AuthUser) : ServerMessage()

    @Serializable @SerialName("auth.error")
    data class AuthError(val code: String, val message: String) : ServerMessage()

    // ── Session lifecycle ──

    @Serializable @SerialName("session.ready")
    data class SessionReady(
        val sessionId: String,
        val audioEncoding: String,
        val inputSampleRate: Int,
        val outputSampleRate: Int,
        /** Effect connector names the gateway has activated for this session. */
        val enabledEffects: List<String> = emptyList(),
        /** Playback tuning hints; absent in some gateway versions — fall back to defaults. */
        val playback: PlaybackConfig? = null,
    ) : ServerMessage()

    @Serializable @SerialName("session.expired")
    data class SessionExpired(val reason: String) : ServerMessage()

    // ── Stream resume ack (Task 3.10) ──

    /**
     * Gateway ack of a client `stream.resume`. Mirrors shared/protocol streamResumedSchema.
     * recovered=true  → the buffer held frames in [fromSeq, toSeq] and will replay them;
     *                   the ResumeCursor dedups the replays, so the SDK no-ops.
     * recovered=false → the epoch rolled over or the buffer expired; the SDK resets the
     *                   cursor and REST-refetches history (clean reconnect).
     * `epoch` is REQUIRED on this frame (the new/current epoch); fromSeq/toSeq are
     * present only when recovered=true.
     */
    @Serializable @SerialName("stream.resumed")
    data class StreamResumed(
        val recovered: Boolean,
        val epoch: Long,
        val fromSeq: Long? = null,
        val toSeq: Long? = null,
    ) : ServerMessage()

    @Serializable @SerialName("session.preferences.changed")
    data class SessionPreferencesChanged(val preferences: AudioPreferences) : ServerMessage()

    // ── Turn lifecycle (design §7 — replaces the retired cycle.* / message.* frames) ──
    // Every non-identity field carries a default: a malformed frame degrades to a
    // harmless value instead of throwing MissingFieldException, which would drop the
    // WHOLE frame at WsTransport decode (a dropped turn.audio.start = silent TTS).

    @Serializable @SerialName("turn.started")
    data class TurnStarted(
        val turnId: String,
        /** "user" | "background-completion". */
        val trigger: String = "",
    ) : ServerMessage()

    @Serializable @SerialName("turn.text.delta")
    data class TurnTextDelta(val turnId: String, val text: String = "") : ServerMessage()

    @Serializable @SerialName("turn.completed")
    data class TurnCompleted(val turnId: String) : ServerMessage()

    @Serializable @SerialName("turn.aborted")
    data class TurnAborted(
        val turnId: String,
        /** "interrupt" | "barge-in"; "" only for a malformed frame. */
        val cutoff: String = "",
    ) : ServerMessage()

    /** Tool-call lifecycle. Identity is [toolCallId]; [taskId] is present only for a
     *  BACKGROUND tool (delegateTask), which returns a task handle immediately. */
    @Serializable @SerialName("turn.tool.update")
    data class TurnToolUpdate(
        val turnId: String,
        val toolCallId: String,
        val toolName: String = "",
        /** "running" | "done" | "error". */
        val status: String = "",
        val taskId: String? = null,
        val argsPreview: String = "",
        val startedAtMs: Long = 0L,
        val endedAtMs: Long? = null,
    ) : ServerMessage()

    // ── Turn audio (design §7.2) ──
    // A NEW turnId NEVER cancels in-flight audio — it queues behind it. See AudioPipeline.

    @Serializable @SerialName("turn.audio.start")
    data class TurnAudioStart(
        val turnId: String,
        /** "opus" | "pcm". */
        val encoding: String = "",
        val sampleRate: Int = 0,
    ) : ServerMessage()

    @Serializable @SerialName("turn.audio.done")
    data class TurnAudioDone(val turnId: String) : ServerMessage()

    // ── Permission mediation (design §7.1) ──

    /** L3 `confirm` decision awaiting the user. [args] is an arbitrary tool-argument
     *  object — it is USER CONTENT and must never be logged. */
    @Serializable @SerialName("permission.request")
    data class PermissionRequest(
        val requestId: String,
        val toolCallId: String,
        val toolName: String = "",
        val args: JsonObject = JsonObject(emptyMap()),
        val description: String = "",
        val expiresAtMs: Long = 0L,
    ) : ServerMessage()

    /** The gateway resolved the request first (user answered elsewhere, or the
     *  2-minute fail-closed timeout fired) — the client dismisses its dialog. */
    @Serializable @SerialName("permission.resolved")
    data class PermissionResolved(
        val requestId: String,
        /** "allowed" | "denied" | "timeout". */
        val outcome: String = "",
    ) : ServerMessage()

    // ── Delegation progress (design §5.4 / §7) ──

    @Serializable @SerialName("delegation.progress")
    data class DelegationProgress(
        val taskId: String,
        val turnId: String = "",
        val agent: String = "",
        /** "running" | "done" | "error". */
        val status: String = "",
        val note: String? = null,
    ) : ServerMessage()

    // ── Connector frames ──

    @Serializable @SerialName("connector.transcript.final")
    data class ConnectorTranscriptFinal(
        val text: String,
        val language: String? = null,
    ) : ServerMessage()

    // ── Conversation feed ──

    @Serializable @SerialName("conversation.snapshot")
    data class ConversationSnapshot(
        val items: List<ConversationFeedItem> = emptyList(),
    ) : ServerMessage()

    // `turnId` is the gateway-owned join key between this committed entry and its live
    // streaming bubble (carried on the FRAME; the item strips it). Read it straight
    // through — the client never invents/derives it. Null for user-echo / out-of-band
    // entries and for REST history (no live turn).
    @Serializable @SerialName("conversation.entry")
    data class ConversationEntry(
        val item: ConversationFeedItem,
        val turnId: String? = null,
    ) : ServerMessage()

    // ── Playback control ──

    /** Flush playback. Emitted ONLY for a user action — barge-in (mic onset) or
     *  interrupt (UI Stop). Never for a new turn. */
    @Serializable @SerialName("playback.stop")
    data class PlaybackStop(
        val turnId: String = "",
        /** "barge-in" | "interrupt". */
        val reason: String = "",
    ) : ServerMessage()

    // ── Shared utility ──

    @Serializable @SerialName("error")
    data class Error(val code: String, val message: String) : ServerMessage()

    @Serializable @SerialName("pong")
    data object Pong : ServerMessage()

    // ── Sessions management ──
    // Note: sessions.list.result / sessions.search.result / sessions.delete.result /
    // sessions.rename.result were REMOVED from the protocol in Task 2.1.
    // Those query RPCs are now REST; only lifecycle broadcasts remain here.

    /** Broadcast when a session is deleted (e.g. by another client). */
    @Serializable @SerialName("sessions.deleted")
    data class SessionsDeleted(val sessionId: String) : ServerMessage()

    /** Broadcast when a session is renamed (e.g. by another client). */
    @Serializable @SerialName("sessions.renamed")
    data class SessionsRenamed(val sessionId: String, val title: String) : ServerMessage()

    @Serializable @SerialName("session.created")
    data class SessionCreated(
        val sessionId: String,
        val title: String? = null,
        val ts: Long,
    ) : ServerMessage()

    /**
     * "You have no session yet — hold this key."
     *
     * A connection that presents no session id is a DRAFT: no row, no id,
     * nothing in the session list until its first message mints one. [draftKey]
     * is what the client holds meanwhile — it takes the anchor's place so the
     * outbound queue can drain (SendMessageUseCase gates on a non-null attached
     * id), it is re-presented as `session.configure.conversationId` so a
     * reconnect stays on the same draft, and the gateway spends it as the mint
     * key, which is what makes a retry after a lost `session.created` resolve to
     * the session already minted instead of forking a second one.
     */
    @Serializable @SerialName("session.draft")
    data class SessionDraft(
        val requestId: String? = null,
        val draftKey: String,
        val ts: Long,
    ) : ServerMessage()

    /** The gateway titled this session. Distinct from [SessionsRenamed], which
     *  echoes a rename the client itself asked for; [provenance] is
     *  "generated" or "user". */
    @Serializable @SerialName("session.title")
    data class SessionTitle(
        val sessionId: String,
        val title: String,
        val provenance: String,
    ) : ServerMessage()

    @Serializable @SerialName("session.switched")
    data class SessionSwitched(
        val sessionId: String,
        val title: String? = null,
        val ts: Long,
    ) : ServerMessage()

    /** Error frame for lifecycle operations (e.g. forbidden on re-establish switch).
     *  requestId is optional — conversation.activate errors have no requestId. */
    @Serializable @SerialName("sessions.error")
    data class SessionsError(
        val requestId: String? = null,
        val code: String,
        val message: String,
    ) : ServerMessage()

    /**
     * Forward-compat catch-all. Decodes any unrecognised gateway frame without throwing.
     * Registered as the polymorphic default deserializer in WireJson.
     */
    @Serializable
    data object Unknown : ServerMessage()
}

// ── Supporting DTOs ──

/** Authenticated user identity — matches ws-auth-gate.ts send shape. */
@Serializable
data class AuthUser(
    val userId: String,
    val displayName: String,
    val isAdmin: Boolean = false,
    val avatarTint: String = "",
)

/** Client-facing session/chat-thread row. Mirrors sessions.ts sessionRowSchema.
 *  Defaults provided for fields absent in REST list/search responses so the same
 *  DTO works for both WS result frames and REST JSON. */
@Serializable
data class SessionRow(
    val sessionId: String,
    /** rootId ties a branch to the root chain; nullable for resilience against older gateway versions. */
    val rootId: String? = null,
    val title: String = "",
    val startedAt: Long = 0L,
    val lastActiveAt: Long = 0L,
    val messageCount: Int = 0,
    val isActive: Boolean = false,
)

/** Playback tuning hints from session.ready (optional field). */
@Serializable
data class PlaybackConfig(
    val minEagerEndMs: Int,
    val preemptFadeoutMs: Int,
)
