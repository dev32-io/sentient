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

    /**
     * kind="assistant" — model reply, optionally cut short.
     *
     * `turnId` is the gateway-owned join key to the live streaming bubble. The
     * wire item strips it (it rides the conversation.entry FRAME); the history
     * connector re-attaches it here from the frame on a LIVE append so the
     * committed twin can be suppressed by exact id while its bubble reveals.
     * Null for REST history / snapshot entries (no live turn to join).
     *
     * `replyId` now arrives ON THE WIRE — the gateway stamps it on the item
     * itself, since one reply is one `conversation.entry` whose `entryId` IS
     * its `replyId`. The frame also carries it (see [ServerMessage.ConversationEntry]);
     * the history connector's re-attach is only an OVERRIDE for a frame from an
     * older gateway that stamped the frame but not yet the item.
     */
    @Serializable @SerialName("assistant")
    data class Assistant(
        override val entryId: String = UNKNOWN_ENTRY_ID,
        override val ts: Long = UNKNOWN_TS,
        val content: String,
        val cutoff: Cutoff? = null,
        val turnId: String? = null,
        /** Groups consecutive assistant rows into the one bubble they were. */
        val replyId: String? = null,
    ) : ConversationFeedItem()

    // THERE IS NO kind="tool" ANY MORE. A tool call is the MODEL's record of
    // what it did, not a user-facing artifact — the gateway keeps it in the
    // store for the model projection and never puts it on the feed. Live tool
    // activity is the composer task strip (TaskListConnector / tasklist.state).
    //
    // Which is exactly why [Unknown] exists: an OLD gateway still sends
    // `kind:"tool"`, and OTA means a staged rollout puts new phones in front of
    // old gateways routinely. Without a default the unknown discriminator
    // throws and takes the WHOLE `conversation.snapshot` frame with it — a
    // blank chat instead of a degraded one.

    /**
     * Forward/backward-compat catch-all. Decodes any unrecognised feed item —
     * a retired `kind` from an older gateway, a newer one from a gateway ahead
     * of this build — without throwing. Registered as the polymorphic default
     * deserializer in [WireJson], mirroring [ServerMessage.Unknown]. Renders as
     * nothing (see `StateDeriver.committedMessage`): one missing row beats a
     * missing conversation.
     */
    @Serializable @SerialName("unknown")
    data object Unknown : ConversationFeedItem() {
        override val entryId: String get() = UNKNOWN_ENTRY_ID
        override val ts: Long get() = UNKNOWN_TS
    }
}

/**
 * Why an assistant reply was cut short.
 * kind="barge-in": user spoke mid-TTS.
 * kind="interrupt": hard abort of the TURN via UI button. cancelledTaskIds is always empty —
 * nothing cancels a background task, so never render it as tasks killed by the Stop.
 */
@Serializable
data class Cutoff(
    val kind: String,
    val cancelledTaskIds: List<String> = emptyList(),
)
