package io.sentient.mobilesdk.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Unknown-timestamp sentinel for conversation feed items.
 *
 * `ts` is conceptually a non-negative wall-clock ms; the gateway always sends a valid
 * value. As defense-in-depth, a malformed frame with a missing or explicit-`null` `ts`
 * decodes to this sentinel (via WireJson.coerceInputValues + the `ts` default below)
 * instead of throwing JsonDecodingException and crashing the app on resume. Display
 * code formats this sentinel as "-" rather than an epoch date / "55 years ago".
 */
const val UNKNOWN_TS: Long = 0L

/**
 * Stable opaque entry id assigned by the gateway at commit time (live path) or
 * derived from position (REST history). Required on the wire (Task 3.10) — used
 * for de-dup of replayed committed entries (Slice 3) + as a mirror key (Slice 4).
 * Carries a default so a legacy frame without it still decodes (defense-in-depth,
 * same rationale as the [UNKNOWN_TS] default on `ts`).
 */
const val UNKNOWN_ENTRY_ID: String = ""

/**
 * Wire DTO for conversation feed items. Mirrors shared/protocol/src/conversation.ts.
 *
 * Discriminator key is "kind" (not "type") — the @JsonClassDiscriminator annotation
 * overrides the WireJson global classDiscriminator="type" for this hierarchy only.
 * This is the documented per-hierarchy override mechanism in kotlinx.serialization.
 *
 * `ts` carries the [UNKNOWN_TS] default so a missing key OR an explicit `ts:null`
 * (coerced by WireJson.coerceInputValues) degrades to the sentinel without throwing.
 * `entryId` carries the [UNKNOWN_ENTRY_ID] default for the same defense-in-depth.
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed class ConversationFeedItem {
    abstract val entryId: String
    abstract val ts: Long

    /** kind="user" — text or speech input from the user. */
    @Serializable @SerialName("user")
    data class User(
        override val entryId: String = UNKNOWN_ENTRY_ID,
        override val ts: Long = UNKNOWN_TS,
        val channel: String,
        val content: String,
        val pendingId: String? = null,
    ) : ConversationFeedItem()

    /** kind="trigger" — ambient trigger (sensor, timer, etc.). */
    @Serializable @SerialName("trigger")
    data class Trigger(
        override val entryId: String = UNKNOWN_ENTRY_ID,
        override val ts: Long = UNKNOWN_TS,
        val source: String,
        val summary: String,
    ) : ConversationFeedItem()

    /** kind="assistant" — model reply, optionally cut short. */
    @Serializable @SerialName("assistant")
    data class Assistant(
        override val entryId: String = UNKNOWN_ENTRY_ID,
        override val ts: Long = UNKNOWN_TS,
        val content: String,
        val cutoff: Cutoff? = null,
    ) : ConversationFeedItem()

    /** kind="tool" — completed tool invocation in the feed. */
    @Serializable @SerialName("tool")
    data class Tool(
        override val entryId: String = UNKNOWN_ENTRY_ID,
        override val ts: Long = UNKNOWN_TS,
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
