package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Wire DTO for conversation feed items. Mirrors shared/protocol/src/conversation.ts.
 *
 * Discriminator key is "kind" (not "type") — the @JsonClassDiscriminator annotation
 * overrides the WireJson global classDiscriminator="type" for this hierarchy only.
 * This is the documented per-hierarchy override mechanism in kotlinx.serialization.
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ConversationFeedItem {
    abstract val ts: Long

    /** kind="user" — text or speech input from the user. */
    @Serializable @SerialName("user")
    data class User(
        override val ts: Long,
        val channel: String,
        val content: String,
    ) : ConversationFeedItem()

    /** kind="trigger" — ambient trigger (sensor, timer, etc.). */
    @Serializable @SerialName("trigger")
    data class Trigger(
        override val ts: Long,
        val source: String,
        val summary: String,
    ) : ConversationFeedItem()

    /** kind="assistant" — model reply, optionally cut short. */
    @Serializable @SerialName("assistant")
    data class Assistant(
        override val ts: Long,
        val content: String,
        val cutoff: Cutoff? = null,
    ) : ConversationFeedItem()

    /** kind="tool" — completed tool invocation in the feed. */
    @Serializable @SerialName("tool")
    data class Tool(
        override val ts: Long,
        val toolName: String,
        val status: String,
        val summary: String,
    ) : ConversationFeedItem()
}

/**
 * Why an assistant reply was cut short.
 * kind="barge-in": user spoke mid-TTS.
 * kind="interrupt": hard abort via UI button; cancelledTaskIds identifies affected tasks.
 */
@Serializable
data class Cutoff(
    val kind: String,
    val cancelledTaskIds: List<String> = emptyList(),
)
