package io.sentient.mobilesdk.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.modules.SerializersModule

/**
 * Wire JSON: lenient on unknown server fields, discriminator key is "type" (matches gateway).
 * ServerMessage.Unknown is registered as the polymorphic default deserializer so any
 * unrecognised frame decodes gracefully without throwing.
 *
 * coerceInputValues=true is graceful-degradation defense-in-depth: a non-nullable
 * property that carries a default coerces an explicit `null` literal in the input to
 * that default instead of throwing. This is how a malformed conversation-feed frame
 * with `ts:null` decodes to the UNKNOWN_TS sentinel (ConversationFeedItem.ts default)
 * rather than crashing WsTransport decode. A missing key already falls back to the
 * default natively; this covers the explicit-null case too.
 */
object WireJson {
    val instance: Json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
        coerceInputValues = true
        serializersModule = SerializersModule {
            polymorphicDefaultDeserializer(ServerMessage::class) { ServerMessage.Unknown.serializer() }
        }
    }

    /**
     * Strict, Result-returning decode for the pump boundary. Returns
     * [Result.failure] on hard JSON parse errors (malformed syntax). A
     * syntactically-valid-but-unknown frame still decodes to
     * [ServerMessage.Unknown] via the lenient [instance] config — only genuine
     * parse failures become failures here. Does NOT change the existing lenient
     * decode path used elsewhere.
     */
    fun decodeServerMessageResult(raw: String): Result<ServerMessage> =
        runCatching { instance.decodeFromString(ServerMessage.serializer(), raw) }

    /**
     * Peel the gateway's resume stamps (`seq` / `epoch`) off a raw JSON frame
     * WITHOUT adding them to every [ServerMessage] variant. Mirrors web-sdk's
     * `typeof msg.seq === "number" ? msg.seq : 0` read on the parsed object.
     *
     * @return ([seq], [epoch]) — seq is 0 when absent (non-seq frame); epoch is
     *   null when absent. Any parse hiccup degrades to (0, null) — never throws.
     */
    fun peelSeqEpoch(raw: String): Pair<Long, Long?> = runCatching {
        val obj = instance.parseToJsonElement(raw).jsonObject
        val seq = obj["seq"]?.jsonPrimitive?.longOrNull ?: 0L
        val epoch = obj["epoch"]?.jsonPrimitive?.longOrNull
        seq to epoch
    }.getOrDefault(0L to null)
}
