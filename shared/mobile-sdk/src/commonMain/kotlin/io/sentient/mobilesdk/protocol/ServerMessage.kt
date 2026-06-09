package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
     * (matches ws-auth-gate.ts actual send shape, not the gatewayMessageSchema stub).
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

    @Serializable @SerialName("session.preferences.changed")
    data class SessionPreferencesChanged(val preferences: AudioPreferences) : ServerMessage()

    // ── Cognitive cycle lifecycle ──

    @Serializable @SerialName("cycle.started")
    data class CycleStarted(
        val cycleId: String,
        val triggerKind: String? = null,
        val triggerSource: String? = null,
    ) : ServerMessage()

    @Serializable @SerialName("cycle.aborted")
    data class CycleAborted(val cycleId: String, val reason: String? = null) : ServerMessage()

    @Serializable @SerialName("cycle.completed")
    data class CycleCompleted(val cycleId: String) : ServerMessage()

    // ── Connector frames ──

    @Serializable @SerialName("connector.transcript.final")
    data class ConnectorTranscriptFinal(
        val text: String,
        val language: String? = null,
    ) : ServerMessage()

    @Serializable @SerialName("connector.audio.start")
    data class ConnectorAudioStart(
        val cycleId: String? = null,
        val taskId: String? = null,
        val encoding: String? = null,
        val sampleRate: Int? = null,
    ) : ServerMessage()

    @Serializable @SerialName("connector.audio.done")
    data class ConnectorAudioDone(
        val cycleId: String? = null,
        val taskId: String? = null,
    ) : ServerMessage()

    // ── Streaming assistant content ──

    @Serializable @SerialName("message.delta")
    data class MessageDelta(val cycleId: String? = null, val delta: String? = null) : ServerMessage()

    @Serializable @SerialName("message.done")
    data class MessageDone(val cycleId: String? = null) : ServerMessage()

    // ── Conversation feed ──

    @Serializable @SerialName("conversation.snapshot")
    data class ConversationSnapshot(
        val items: List<ConversationFeedItem> = emptyList(),
    ) : ServerMessage()

    @Serializable @SerialName("conversation.entry")
    data class ConversationEntry(val item: ConversationFeedItem) : ServerMessage()

    // ── Task sidebar ──

    @Serializable @SerialName("task.update")
    data class TaskUpdate(
        val taskId: String,
        val toolName: String,
        val cycleId: String,
        val status: String,
        val argsPreview: String,
        val startedAtMs: Long,
        val endedAtMs: Long? = null,
    ) : ServerMessage()

    // ── Playback control ──

    @Serializable @SerialName("playback.stop")
    data class PlaybackStop(
        val cycleId: String? = null,
        val reason: String? = null,
    ) : ServerMessage()

    // ── Shared utility ──

    @Serializable @SerialName("error")
    data class Error(val code: String, val message: String) : ServerMessage()

    @Serializable @SerialName("pong")
    data object Pong : ServerMessage()

    // ── Sessions management (mirrors sessions.ts result/event types) ──

    @Serializable @SerialName("sessions.list.result")
    data class SessionsListResult(
        val requestId: String,
        val items: List<SessionRow>,
        val total: Int,
        val hasMore: Boolean,
    ) : ServerMessage()

    @Serializable @SerialName("sessions.search.result")
    data class SessionsSearchResult(
        val requestId: String,
        val items: List<SessionRow>,
    ) : ServerMessage()

    @Serializable @SerialName("sessions.delete.result")
    data class SessionsDeleteResult(
        val requestId: String,
        val sessionId: String,
    ) : ServerMessage()

    @Serializable @SerialName("sessions.deleted")
    data class SessionsDeleted(val sessionId: String) : ServerMessage()

    @Serializable @SerialName("sessions.rename.result")
    data class SessionsRenameResult(
        val requestId: String,
        val sessionId: String,
        val title: String,
    ) : ServerMessage()

    @Serializable @SerialName("sessions.renamed")
    data class SessionsRenamed(val sessionId: String, val title: String) : ServerMessage()

    @Serializable @SerialName("session.created")
    data class SessionCreated(
        val sessionId: String,
        val title: String? = null,
        val ts: Long,
    ) : ServerMessage()

    @Serializable @SerialName("session.switched")
    data class SessionSwitched(
        val sessionId: String,
        val title: String? = null,
        val ts: Long,
    ) : ServerMessage()

    @Serializable @SerialName("sessions.error")
    data class SessionsError(
        val requestId: String,
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

/** Client-facing session/chat-thread row. Mirrors sessions.ts sessionRowSchema. */
@Serializable
data class SessionRow(
    val sessionId: String,
    /** rootId ties a branch to the root chain; nullable for resilience against older gateway versions. */
    val rootId: String? = null,
    val title: String,
    val startedAt: Long,
    val lastActiveAt: Long,
    val messageCount: Int,
    val isActive: Boolean,
)

/** Playback tuning hints from session.ready (optional field). */
@Serializable
data class PlaybackConfig(
    val minEagerEndMs: Int,
    val preemptFadeoutMs: Int,
)
