// ---------------------------------------------------------------------------
// CommandBinding — this app instance's ATTACHMENT to a session, and the stamp
// every outbound command carries (gateway spec §3.7).
//
// WHY THE CLIENT HAS TO CARRY IT. `text.input`, `interrupt`, the permission
// answer and the audio control frames used to name nothing: the gateway applied
// each to whatever session the socket was on when the bytes landed. With session
// switching that races — a message sent into one conversation and a
// `conversation.activate` onto another are two frames in flight, and the loser
// lands in the wrong place. The stamp lets the gateway tell them apart and
// refuse the stale one rather than apply it.
//
// STAMPED AT ONE SEAM. [stamp] is applied in `WsTransport.send`, the single
// place a control frame is encoded, so no call site has to remember and no
// connector can forget. That mirrors the gateway's own single choke point.
//
// STAMPED AS JSON, NOT AS FIELDS ON EVERY FRAME. [ClientMessage] is a sealed
// hierarchy with no common supertype to copy through, so adding two properties
// would mean adding them to five data classes AND threading the binding to
// every construction site — the opposite of one seam.
//
// FORGETTING IS AS LOAD-BEARING AS REMEMBERING. An attachment does not survive
// its socket, and a DRAFT has none at all. A stamp that outlived either would be
// refused as stale on the very frame that mints the next session — the one frame
// that must always get through.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.protocol

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** The pair the gateway announced on [ServerMessage.SessionAttached]. */
data class CommandBinding(val sessionId: String, val generation: Int)

/**
 * Frames that carry the §3.7 binding — exactly the gateway's own set (see
 * `command-mediator.ts`).
 *
 * `session.configure`, `session.new` and `conversation.activate` are absent on
 * purpose: they are how a connection LEAVES a session, so binding them to the
 * one being left would make switching impossible. `auth`, `ping` and
 * `user.preferences.patch` act on no session at all.
 */
private val COMMAND_TYPES = setOf(
    "text.input",
    "interrupt",
    "permission.response",
    "audio.start",
    "audio.end",
)

private const val TYPE_KEY = "type"
private const val SESSION_ID_KEY = "sessionId"
private const val GENERATION_KEY = "attachmentGeneration"

/**
 * [encoded] with the binding merged in, when it is a command AND [binding] is
 * non-null. Anything else is returned untouched, which is what keeps a draft's
 * first `text.input` sendable.
 */
fun stampCommandBinding(encoded: JsonElement, binding: CommandBinding?): JsonElement {
    if (binding == null) return encoded
    val obj = encoded as? JsonObject ?: return encoded
    val type = (obj[TYPE_KEY] as? JsonPrimitive)?.contentOrNullIfNotString() ?: return encoded
    if (type !in COMMAND_TYPES) return encoded
    return JsonObject(
        obj + mapOf(
            SESSION_ID_KEY to JsonPrimitive(binding.sessionId),
            GENERATION_KEY to JsonPrimitive(binding.generation),
        ),
    )
}

/** The primitive's content when it is a JSON string, else null — a numeric or
 *  boolean `type` is not a frame type and must not be matched by its digits. */
private fun JsonPrimitive.contentOrNullIfNotString(): String? = if (isString) content else null

/** Convenience for callers holding the frame rather than its JSON. */
fun stampCommandBinding(msg: ClientMessage, binding: CommandBinding?): JsonElement =
    stampCommandBinding(
        WireJson.instance.encodeToJsonElement(ClientMessage.serializer(), msg).jsonObject,
        binding,
    )
